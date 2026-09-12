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
import os

from .base import AdapterError, PlatformAdapter, PublishContext, PublishResult, SessionExpiredError, build_proxy_url

logger = logging.getLogger("nitro.publishing.instagram")

# Nomes de exceção do instagrapi que significam "a sessão/credencial não serve mais
# ou exige ação manual" (comparados por nome para não depender da importação da lib).
_SESSION_EXPIRED_NAMES = {
    "BadPassword",
    "ChallengeRequired",
    "SelectContactPointRecoveryForm",
    "RecaptchaChallengeForm",
    "TwoFactorRequired",
    "PleaseWaitFewMinutes",
    "LoginRequired",
    "UserNotFound",
}


def _default_client_factory(proxy_url: str | None):
    """Cria um Client instagrapi novo para ESTA conta. Importação tardia: o resto
    do sistema (e os testes) funciona sem a biblioteca instalada."""
    try:
        from instagrapi import Client  # noqa: PLC0415
    except ImportError as exc:  # pragma: no cover - depende do ambiente
        raise AdapterError(
            "biblioteca 'instagrapi' não instalada no backend (adicione em requirements.txt)"
        ) from exc
    kwargs = {}
    if proxy_url:
        kwargs["proxy"] = proxy_url
    return Client(**kwargs)


def _error_from_exception(exc: Exception, etapa: str) -> AdapterError:
    """Mapeia exceções do transporte para o contrato do núcleo (AdapterError x SessionExpiredError)."""
    if type(exc).__name__ in _SESSION_EXPIRED_NAMES:
        return SessionExpiredError(f"{etapa}: {type(exc).__name__} — {exc}")
    return AdapterError(f"{etapa}: {type(exc).__name__} — {exc}")


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

    def _media_paths(self, ctx: PublishContext) -> list[str]:
        paths = ctx.media_paths if ctx.media_paths else [ctx.media_path]
        return [p for p in paths if p]

    # ---------- ciclo de vida ----------
    def open(self) -> None:
        self._ensure_client()

    def login(self, ctx: PublishContext) -> str | None:
        """Autentica com usuário/senha reais e devolve a sessão serializada para persistência."""
        self._ensure_client()
        if not ctx.account_username:
            raise SessionExpiredError("username ausente — não é possível autenticar")
        if not ctx.account_password:
            raise SessionExpiredError("senha ausente — configure a senha da conta para autenticar")
        try:
            kwargs = {}
            if ctx.verification_code:
                kwargs["verification_code"] = ctx.verification_code
            self._client.login(ctx.account_username, ctx.account_password, **kwargs)
        except Exception as exc:  # noqa: BLE001 — mapeado para o contrato do núcleo
            raise _error_from_exception(exc, "login") from exc
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
        search = getattr(self._client, "music_search", None)
        if search is None:
            logger.warning("Transporte não expõe busca de música — publicando sem áudio em alta")
            return
        try:
            resultados = search(ctx.audio_reference)
            if resultados:
                track = resultados[0].get("track") if isinstance(resultados[0], dict) else None
                self._audio_ref = track.get("id") if isinstance(track, dict) else ctx.audio_reference
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
            media = self._client.clip_upload(ctx.media_path, caption=self._caption or "")
            self._uploaded_media_ids.append(str(media.pk))
            return PublishResult(external_id=str(media.pk), confirmed=False)
        except Exception as exc:  # noqa: BLE001 — mapeado para o contrato do núcleo
            raise _error_from_exception(exc, "publicação") from exc

    def _upload_story(self, ctx: PublishContext) -> list[str]:
        ids: list[str] = []
        paths = self._media_paths(ctx)
        if not paths:
            raise AdapterError("story sem mídia para enviar")
        for path in paths:
            media = self._client.photo_upload_to_story(
                path,
                caption=ctx.story_text or "",
                links=[{"webUri": ctx.story_link}] if ctx.story_link else None,
            )
            ids.append(str(media.pk))
            self._uploaded_media_ids.append(str(media.pk))
        return ids

    def create_story(self, ctx: PublishContext) -> None:
        """Stories: a sequência de imagens (media_paths) é enviada em publish()."""
        for path in self._media_paths(ctx):
            if not path or not os.path.isfile(path):
                raise AdapterError(f"mídia do story não encontrada: {path or '(vazio)'}")

    def attach_link(self, ctx: PublishContext) -> None:
        """Link do story é aplicado junto do upload (parâmetro links). Nada extra a fazer."""
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
