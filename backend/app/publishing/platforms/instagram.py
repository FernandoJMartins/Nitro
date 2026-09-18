"""InstagramAdapter — implementação REAL de automação do Instagram.

Mecanismo de transporte: biblioteca `instagrapi` (automação não-oficial da
interface/serviços do Instagram, com login e sessão reais). NÃO usa a Graph
API / Content Publishing API oficial da Meta — a automação opera a mesma
superfície que o aplicativo usa, com uma conta real e suas credenciais.

Design:

- Sessão persistida: `Account.session_data` guarda um JSON com os settings da
  sessão do instagrapi (cookies/tokens). `login()` devolve o blob novo para o
  núcleo persistir; `check_session()` reidrata o blob e valida com uma chamada
  real de rede (`get_timeline_feed`).
- Proxy por conta: o adapter recebe o dict de proxy do núcleo no construtor
  (uma instância por conta, nunca compartilhada) e converte em
  `socks5://[user:pass@]host:porta` para o instagrapi.
- Erros são mapeados para `AdapterError` (recuperável, vira retry) e
  `SessionExpiredError` (reautenticação manual necessária).
- O transporte é injetável via `client_factory` para testes offline — os
  testes unitários não tocam a rede.

Nota operacional: contas com verificação em duas etapas ou desafios
(ChallengeRequired) precisam ser resolvidas manualmente pelo operador; o
adapter sinaliza isso via SessionExpiredError com a causa específica, em vez
de tentar burlar o desafio.
"""
from __future__ import annotations

import json
import logging
import math
import os
import re
import tempfile
from pathlib import Path
from urllib.parse import urlparse

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

from ...config import settings
from ...services.video import _EMOJI_RE, _render_emoji_seg

from .base import (
    AdapterError,
    PlatformAdapter,
    PublishContext,
    PublishResult,
    SessionExpiredError,
    ThrottledError,
    build_proxy_url,
)

logger = logging.getLogger("nitro.publishing.instagram")

# Nomes de exceção do instagrapi que significam "a sessão/credencial não serve mais
# ou exige ação manual" (comparados por nome para não depender da importação da lib).
_SESSION_EXPIRED_NAMES = {
    "BadPassword",
    "ChallengeRequired",
    "SelectContactPointRecoveryForm",
    "RecaptchaChallengeForm",
    "TwoFactorRequired",
    "LoginRequired",
    "UserNotFound",
}

# Nomes de exceção do instagrapi que significam "o Instagram está limitando as
# tentativas AGORA" (rate limit/429). Diferente de sessão expirada: a conta pode
# estar boa — o IP usado (proxy ou o do próprio servidor) é que está marcado.
_THROTTLE_NAMES = {
    "ClientThrottledError",
    "PleaseWaitFewMinutes",
}

# Versões de app conhecidas do fork para o LOGIN LEGADO. O login legado é o
# endpoint que NÃO sofre o 429 que atinge o CAA/bloks; o Instagram, porém, vem
# rejeitando versões específicas com "needs_upgrade" — então o adapter roda o
# legado em cada versão antes de desistir. A padrão vem primeiro; a lista é lida
# do config do instagrapi quando a lib está instalada. Quando o operador define
# INSTAGRAM_APP_VERSION (+ _CODE), só a versão dele é tentada (ver
# _operator_app_version) — as demais são mais antigas e só queimam tentativas do IP.
_LEGACY_APP_VERSIONS_FALLBACK = [
    "446.0.0.49.77",
    "428.0.0.47.67",
    "385.0.0.47.74",
    "364.0.0.35.86",
]


def _operator_app_version(config_module) -> str | None:
    """Versão de app configurada pelo operador (INSTAGRAM_APP_VERSION +
    INSTAGRAM_APP_VERSION_CODE), registrada no APP_SETTINGS do fork. O
    `override_app_version` do fork NÃO serve para isso: o set_app desfaz a
    versão dada e volta ao default — registrar a entrada no APP_SETTINGS é o
    que faz o set_device montar o User-Agent com a versão desejada.

    O bloks_versioning_id reaproveita o do default do fork (o mais novo
    conhecido): o login legado não usa bloks, mas o header X-Bloks-Version-Id
    é enviado em toda requisição privada e um valor plausível é melhor do que
    o header ausente.
    """
    versao = (settings.instagram_app_version or "").strip()
    if not versao:
        return None
    code = (settings.instagram_app_version_code or "").strip()
    if not code:
        logger.warning(
            "INSTAGRAM_APP_VERSION definida sem INSTAGRAM_APP_VERSION_CODE — "
            "versão configurada ignorada (usando as versões do fork)"
        )
        return None
    bloks = config_module.APP_SETTINGS.get(config_module.DEFAULT_APP_VERSION, {}).get(
        "bloks_versioning_id", ""
    )
    config_module.APP_SETTINGS[versao] = {
        "app_version": versao,
        "version_code": code,
        "bloks_versioning_id": bloks,
    }
    return versao


def _app_versions_do_fork() -> list[str]:
    try:
        from instagrapi import config  # noqa: PLC0415
    except ImportError:  # pragma: no cover - ambiente sem instagrapi
        return list(_LEGACY_APP_VERSIONS_FALLBACK)
    operador = _operator_app_version(config)
    if operador:
        # só a versão do operador: as demais são mais antigas e o Instagram as
        # rejeita em bloco quando sobe o mínimo — tentá-las só queima o limite
        # de tentativas do IP (429) antes de chegar ao CAA.
        return [operador]
    default = config.DEFAULT_APP_VERSION
    return [default] + [v for v in config.APP_SETTINGS if v != default]


def _default_client_factory(proxy_url: str | None):
    """Cria um Client instagrapi novo para ESTA conta. Importação tardia: o resto
    do sistema (e os testes) funciona sem a biblioteca instalada."""
    try:
        from instagrapi import Client  # noqa: PLC0415
        from instagrapi.exceptions import (  # noqa: PLC0415
            ChallengeError,
            ClientError,
            ClientThrottledError,
            TwoFactorRequired,
        )
    except ImportError as exc:  # pragma: no cover - depende do ambiente
        raise AdapterError(
            "biblioteca 'instagrapi' não instalada no backend (adicione em requirements.txt)"
        ) from exc

    class _ThrottleAwareClient(Client):
        """Client que NÃO engole o 429 do login CAA no fallback do legado.

        O fork do instagrapi (fixado em requirements.txt) trata o throttle do
        endpoint bloks/CAA dentro do `login_legacy` como "fallback falhou" —
        só um warning no log — e re-levanta o erro do login legado (ex.: "Your
        version of Instagram is out of date"), escondendo a causa real do
        operador. Este override é o `_try_caa_login` do fork com DUAS
        diferenças: ClientThrottledError é propagado para o adapter devolver a
        mensagem correta, e o atributo `skip_caa_login` permite rodar só o
        login legado (sem tocar no bloks). No fluxo principal (CAA via
        `login`) o fork 3.x propaga o throttle sozinho — este override só
        protege o plano B legado.
        """

        # Quando True, _try_caa_login desiste SEM tocar no endpoint bloks/CAA —
        # usado pelo adapter para testar versões de app no login legado antes
        # de queimar o limite de tentativas do CAA (que responde 429).
        skip_caa_login = False

        def __init__(self, *args, **kwargs):
            super().__init__(*args, **kwargs)
            # Sem TTY no backend, o handler padrão do fork chama input() e
            # estoura (EOFError) no desafio. Devolver None faz o fork levantar
            # ChallengeRequired — que o adapter converte no pedido de código
            # para o operador.
            self.challenge_code_handler = lambda username, choice=None: None

        def _try_caa_login(self, exc: Exception, verification_code: str = "") -> bool:
            if self.skip_caa_login:
                return False
            try:
                outcome = self.bloks_caa_login(verification_code=verification_code)
            except ClientThrottledError:
                raise
            except (ChallengeError, TwoFactorRequired):
                raise
            except ClientError as caa_exc:
                self.logger.warning("CAA login fallback failed: %s", caa_exc)
                return False
            if outcome.get("logged_in"):
                return True
            context = str(outcome.get("two_step_verification_context") or "")
            if not context:
                return False
            if not verification_code.strip():
                raise TwoFactorRequired(
                    f"{exc} (Instagram returned a Bloks two-factor context from the CAA login flow; "
                    "provide verification_code for login)",
                    response=getattr(exc, "response", None),
                ) from exc
            return self._login_with_bloks_two_factor(
                verification_code,
                {"two_step_verification_context": context},
                exc,
            )

        # ---- desafio profile-code (código por e-mail): extração TOLERANTE ----

        def bloks_caa_resolve_two_step_verification(
            self, send_result: dict, verification_code: str = "", domain: str | None = None
        ) -> dict:
            """Resolve o desafio profile-code com extração de contexto mais
            tolerante que a do fork.

            O Instagram mudou o formato da tela de código: a extração exata do
            fork (app id seguido imediatamente do mapa f4i) não acha mais o
            context_data do code_entry — resultado: "missing code_entry
            context_data". Esta versão tenta a extração do fork e, se falhar,
            procura o token em qualquer mapa f4i da mesma string do app id,
            antes ou depois dele. Em último caso, dumpa as respostas para
            diagnóstico e devolve o mesmo motivo do fork.
            """
            from instagrapi.mixins.bloks import (  # noqa: PLC0415
                AP_2SV_CODE_ENTRY,
                AP_2SV_CODE_ENTRY_ASYNC,
                AP_2SV_ENTRYPOINT,
            )
            from instagrapi.mixins.challenge import ChallengeChoice  # noqa: PLC0415

            entry_context = self.bloks_extract_context_data(send_result, AP_2SV_ENTRYPOINT)
            if not entry_context:
                return {"logged_in": False, "reason": "missing entrypoint context_data"}
            entry_result = self.bloks_ap_two_step_verification_entrypoint(entry_context, domain=domain)

            code_context = self.bloks_extract_context_data(entry_result, AP_2SV_CODE_ENTRY)
            if not code_context:
                code_context = self._extract_context_tolerante(entry_result)
            if not code_context:
                self._dump_caa_debug(send_result, entry_result)
                return {"logged_in": False, "reason": "missing code_entry context_data"}

            code_result = self.bloks_ap_two_step_verification_code_entry(code_context, domain=domain)
            submit_context = self.bloks_extract_context_data(code_result, AP_2SV_CODE_ENTRY_ASYNC)
            if not submit_context:
                submit_context = self._extract_context_tolerante(code_result)
            if not submit_context:
                self._dump_caa_debug(send_result, entry_result)
                return {"logged_in": False, "reason": "missing code_entry_async context_data"}

            code = verification_code or self.challenge_code_or_raised(ChallengeChoice.EMAIL)
            try:
                submit_result = self.bloks_ap_two_step_verification_submit_code(
                    submit_context,
                    code,
                    domain=domain,
                )
            except ChallengeError:
                raise
            except ClientError as exc:
                raise ChallengeError(
                    f"CAA profile-code submission failed: {exc}",
                    response=getattr(exc, "response", None),
                ) from exc
            return {
                "logged_in": self.bloks_apply_login_response(submit_result),
                "reason": "",
                "result": submit_result,
            }

        def _extract_context_tolerante(self, result: dict) -> str:
            """Procura context_data em QUALQUER mapa (f4i) numa string que
            menciona o app do code_entry — independente da posição do app id."""
            import re  # noqa: PLC0415

            from instagrapi.mixins.bloks import (  # noqa: PLC0415
                AP_2SV_CODE_ENTRY,
                AP_2SV_CODE_ENTRY_ASYNC,
            )

            strings: list[str] = []
            self._bloks_collect_strings(result, strings)
            ids = (AP_2SV_CODE_ENTRY, AP_2SV_CODE_ENTRY_ASYNC)
            for texto in strings:
                if not any(app_id in texto for app_id in ids):
                    continue
                for match in re.finditer(r"\(f4i", texto):
                    expression = self._bloks_parenthesized_expression(texto, match.start())
                    if not expression:
                        continue
                    groups: list[list[str]] = []
                    cursor = 0
                    while True:
                        group_start = expression.find("(dkc", cursor)
                        if group_start < 0:
                            break
                        group = self._bloks_parenthesized_expression(expression, group_start)
                        if not group:
                            break
                        groups.append(self._bloks_string_literals(group))
                        cursor = group_start + len(group)
                    for keys, values in zip(groups, groups[1:]):
                        if "context_data" in keys:
                            idx = keys.index("context_data")
                            if idx < len(values) and values[idx]:
                                return values[idx]
            return ""

        def _dump_caa_debug(self, send_result: dict, entry_result: dict) -> None:
            """Diagnóstico best-effort: grava as respostas brutas do desafio para
            análise (sem credenciais — só as árvores bloks)."""
            import json as _json  # noqa: PLC0415
            import os as _os  # noqa: PLC0415
            import time as _time  # noqa: PLC0415

            try:
                diretorio = _os.environ.get("STORAGE_DIR", "/app/storage")
                caminho = _os.path.join(diretorio, f"_debug_caa_{int(_time.time())}.json")
                with open(caminho, "w", encoding="utf-8") as f:
                    _json.dump({"send_result": send_result, "entry_result": entry_result}, f, default=str)
                self.logger.warning("code_entry não extraído do desafio CAA — dump em %s", caminho)
            except Exception as exc:  # pragma: no cover — diagnóstico best-effort
                self.logger.warning("falha ao gravar diagnóstico do CAA: %s", exc)

    kwargs = {}
    if proxy_url:
        kwargs["proxy"] = proxy_url
    return _ThrottleAwareClient(**kwargs)


# Trechos de mensagem do Instagram que indicam senha/credencial errada. O fluxo
# CAA/bloks do fork NÃO levanta BadPassword para senha errada: devolve um
# ClientError genérico ("CAA login did not return a session") com o payload
# bruto pendurado em atributos da exceção — a mensagem real ("The password you
# entered is incorrect") só existe aninhada ali. Sem esse reconhecimento o
# adapter caía no plano B legado (morto: needs_upgrade) e o operador via a
# mensagem genérica do fim do fluxo em vez de "senha incorreta".
_PASSWORD_HINTS = (
    "password you entered is incorrect",
    "password was incorrect",
    "incorrect password",
    "wrong password",
    "double-check your password",
    "check your password",
    "bad_password",
    "senha incorreta",
    "senha inválida",
    "senha errada",
    "instagram rejected the login credentials",
)


def _texto_da_excecao(exc: Exception) -> str:
    """Concatena os textos legíveis de uma exceção do transporte: a mensagem E
    os atributos anexados (o fork pendura o payload bruto do CAA — ex. `result`
    — como atributos da exceção). Ignora objetos HTTP (`response`, cookies crus)
    e limita tamanho/profundidade para não varrer payloads gigantes."""
    partes: list[str] = []
    orcamento = 8000
    visitados: set[int] = set()
    ignorar = {"response", "raw_cookies"}

    def coleta(valor, profundidade: int = 0) -> None:
        nonlocal orcamento
        if orcamento <= 0 or profundidade > 6:
            return
        if isinstance(valor, str):
            texto = valor.strip()
            if texto and len(texto) <= 2000:
                partes.append(texto)
                orcamento -= len(texto)
            return
        if isinstance(valor, (dict, list, tuple, set)):
            if id(valor) in visitados:
                return
            visitados.add(id(valor))
            itens = valor.items() if isinstance(valor, dict) else valor
            for item in itens:
                chave, v = item if isinstance(valor, dict) else (None, item)
                if isinstance(chave, str) and chave in ignorar:
                    continue
                coleta(v, profundidade + 1)
                if orcamento <= 0:
                    return
            return
        if isinstance(valor, Exception):
            coleta(str(valor), profundidade + 1)

    coleta(str(exc))
    try:
        coleta(vars(exc))
    except Exception:  # noqa: BLE001 — exceção sem __dict__ não é crítico
        pass
    return " ".join(partes)


def _erro_de_senha(exc: Exception, etapa: str) -> SessionExpiredError | None:
    """Reconhece erro de senha PELO CONTEÚDO da exceção (mensagem + atributos
    anexados), além do nome — cobre o ClientError genérico do CAA/bloks que
    carrega "The password you entered is incorrect" aninhado no payload."""
    nome = type(exc).__name__
    por_nome = nome in {"BadPassword", "BadCredentials"}
    texto = _texto_da_excecao(exc).lower()
    if not por_nome and not any(dica in texto for dica in _PASSWORD_HINTS):
        return None
    detalhe = f"{nome}: {exc}".strip() if por_nome else ""
    if len(detalhe) > 220:
        detalhe = detalhe[:220] + "…"
    return SessionExpiredError(
        f"senha incorreta ({etapa}): o Instagram recusou a senha desta conta. "
        "Confira a senha cadastrada e tente novamente."
        + (f" Detalhe do Instagram: {detalhe}" if detalhe else "")
    )


def _error_from_exception(exc: Exception, etapa: str) -> AdapterError:
    """Mapeia exceções do transporte para o contrato do núcleo (AdapterError x SessionExpiredError)."""
    erro_senha = _erro_de_senha(exc, etapa)
    if erro_senha is not None:
        return erro_senha
    if type(exc).__name__ in _THROTTLE_NAMES:
        return ThrottledError(
            f"{etapa}: Instagram limitou as tentativas desta conta/IP (429 Too Many Requests). "
            "Aguarde alguns minutos antes de tentar de novo — tentativas repetidas pioram o bloqueio. "
            "Se persistir (mesmo sem proxy), o IP usado está marcado: tente por outro IP/proxy "
            "residencial ou aguarde mais tempo."
        )
    if type(exc).__name__ in _SESSION_EXPIRED_NAMES:
        return SessionExpiredError(f"{etapa}: {type(exc).__name__} — {exc}")
    return AdapterError(f"{etapa}: {type(exc).__name__} — {exc}")


# ---- importação de áudio por link (/reels/audio/{id}/) ----

_AUDIO_LINK_RE = re.compile(r"/reels/audio/(\d+)/?")


def extrair_audio_id_do_link(url: str | None) -> str | None:
    """Extrai o id numérico de um link de áudio do Instagram
    (https://www.instagram.com/reels/audio/{id}/)."""
    url = (url or "").strip()
    if not url:
        return None
    match = _AUDIO_LINK_RE.search(url)
    return match.group(1) if match else None


def fetch_audio_por_link(
    url: str,
    session_data: str,
    proxy_url: str | None = None,
    client_factory=None,
) -> dict:
    """Busca metadados + URL de download do áudio de um link do Instagram.

    Usa a sessão de uma conta conectada (track_info_by_id — a superfície da
    página /reels/audio/). Som original tem `progressive_download_url` (arquivo
    completo baixável); música licenciada só tem metadados (download_url None).
    O transporte é injetável via client_factory para testes offline.
    """
    audio_id = extrair_audio_id_do_link(url)
    if not audio_id:
        raise AdapterError(
            "link inválido — use o formato https://www.instagram.com/reels/audio/{id}/"
        )
    factory = client_factory or _default_client_factory
    client = factory(proxy_url)
    try:
        client.set_settings(json.loads(session_data))
    except (ValueError, TypeError) as exc:
        raise SessionExpiredError(f"sessão persistida ilegível: {exc}") from exc
    try:
        pagina = client.track_info_by_id(audio_id)
    except Exception as exc:  # noqa: BLE001 — mapeado para o contrato do núcleo
        raise _error_from_exception(exc, "busca de áudio") from exc

    metadata = (pagina or {}).get("metadata") or {}
    som = metadata.get("original_sound_info") or {}
    musica = metadata.get("music_info") or {}
    asset = musica.get("music_asset_info") or {}

    artista = (
        (som.get("ig_artist") or {}).get("username")
        or (asset.get("display_artist") or "").strip()
        or None
    )
    titulo = (som.get("original_audio_title") or asset.get("title") or "").strip()
    if titulo in ("", "Original audio"):
        titulo = ""
    return {
        "audio_id": audio_id,
        "titulo": titulo or (f"áudio original de @{artista}" if artista else "áudio original"),
        "artista": artista,
        "duracao_ms": som.get("duration_in_ms") or asset.get("duration_in_ms"),
        "capa_url": (som.get("ig_artist") or {}).get("profile_pic_url")
        or asset.get("cover_artwork_thumbnail_uri"),
        "download_url": som.get("progressive_download_url") or None,
        "original": bool(som),
    }


# ===================== pílula de link desenhada na mídia do story =====================
# O configure de story do fork envia o link só como `tap_models` (a área de toque);
# o `static_models` (o DESENHO do sticker) nunca é preenchido — então link via API
# fica funcional mas invisível. Solução (mesma ideia do StoryBuilder do fork, mas
# com Pillow, que já vem instalado): desenhar a pílula branca com o texto do story
# DENTRO da imagem e posicionar a área de toque do sticker exatamente sobre ela.
# O texto do story vira o rótulo do botão; emoji colorido usa a fonte da Apple/Noto.
# Para o botão ser reconhecido de bate-pronto como LINK (igual ao sticker nativo do
# Instagram), a pílula leva o ícone de corrente à esquerda do rótulo e uma sombra suave.
# O preview do front (Stories.tsx + .story-preview-link no App.css) espelha estas medidas.

_STORY_W, _STORY_H = 720, 1280

# Posição do link/sticker no story (fração da tela 0..1). A pílula fica no centro
# horizontal; 'inferior' é o comportamento padrão do app.
_STORY_LINK_Y = {"superior": 0.14, "meio": 0.5, "inferior": 0.86}

_PILL_FONT_SIZES = (46, 40, 34, 28)  # reduz quando o texto não cabe
_PILL_MAX_TEXT_W = 500
_PILL_PAD_X = 36
_PILL_PAD_Y = 20
_PILL_ICON_SCALE = 1.3  # lado do ícone de corrente = tamanho da fonte * isto
_PILL_ICON_GAP_SCALE = 0.3  # espaço ícone↔texto = tamanho da fonte * isto
_PILL_ICON_COLOR = (0, 149, 246, 255)  # azul do Instagram — "isto é clicável"
_PILL_SHADOW = (0, 0, 0, 90)
_PILL_TEXT_COLOR = (12, 12, 12, 255)
_PILL_BG = (255, 255, 255, 255)
_PILL_BORDER = (0, 0, 0, 45)  # traço sutil para a pílula não sumir em foto clara
_PILL_FONT_PATHS = [
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]


def _pill_font_path() -> str:
    for p in _PILL_FONT_PATHS:
        if os.path.isfile(p):
            return p
    return _PILL_FONT_PATHS[-1]  # DejaVu vem no fonts-dejavu-core (Dockerfile)


def _wrap_by_pixels(texto: str, font, max_w: int) -> list[str]:
    """Quebra o texto em linhas medindo em PIXELS (não em caracteres)."""
    linhas: list[str] = []
    atual = ""
    for palavra in texto.split():
        candidato = f"{atual} {palavra}".strip() if atual else palavra
        if font.getlength(candidato) <= max_w or not atual:
            atual = candidato
        else:
            linhas.append(atual)
            atual = palavra
    if atual:
        linhas.append(atual)
    return linhas


def _truncate_by_pixels(texto: str, font, max_w: int) -> str:
    if font.getlength(texto) <= max_w:
        return texto
    while texto and font.getlength(texto + "…") > max_w:
        texto = texto[:-1]
    return (texto + "…").strip()


def _pill_text_seg(seg: str, font) -> Image.Image:
    """Segmento de TEXTO (preto) em RGBA transparente, sem contorno."""
    tmp = Image.new("RGBA", (1, 1))
    x0, y0, x1, y1 = ImageDraw.Draw(tmp).textbbox((0, 0), seg, font=font)
    w, h = max(1, x1 - x0), max(1, y1 - y0)
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(img).text((-x0, -y0), seg, font=font, fill=_PILL_TEXT_COLOR)
    return img


def _pill_line(linha: str, font, font_size: int) -> Image.Image:
    """Uma linha do rótulo: texto preto + emoji colorido (fonte da Apple/Noto)."""
    segs: list[Image.Image] = []
    for chunk in _EMOJI_RE.split(linha):
        if not chunk:
            continue
        if _EMOJI_RE.fullmatch(chunk):
            em = _render_emoji_seg(chunk, round(font_size * 1.15))
            segs.append(em if em is not None else _pill_text_seg(chunk, font))
        else:
            segs.append(_pill_text_seg(chunk, font))
    if not segs:
        return Image.new("RGBA", (1, 1), (0, 0, 0, 0))
    total_w = sum(s.width for s in segs)
    max_h = max(s.height for s in segs)
    canvas = Image.new("RGBA", (max(1, total_w), max_h), (0, 0, 0, 0))
    x = 0
    for s in segs:
        canvas.alpha_composite(s, (x, (max_h - s.height) // 2))
        x += s.width
    return canvas


# Ícone "Link" do Lucide (viewBox 24x24) — os MESMOS paths que o preview do front usa
# (lucide-react `Link`), rasterizados aqui com Pillow para o envio ficar idêntico.
_LUCIDE_LINK_PATHS = (
    "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",
    "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
)
_PILL_ICON_STROKE = 2.6  # espessura do traço no viewBox 24 (o front usa o mesmo valor)
_SVG_TOKEN_RE = re.compile(r"[MmLlAa]|-?\d*\.?\d+(?:e-?\d+)?")


def _svg_arc_points(x0: float, y0: float, rx: float, ry: float, fa: int, fs: int, x1: float, y1: float) -> list[tuple[float, float]]:
    """Arco SVG (sem rotação) do ponto (x0,y0) ao (x1,y1) → polilinha. Conversão
    endpoint→centro da especificação SVG (F.6.5)."""
    dx, dy = (x0 - x1) / 2, (y0 - y1) / 2
    lam = dx * dx / (rx * rx) + dy * dy / (ry * ry)
    if lam > 1:
        rx, ry = rx * math.sqrt(lam), ry * math.sqrt(lam)
    num = rx * rx * ry * ry - rx * rx * dy * dy - ry * ry * dx * dx
    den = rx * rx * dy * dy + ry * ry * dx * dx
    coef = (-1 if fa == fs else 1) * math.sqrt(max(0.0, num / den))
    cxp, cyp = coef * rx * dy / ry, -coef * ry * dx / rx
    cx, cy = cxp + (x0 + x1) / 2, cyp + (y0 + y1) / 2
    t1 = math.atan2((dy - cyp) / ry, (dx - cxp) / rx)
    t2 = math.atan2((-dy - cyp) / ry, (-dx - cxp) / rx)
    dt = t2 - t1
    if fs == 0 and dt > 0:
        dt -= 2 * math.pi
    elif fs == 1 and dt < 0:
        dt += 2 * math.pi
    passos = 32
    return [(cx + rx * math.cos(t1 + dt * i / passos), cy + ry * math.sin(t1 + dt * i / passos)) for i in range(passos + 1)]


def _svg_path_points(d: str) -> list[tuple[float, float]]:
    """Polilinha de um path SVG que use só M/L/A (absolutos ou relativos) — o
    suficiente para os ícones do Lucide usados aqui."""
    tokens = _SVG_TOKEN_RE.findall(d)
    pts: list[tuple[float, float]] = []
    x = y = 0.0
    i = 0
    cmd = ""
    while i < len(tokens):
        if tokens[i].isalpha():
            cmd = tokens[i]
            i += 1
        rel = cmd.islower()
        if cmd in "Mm":
            nx, ny = float(tokens[i]), float(tokens[i + 1])
            i += 2
            x, y = (x + nx, y + ny) if rel else (nx, ny)
            pts.append((x, y))
            cmd = "l" if rel else "L"  # pares seguintes a um M são linhas
        elif cmd in "Ll":
            nx, ny = float(tokens[i]), float(tokens[i + 1])
            i += 2
            x, y = (x + nx, y + ny) if rel else (nx, ny)
            pts.append((x, y))
        elif cmd in "Aa":
            rx, ry, _rot, fa, fs, nx, ny = (float(t) for t in tokens[i : i + 7])
            i += 7
            ex, ey = (x + nx, y + ny) if rel else (nx, ny)
            pts.extend(_svg_arc_points(x, y, rx, ry, int(fa), int(fs), ex, ey)[1:])
            x, y = ex, ey
        else:
            raise ValueError(f"comando SVG não suportado: {cmd!r}")
    return pts


def _chain_icon(size: int, color: tuple[int, int, int, int]) -> Image.Image:
    """Ícone `Link` do Lucide em RGBA transparente, size x size. Traço arredondado
    desenhado em supersampling 8x e reduzido, para ficar sem serrilhado."""
    ss = 8
    lado = size * ss
    k = lado / 24  # viewBox 24x24 -> pixels
    largura = round(_PILL_ICON_STROKE * k)
    raio = largura / 2
    big = Image.new("RGBA", (lado, lado), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    for path in _LUCIDE_LINK_PATHS:
        pts = [(px * k, py * k) for px, py in _svg_path_points(path)]
        d.line(pts, fill=color, width=largura)
        for px, py in pts:  # círculo em cada vértice: junções e pontas arredondadas (round cap/join)
            d.ellipse((px - raio, py - raio, px + raio, py + raio), fill=color)
    return big.resize((size, size), Image.LANCZOS)


def _render_story_pill(origem: str, texto: str, link: str, posicao: str | None) -> tuple[Path, dict]:
    """Desenha a pílula do link na imagem do story (canvas 720x1280) e devolve
    (arquivo renderizado, sticker). O dict segue o contrato do StorySticker do
    instagrapi; x/y/width/height são frações da tela calculadas EXATAMENTE sobre
    a pílula desenhada — a área de toque cobre o botão."""
    rotulo = (texto or "").strip() or urlparse(link).netloc
    try:
        with Image.open(origem) as src:
            src = ImageOps.exif_transpose(src).convert("RGB")
            sw, sh = src.size
            escala = max(_STORY_W / sw, _STORY_H / sh)
            src = src.resize((round(sw * escala), round(sh * escala)), Image.LANCZOS)
            sw, sh = src.size
            esq, topo = (sw - _STORY_W) // 2, (sh - _STORY_H) // 2
            canvas = src.crop((esq, topo, esq + _STORY_W, topo + _STORY_H))
    except Exception as exc:  # noqa: BLE001 — mídia ilegível vira erro do adapter
        raise AdapterError(f"não deu para renderizar a pílula do link: {exc}") from exc

    font = None
    linhas: list[str] = []
    for size in _PILL_FONT_SIZES:
        try:
            font = ImageFont.truetype(_pill_font_path(), size)
        except OSError:
            continue
        linhas = _wrap_by_pixels(rotulo, font, _PILL_MAX_TEXT_W)
        if all(font.getlength(l) <= _PILL_MAX_TEXT_W for l in linhas):
            break
    if font is None:
        raise AdapterError("nenhuma fonte disponível para desenhar a pílula do link")
    # último recurso: palavra única maior que a largura máxima
    linhas = [_truncate_by_pixels(l, font, _PILL_MAX_TEXT_W) for l in linhas]

    imagens = [_pill_line(l, font, font.size) for l in linhas]
    largura_texto = max(im.width for im in imagens)
    altura_linha = max(im.height for im in imagens)
    passo = round(altura_linha * 1.25)
    icone_lado = round(font.size * _PILL_ICON_SCALE)
    icone_gap = round(font.size * _PILL_ICON_GAP_SCALE)
    pw = 2 * _PILL_PAD_X + icone_lado + icone_gap + largura_texto
    ph = 2 * _PILL_PAD_Y + (len(imagens) - 1) * passo + altura_linha

    x_centro = _STORY_W // 2
    y_centro = round(_STORY_H * _STORY_LINK_Y.get(posicao or "", 0.86))
    x0 = x_centro - pw // 2
    y0 = max(8, min(y_centro - ph // 2, _STORY_H - ph - 8))

    pill = Image.new("RGBA", (pw, ph), (0, 0, 0, 0))
    d = ImageDraw.Draw(pill)
    d.rounded_rectangle(
        (0, 0, pw - 1, ph - 1), radius=ph // 2, fill=_PILL_BG, outline=_PILL_BORDER, width=2
    )
    pill.alpha_composite(_chain_icon(icone_lado, _PILL_ICON_COLOR), (_PILL_PAD_X, (ph - icone_lado) // 2))
    texto_x0 = _PILL_PAD_X + icone_lado + icone_gap
    y = _PILL_PAD_Y
    for im in imagens:
        pill.alpha_composite(im, (texto_x0 + (largura_texto - im.width) // 2, y))
        y += passo

    fundo = canvas.convert("RGBA")
    # sombra suave sob a pílula: destaca o botão em foto clara e reforça o "sticker"
    sombra = Image.new("RGBA", fundo.size, (0, 0, 0, 0))
    ImageDraw.Draw(sombra).rounded_rectangle(
        (x0, y0 + 6, x0 + pw - 1, y0 + ph + 5), radius=ph // 2, fill=_PILL_SHADOW
    )
    fundo.alpha_composite(sombra.filter(ImageFilter.GaussianBlur(12)))
    fundo.alpha_composite(pill, (x0, y0))
    fd, nome = tempfile.mkstemp(suffix=".jpg")
    os.close(fd)
    try:
        fundo.convert("RGB").save(nome, "JPEG", quality=95)
    except Exception as exc:  # noqa: BLE001
        Path(nome).unlink(missing_ok=True)
        raise AdapterError(f"não deu para salvar a pílula do link: {exc}") from exc

    sticker = {
        "type": "story_link",
        "x": round((x0 + pw / 2) / _STORY_W, 7),
        "y": round((y0 + ph / 2) / _STORY_H, 7),
        "z": 0,
        "width": round(pw / _STORY_W, 7),
        "height": round(ph / _STORY_H, 7),
        "rotation": 0.0,
        "extra": {"link_type": "web", "url": link, "tap_state_str_id": "link_sticker_default"},
    }
    return Path(nome), sticker


class InstagramAdapter(PlatformAdapter):
    name = "instagram"

    def __init__(self, *, proxy: dict | None = None, client_factory=None) -> None:
        super().__init__(proxy=proxy)
        self._client_factory = client_factory or _default_client_factory
        self._client = None
        self._caption: str | None = None
        self._audio_ref: str | None = None
        self._uploaded_media_ids: list[str] = []

    # ---------- helpers internos ----------
    def _ensure_client(self) -> None:
        """Abre/prepara o contexto de execução desta conta (com o proxy dela, quando houver)."""
        if self._client is None:
            self._client = self._client_factory(build_proxy_url(self._proxy))

    @staticmethod
    def _serialize_session(client) -> str:
        return json.dumps(client.get_settings())

    def _hydrate_session(self, session_data: str) -> None:
        try:
            settings = json.loads(session_data)
        except (ValueError, TypeError) as exc:
            raise SessionExpiredError(f"sessão persistida ilegível: {exc}") from exc
        self._client.set_settings(settings)

    def _apply_fingerprint(self, client, fingerprint: str | None) -> None:
        """Aplica o fingerprint persistido da conta no client: device/hardware,
        uuids, user-agent, locale e timezone. Sem fingerprint (ou com blob
        ilegível), o client segue com o device padrão do fork."""
        if not fingerprint:
            return
        try:
            dados = json.loads(fingerprint)
        except (ValueError, TypeError):
            return
        try:
            if dados.get("device_settings"):
                client.set_device(dict(dados["device_settings"]), hydrate_app_profile=True)
            if dados.get("uuids"):
                client.set_uuids(dict(dados["uuids"]))
            if dados.get("locale"):
                client.set_locale(dados["locale"])
            if dados.get("user_agent"):
                client.set_user_agent(dados["user_agent"])
            if dados.get("timezone_offset") is not None:
                client.set_timezone_offset(
                    int(dados["timezone_offset"]), timezone_name=dados.get("timezone_name") or None
                )
        except Exception as exc:  # noqa: BLE001 — fingerprint ruim não pode travar o login
            logger.warning("fingerprint da conta não aplicável — seguindo com device novo: %s", exc)

    def _media_paths(self, ctx: PublishContext) -> list[str]:
        paths = ctx.media_paths if ctx.media_paths else [ctx.media_path]
        return [p for p in paths if p]

    # ---------- ciclo de vida ----------
    def open(self) -> None:
        self._ensure_client()

    def login(self, ctx: PublishContext) -> str | None:
        """Autentica com usuário/senha reais e devolve a sessão serializada para persistência.

        Estratégia (clientes reais): fluxo CAA/bloks PRIMEIRO — é o login atual
        do app, e no fork 3.x roda com transporte curl_cffi (HTTP/2 + TLS
        híbrido) que não leva o 429 do transporte requests antigo. Se o CAA
        falhar por erro genérico (não credencial/2FA nem throttle), tenta o
        login LEGADO em cada versão conhecida do fork como plano B — o
        Instagram vem respondendo "needs_upgrade" para todas as versões
        legadas, então esse caminho só existe como última alternativa.
        """
        self._ensure_client()
        if not ctx.account_username:
            raise SessionExpiredError("username ausente — não é possível autenticar")
        if not ctx.account_password:
            raise SessionExpiredError("senha ausente — configure a senha da conta para autenticar")
        kwargs = {"verification_code": ctx.verification_code} if ctx.verification_code else {}

        if not hasattr(self._client, "set_device"):
            # transporte de teste (stub): mantém o comportamento original
            try:
                self._client.login(ctx.account_username, ctx.account_password, **kwargs)
            except Exception as exc:  # noqa: BLE001 — mapeado para o contrato do núcleo
                raise _error_from_exception(exc, "login") from exc
            return self._serialize_session(self._client)

        # 1) CAA/bloks — fluxo atual. Throttle (429) e erro de conta (senha,
        # 2FA, desafio) param aqui: nada disso se resolve no login legado. O
        # desafio de código vira SessionExpiredError com o estado do cliente
        # anexado (pending_login_data) para o retry reusar os MESMOS device ids
        # — senão o Instagram emite um código novo e o código digitado não vale.
        caa = self._client_factory(build_proxy_url(self._proxy))
        if ctx.pending_login_data:
            # retry do desafio: reidrata o estado salvo da tentativa anterior
            # (o fork recomenda "retry login after saving client settings").
            try:
                caa.set_settings(json.loads(ctx.pending_login_data))
                logger.info("login CAA: reusando estado do desafio anterior")
            except Exception as exc:  # noqa: BLE001 — blob ilegível: segue com client novo
                logger.warning("estado pendente de login ilegível: %s", exc)
        else:
            # sem retry de desafio: aplica a fingerprint persistida da conta
            # (o desafio anterior já carrega o device correto dentro do blob).
            self._apply_fingerprint(caa, ctx.fingerprint)
        caa_erro: Exception | None = None
        try:
            caa.login(ctx.account_username, ctx.account_password, **kwargs)
        except Exception as exc:  # noqa: BLE001 — mapeado por nome
            nome = type(exc).__name__
            if nome in _THROTTLE_NAMES:
                raise _error_from_exception(exc, "login CAA") from exc
            desafiou = (
                nome in {"ChallengeRequired", "TwoFactorRequired"}
                or "code_entry" in str(exc)
                or (ctx.pending_login_data and nome not in _SESSION_EXPIRED_NAMES)
            )
            if desafiou:
                erro = SessionExpiredError(
                    "login CAA: Instagram pediu um código de verificação "
                    "(enviado para o e-mail/telefone da conta). Informe o código "
                    "ao conectar de novo."
                )
                erro.pending_login_data = self._serialize_session(caa)
                raise erro from exc
            if nome in _SESSION_EXPIRED_NAMES:
                raise _error_from_exception(exc, "login CAA") from exc
            erro_senha = _erro_de_senha(exc, "login CAA")
            if erro_senha is not None:
                # Senha errada não se resolve no legado (morto: needs_upgrade) —
                # devolve a causa real em vez de queimar as versões e exibir a
                # mensagem genérica do fim do fluxo.
                raise erro_senha from exc
            caa_erro = exc
            logger.warning("login CAA falhou (%s): %s — tentando o login legado", nome, exc)
        else:
            self._client = caa
            logger.info("login CAA OK")
            return self._serialize_session(caa)

        # 2) Login legado (plano B). No fork 3.x o método é `login_legacy` —
        # `login` é o CAA. skip_caa_login impede o fallback interno de tocar no
        # CAA de novo a cada versão tentada.
        versoes = _app_versions_do_fork()
        for i, versao in enumerate(versoes):
            cliente = self._client if i == 0 else self._client_factory(build_proxy_url(self._proxy))
            setattr(cliente, "skip_caa_login", True)  # só login legado nesta rodada
            try:
                device = {"app_version": versao}
                if ctx.fingerprint:
                    self._apply_fingerprint(cliente, ctx.fingerprint)
                    try:
                        device = {**(json.loads(ctx.fingerprint).get("device_settings") or {}), "app_version": versao}
                    except (ValueError, TypeError, AttributeError):
                        pass
                cliente.set_device(device, hydrate_app_profile=True)
            except Exception as exc:  # noqa: BLE001 — versão fora do APP_SETTINGS do fork
                logger.warning("app %s indisponível no fork: %s", versao, exc)
                continue
            try:
                cliente.login_legacy(ctx.account_username, ctx.account_password, **kwargs)
            except Exception as exc:  # noqa: BLE001 — mapeado por nome
                nome = type(exc).__name__
                if nome in _THROTTLE_NAMES or nome in _SESSION_EXPIRED_NAMES:
                    raise _error_from_exception(exc, "login legado") from exc
                erro_senha = _erro_de_senha(exc, "login legado")
                if erro_senha is not None:
                    # Senha errada não muda de versão para versão — para já com
                    # a causa real em vez de esgotar a lista e esconder o motivo.
                    raise erro_senha from exc
                if nome != "UnknownError":
                    raise _error_from_exception(exc, "login legado") from exc
                if "needs_upgrade" not in _texto_da_excecao(exc):
                    # UnknownError por OUTRO motivo (não é a versão descontinuada)
                    # também não se resolve trocando de versão de app — mostra a
                    # causa real em vez de engolir o erro.
                    raise _error_from_exception(exc, "login legado") from exc
                logger.warning("login legado (app %s) rejeitado: %s — %s", versao, nome, exc)
                continue
            self._client = cliente
            logger.info("login legado OK (app %s)", versao)
            return self._serialize_session(cliente)

        causa_caa = _texto_da_excecao(caa_erro) if caa_erro is not None else ""
        if len(causa_caa) > 300:
            causa_caa = causa_caa[:300] + "…"
        raise AdapterError(
            "login: o fluxo CAA/bloks falhou"
            + (f" ({causa_caa})" if causa_caa else "")
            + " e todas as versões de app foram "
            "rejeitadas pelo login legado (needs_upgrade) — o login legado foi "
            "descontinuado pelo Instagram; use a senha pelo fluxo CAA ou o cookie sessionid"
        )

    def login_with_sessionid(self, ctx: PublishContext) -> str | None:
        """Login via cookie de sessão (sessionid) colado do navegador.

        Contorna por completo o fluxo de login (senha/CAA) — é o caminho quando
        o Instagram está limitando as tentativas (429). O operador pega o cookie
        `sessionid` de uma sessão já aberta no navegador e cola na conta.
        """
        self._ensure_client()
        sessionid = (ctx.sessionid or "").strip()
        if len(sessionid) < 30 or not re.search(r"^\d+", sessionid):
            raise SessionExpiredError(
                "sessionid inválido — cole o cookie 'sessionid' completo do navegador "
                "(o valor começa com o id numérico do usuário)"
            )
        self._apply_fingerprint(self._client, ctx.fingerprint)
        try:
            self._client.login_by_sessionid(sessionid)
        except Exception as exc:  # noqa: BLE001 — mapeado para o contrato do núcleo
            raise _error_from_exception(exc, "login via sessionid") from exc
        return self._serialize_session(self._client)

    def check_session(self, ctx: PublishContext) -> bool:
        """Valida a sessão persistida com uma chamada REAL de rede — não apenas a presença do blob."""
        if not ctx.session_data:
            return False
        self._ensure_client()
        try:
            self._hydrate_session(ctx.session_data)
            feed = self._client.get_timeline_feed()
            return bool(feed is not None)
        except Exception:  # noqa: BLE001 — qualquer falha aqui = sessão inválida
            return False

    def create_reel(self, ctx: PublishContext) -> None:
        """Prepara o reel. A validação do arquivo acontece aqui; o upload/config
        de verdade ocorre em publish() (upload + criação do clip)."""
        path = ctx.media_path
        if not path or not os.path.isfile(path):
            raise AdapterError(f"mídia do reel não encontrada: {path or '(vazio)'}")
        if os.path.getsize(path) == 0:
            raise AdapterError(f"mídia do reel vazia: {path}")

    def set_caption(self, ctx: PublishContext) -> None:
        """Guarda a legenda para ser aplicada de verdade na criação do clip (publish)."""
        self._caption = ctx.caption

    def select_audio(self, ctx: PublishContext) -> None:
        """Resolve a referência de áudio do núcleo. O instagrapi expõe busca de
        música em versões recentes; quando o transporte não suportar, registra
        e segue sem áudio em vez de fingir (áudio é opcional no contrato)."""
        self._audio_ref = ctx.audio_reference
        if not ctx.audio_reference:
            return
        self._ensure_client()
        # instagrapi renomeou a busca de música entre versões (music_search → search_music).
        search = getattr(self._client, "music_search", None) or getattr(self._client, "search_music", None)
        if search is None:
            logger.warning("Transporte não expõe busca de música — publicando sem áudio em alta")
            return
        try:
            resultados = search(ctx.audio_reference)
            if not resultados:
                return
            primeiro = resultados[0]
            if isinstance(primeiro, dict):
                track = primeiro.get("track")
                self._audio_ref = track.get("id") if isinstance(track, dict) else ctx.audio_reference
            else:
                self._audio_ref = getattr(primeiro, "id", None) or getattr(primeiro, "pk", None) or ctx.audio_reference
        except Exception as exc:  # noqa: BLE001 — áudio é best-effort
            logger.warning("Falha ao resolver áudio '%s': %s", ctx.audio_reference, exc)

    def publish(self, ctx: PublishContext) -> PublishResult:
        """Publicação REAL: clip_upload para reels; upload sequencial de cada
        imagem para stories. external_id = pk da mídia criada no Instagram."""
        self._ensure_client()
        try:
            if ctx.kind == "story":
                ids = self._upload_story(ctx)
                return PublishResult(external_id=",".join(ids) if len(ids) > 1 else (ids[0] if ids else None), confirmed=False)
            thumb = self._gerar_thumbnail(ctx.media_path)
            try:
                media = self._client.clip_upload(ctx.media_path, caption=self._caption or "", thumbnail=thumb)
            finally:
                if thumb is not None:
                    thumb.unlink(missing_ok=True)
            self._uploaded_media_ids.append(str(media.pk))
            return PublishResult(external_id=str(media.pk), confirmed=False)
        except Exception as exc:  # noqa: BLE001 — mapeado para o contrato do núcleo
            raise _error_from_exception(exc, "publicação") from exc

    @staticmethod
    def _gerar_thumbnail(video_path: str):
        """O fork 3.x EXIGE thumbnail no clip_upload (o MoviePy que gerava
        sozinho não está instalado no backend). Extrai 1 frame do próprio vídeo
        com ffmpeg; se não der, devolve None e o fork levanta o erro dele."""
        import subprocess  # noqa: PLC0415
        import tempfile  # noqa: PLC0415
        from pathlib import Path  # noqa: PLC0415

        try:
            fd, nome = tempfile.mkstemp(suffix=".jpg")
            os.close(fd)
            alvo = Path(nome)
            subprocess.run(
                ["ffmpeg", "-y", "-v", "error", "-i", str(video_path),
                 "-frames:v", "1", "-vf", "scale=720:-2", str(alvo)],
                capture_output=True,
                timeout=60,
                check=True,
            )
            if alvo.stat().st_size == 0:
                alvo.unlink(missing_ok=True)
                return None
            return alvo
        except Exception as exc:  # noqa: BLE001 — best-effort; sem thumb o fork reporta
            logger.warning("não deu para gerar thumbnail do reel: %s", exc)
            return None

    def _upload_story(self, ctx: PublishContext) -> list[str]:
        """Upload de cada imagem do story. Com link: a pílula branca é desenhada
        na mídia e o texto do story vira o rótulo do botão — a área de toque do
        sticker cobre exatamente a pílula. Sem link: o texto segue como legenda
        nativa do story (comportamento anterior)."""
        ids: list[str] = []
        paths = self._media_paths(ctx)
        if not paths:
            raise AdapterError("story sem mídia para enviar")
        temp_files: list[Path] = []
        try:
            for path in paths:
                destino = path
                caption = self._story_caption(ctx) or ""
                stickers = None
                if ctx.story_link:
                    renderizado, sticker = _render_story_pill(
                        path, caption, ctx.story_link, ctx.story_link_posicao
                    )
                    temp_files.append(renderizado)
                    destino = str(renderizado)
                    stickers = self._prepare_story_stickers([sticker])
                    caption = ""  # o texto agora vive DENTRO da pílula (rótulo do botão)
                # stickers=None quebra o fork (configure_story faz stickers.copy());
                # story sem link não pode receber o kwarg.
                kwargs = {"caption": caption}
                if stickers is not None:
                    kwargs["stickers"] = stickers
                media = self._client.photo_upload_to_story(destino, **kwargs)
                ids.append(str(media.pk))
                self._uploaded_media_ids.append(str(media.pk))
        finally:
            for arquivo in temp_files:
                arquivo.unlink(missing_ok=True)
        return ids

    def _story_caption(self, ctx: PublishContext) -> str:
        """Texto do story + texto extra opcional (blocos separados)."""
        base = ctx.story_text or ""
        extra = ctx.story_text_extra or ""
        if base and extra:
            return f"{base}\n\n{extra}"
        return base or extra

    def _prepare_story_stickers(self, stickers: list[dict] | None):
        """O instagrapi espera objetos StorySticker (pydantic) no configure do
        story — dicts crus quebram com AttributeError. A conversão só acontece
        quando o cliente REAL (instagrapi.Client) está em uso; stubs de teste e
        outros transportes seguem recebendo o contrato em dicts."""
        if not stickers:
            return None
        try:
            from instagrapi import Client as IgClient  # noqa: PLC0415
            from instagrapi.types import StorySticker  # noqa: PLC0415
        except ImportError:  # pragma: no cover - ambiente sem instagrapi
            return stickers
        if isinstance(self._client, IgClient):
            return [StorySticker(**s) for s in stickers]
        return stickers

    def create_story(self, ctx: PublishContext) -> None:
        """Stories: a sequência de imagens (media_paths) é enviada em publish()."""
        for path in self._media_paths(ctx):
            if not path or not os.path.isfile(path):
                raise AdapterError(f"mídia do story não encontrada: {path or '(vazio)'}")

    def attach_link(self, ctx: PublishContext) -> None:
        """Link do story é aplicado junto do upload (pílula renderizada + stickers). Nada extra a fazer."""
        return None

    def confirm_publication(self, ctx: PublishContext, result: PublishResult) -> bool:
        """Confirmação REAL: busca a mídia criada de volta no Instagram. Iniciar
        o upload não basta — a mídia precisa existir no perfil da conta."""
        if not result.external_id:
            return False
        self._ensure_client()
        try:
            pk = result.external_id.split(",")[0]
            media = self._client.media_info(pk)
            return bool(media is not None and str(getattr(media, "pk", None)) == pk)
        except Exception:  # noqa: BLE001 — sem confirmação = sem sucesso
            return False

    def close(self) -> None:
        """Libera o contexto de execução desta conta (e sua sessão em memória)."""
        self._client = None
        self._caption = None
        self._audio_ref = None
        self._uploaded_media_ids = []
