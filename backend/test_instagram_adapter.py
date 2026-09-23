"""Testes do InstagramAdapter REAL sem tocar na rede.

O transporte instagrapi é injetado via `client_factory` (stub) — assim o
contrato do adapter (sessão persistida, login, proxy por conta, reel/story,
legenda, link, confirmação de publicação) é exercitado offline, e o arquivo
continua verde mesmo sem credenciais/Internet.

O objetivo NÃO é testar o instagrapi em si — é testar que o adapter usa o
transporte corretamente e mapeia erros para o contrato do núcleo.
"""
import json
import os
import tempfile

import pytest

from app.config import settings
from app.publishing.platforms.base import AdapterError, PublishContext, SessionExpiredError, build_proxy_url
from app.publishing.platforms.instagram import InstagramAdapter


class StubMedia:
    def __init__(self, pk):
        self.pk = pk


class BadPassword(Exception):
    """Mesmo nome da exceção real do instagrapi — o adapter mapeia por nome."""
    pass


class ClientThrottledError(Exception):
    """Mesmo nome da exceção real do instagrapi — o adapter mapeia por nome."""
    pass


class PleaseWaitFewMinutes(Exception):
    """Mesmo nome da exceção real do instagrapi — o adapter mapeia por nome."""
    pass


class UnknownError(Exception):
    """Mesmo nome da exceção real do instagrapi — o adapter mapeia por nome."""
    pass


class ClientError(Exception):
    """Mesmo nome da exceção real do instagrapi — o adapter mapeia por nome."""
    pass


class ChallengeRequired(Exception):
    """Mesmo nome da exceção real do instagrapi — o adapter mapeia por nome."""
    pass


@pytest.fixture(autouse=True)
def _sem_versao_de_operador(monkeypatch):
    """Partida determinística: sem INSTAGRAM_APP_VERSION vinda do ambiente, para
    os testes do fallback enxergarem a lista completa do fork. Os testes da
    versão do operador sobrescrevem o valor dentro do próprio teste."""
    monkeypatch.setattr(settings, "instagram_app_version", "")
    monkeypatch.setattr(settings, "instagram_app_version_code", "")


class StubClient:
    """Finge ser um instagrapi.Client: mesma superfície usada pelo adapter."""

    def __init__(self, proxy=None):
        self.proxy = proxy
        self.settings: dict = {"cookies": {"sessionid": "abc"}}
        self.uploads: list[tuple[str, str]] = []
        self.stories: list[tuple[str, str, list | None, list | None]] = []

    def get_settings(self):
        return dict(self.settings)

    def set_settings(self, s):
        self.settings = dict(s)

    def login(self, username, password, verification_code=None):
        if password == "senha-errada":
            raise BadPassword("The password you entered is incorrect.")
        self.settings["authorization_data"] = {"ds_user_id": "1", "user": username}
        self.ultimo_codigo = verification_code

    def login_by_sessionid(self, sessionid):
        if len(sessionid) < 30 or not sessionid[0].isdigit():
            raise RuntimeError("invalid sessionid")
        self.settings["authorization_data"] = {"ds_user_id": sessionid.split("%")[0], "user": "perfil01"}

    def get_timeline_feed(self):
        if not self.settings.get("authorization_data"):
            raise RuntimeError("login required")
        return {"items": []}

    def clip_upload(self, path, caption="", thumbnail=None):
        if not self.settings.get("authorization_data"):
            raise RuntimeError("login required")
        self.uploads.append((path, caption))
        return StubMedia("pk-reel-1")

    def photo_upload_to_story(self, path, caption="", links=None, stickers=None):
        self.stories.append((path, caption, links, stickers))
        return StubMedia(f"pk-story-{len(self.stories)}")

    def media_info(self, pk):
        if pk in ("pk-reel-1", "pk-story-1", "pk-story-2"):
            return StubMedia(pk)
        return None


def _ctx(**overrides) -> PublishContext:
    base = dict(
        account_username="perfil01",
        account_password="senha-real",
        session_data=None,
        proxy=None,
        media_path="",
        caption=None,
        audio_reference=None,
        kind="reel",
    )
    base.update(overrides)
    return PublishContext(**base)


def _tmp_video():
    f = tempfile.NamedTemporaryFile(suffix=".mp4", delete=False)
    f.write(b"\x00" * 128)
    f.close()
    return f.name


def _tmp_imagem():
    """Imagem real (JPEG) — o renderizador da pílula abre o arquivo com Pillow."""
    from PIL import Image

    f = tempfile.NamedTemporaryFile(suffix=".jpg", delete=False)
    f.close()
    Image.new("RGB", (540, 960), (40, 70, 130)).save(f.name, "JPEG")
    return f.name


def _tem_pixel(im, x0, y0, w, h, pred) -> bool:
    """Existe pelo menos um pixel na região que satisfaz o predicado?"""
    for px in range(max(0, x0), min(im.width, x0 + w), 2):
        for py in range(max(0, y0), min(im.height, y0 + h), 2):
            if pred(*im.getpixel((px, py))):
                return True
    return False


def test_build_proxy_url():
    assert build_proxy_url(None) is None
    assert build_proxy_url({"host": "1.2.3.4", "port": 1080}) == "socks5://1.2.3.4:1080"
    assert (
        build_proxy_url({"host": "1.2.3.4", "port": 1080, "username": "u", "password": "p"})
        == "socks5://u:p@1.2.3.4:1080"
    )
    assert (
        build_proxy_url({"protocol": "http", "host": "h", "port": 8080, "username": "a b", "password": "c@d"})
        == "http://a%20b:c%40d@h:8080"
    )


def test_adapter_recebe_proxy_da_conta():
    """O proxy configurado na conta é passado ao transporte (contexto por conta)."""
    seen = {}

    def factory(proxy_url):
        seen["url"] = proxy_url
        return StubClient(proxy=proxy_url)

    adapter = InstagramAdapter(
        proxy={"protocol": "socks5", "host": "9.9.9.9", "port": 1080, "username": "u", "password": "p"},
        client_factory=factory,
    )
    adapter.open()
    assert seen["url"] == "socks5://u:p@9.9.9.9:1080"
    assert adapter._client.proxy == seen["url"]


def test_login_persiste_sessao_serializada():
    adapter = InstagramAdapter(client_factory=lambda proxy: StubClient(proxy))
    session = adapter.login(_ctx())
    assert session is not None
    data = json.loads(session)
    assert data["authorization_data"]["user"] == "perfil01"


def test_login_senha_incorreta_vira_sessao_expirada():
    adapter = InstagramAdapter(client_factory=lambda proxy: StubClient(proxy))
    try:
        adapter.login(_ctx(account_password="senha-errada"))
        raise AssertionError("deveria ter levantado")
    except SessionExpiredError as exc:
        assert "BadPassword" in str(exc)


def test_login_repassa_codigo_de_verificacao():
    """2FA/desafio: o código informado pelo operador chega ao transporte."""
    client = StubClient()
    adapter = InstagramAdapter(client_factory=lambda proxy: client)
    adapter.login(_ctx(verification_code="123456"))
    assert client.ultimo_codigo == "123456"
    adapter.login(_ctx())
    assert client.ultimo_codigo is None


def test_login_sem_senha_e_recusado():
    adapter = InstagramAdapter(client_factory=lambda proxy: StubClient(proxy))
    try:
        adapter.login(_ctx(account_password=None))
        raise AssertionError("deveria ter levantado")
    except SessionExpiredError:
        pass


def test_check_session_sem_blob_ou_blob_ilegivel():
    adapter = InstagramAdapter(client_factory=lambda proxy: StubClient(proxy))
    assert adapter.check_session(_ctx(session_data=None)) is False
    assert adapter.check_session(_ctx(session_data="não-é-json")) is False


def test_check_session_valida_com_rede_real():
    """Sessão válida persiste o ciclo completo: login -> blob -> reidratação -> validação."""
    client = StubClient()
    adapter = InstagramAdapter(client_factory=lambda proxy: client)
    session = adapter.login(_ctx())
    # simula reinício do processo: adapter novo, mesmo blob persistido
    adapter2 = InstagramAdapter(client_factory=lambda proxy: client)
    assert adapter2.check_session(_ctx(session_data=session)) is True
    # sessão inválida (settings sem authorization) → False
    client.settings = {"cookies": {}}
    assert adapter2.check_session(_ctx(session_data=json.dumps(client.get_settings()))) is False


def test_reel_publicado_com_legenda_e_confirmado():
    video = _tmp_video()
    try:
        adapter = InstagramAdapter(client_factory=lambda proxy: StubClient(proxy))
        ctx = _ctx(media_path=video, caption="Legenda do reel #top")
        adapter.open()
        session = adapter.login(ctx)
        ctx.session_data = session
        assert adapter.check_session(ctx)
        adapter.create_reel(ctx)
        adapter.set_caption(ctx)
        result = adapter.publish(ctx)
        assert result.external_id == "pk-reel-1"
        assert adapter._client.uploads == [(video, "Legenda do reel #top")]
        assert adapter.confirm_publication(ctx, result) is True
    finally:
        os.unlink(video)


def test_create_reel_com_arquivo_inexistente_falha():
    adapter = InstagramAdapter(client_factory=lambda proxy: StubClient(proxy))
    try:
        adapter.create_reel(_ctx(media_path="/nao/existe.mp4"))
        raise AssertionError("deveria ter levantado")
    except AdapterError:
        pass


def test_story_com_multiplas_imagens_em_sequencia():
    a, b = _tmp_imagem(), _tmp_imagem()
    try:
        adapter = InstagramAdapter(client_factory=lambda proxy: StubClient(proxy))
        ctx = _ctx(
            kind="story",
            media_path=a,
            media_paths=[a, b],
            story_text="Sequência",
            story_link="https://exemplo.com",
        )
        adapter.open()
        session = adapter.login(ctx)
        ctx.session_data = session
        adapter.create_story(ctx)
        adapter.attach_link(ctx)
        result = adapter.publish(ctx)
        assert result.external_id == "pk-story-1,pk-story-2"
        assert len(adapter._client.stories) == 2
        path0, caption, links, stickers = adapter._client.stories[0]
        assert path0 != a  # imagem renderizada com a pílula (temporária)
        assert caption == ""  # o texto virou o rótulo do botão
        assert links is None
        assert stickers is not None and stickers[0]["type"] == "story_link"
        assert stickers[0]["extra"]["url"] == "https://exemplo.com"
        assert os.path.exists(path0) is False  # temporário limpo após o upload
        assert adapter.confirm_publication(ctx, result) is True
    finally:
        os.unlink(a)
        os.unlink(b)


def test_story_link_posicionado_e_texto_extra():
    """Texto extra é um elemento À PARTE: nunca concatena com o texto principal
    (nem no rótulo da pílula, nem na legenda) e ganha a PRÓPRIA posição — bug
    antigo: "Chama no link / Oferta só hoje!" virava um bloco só na pílula."""
    from app.publishing.platforms.instagram import _render_story_pill

    a = _tmp_imagem()
    try:
        adapter = InstagramAdapter(client_factory=lambda proxy: StubClient(proxy))
        ctx = _ctx(
            kind="story",
            media_path=a,
            story_text="Chama no link",
            story_link="https://exemplo.com",
            story_link_posicao="superior",
            story_text_extra="Oferta só hoje!",
            story_text_extra_x=0.5,
            story_text_extra_y=0.9,
        )
        adapter.open()
        session = adapter.login(ctx)
        ctx.session_data = session
        adapter.create_story(ctx)
        adapter.attach_link(ctx)
        result = adapter.publish(ctx)
        assert len(adapter._client.stories) == 1
        path0, caption, links, stickers = adapter._client.stories[0]
        assert caption == ""  # o texto PRINCIPAL foi para a pílula — sozinho
        assert links is None
        assert stickers[0]["x"] == pytest.approx(0.5, abs=0.02)
        assert stickers[0]["y"] == pytest.approx(0.14, abs=0.06)  # pílula: "superior"
        assert stickers[0]["extra"]["url"] == "https://exemplo.com"
        # o rótulo da pílula é só "Chama no link": a largura bate com uma pílula
        # renderizada SÓ com o texto principal — não com os dois textos juntos
        caminho_ref, sticker_so_principal = _render_story_pill(a, "Chama no link", "https://exemplo.com", "superior")
        caminho_concat, sticker_concatenado = _render_story_pill(
            a, "Chama no link\n\nOferta só hoje!", "https://exemplo.com", "superior"
        )
        os.unlink(caminho_ref)
        os.unlink(caminho_concat)
        assert stickers[0]["width"] == pytest.approx(sticker_so_principal["width"], abs=1e-6)
        assert stickers[0]["width"] != pytest.approx(sticker_concatenado["width"], abs=1e-6)
        assert os.path.exists(path0) is False  # temporário (pílula + texto extra) limpo após upload
        assert result.external_id == "pk-story-1"
    finally:
        os.unlink(a)


def test_texto_extra_nunca_concatena_e_tem_posicao_propria():
    """Sem link: o texto principal segue como legenda nativa (comportamento de
    sempre) e o texto extra é desenhado À PARTE, na posição escolhida — nunca
    aparece dentro da `caption`."""
    a = _tmp_imagem()
    try:
        adapter = InstagramAdapter(client_factory=lambda proxy: StubClient(proxy))
        ctx = _ctx(
            kind="story",
            media_path=a,
            story_text="Legenda principal",
            story_text_extra="Bônus surpresa!",
            story_text_extra_x=0.2,
            story_text_extra_y=0.15,
        )
        adapter.open()
        session = adapter.login(ctx)
        ctx.session_data = session
        adapter.create_story(ctx)
        adapter.publish(ctx)
        path0, caption, links, stickers = adapter._client.stories[0]
        # a legenda nativa é SÓ o texto principal — nunca ganha o extra junto
        assert caption == "Legenda principal"
        assert "Bônus" not in caption
        assert stickers is None
        # o arquivo enviado é o renderizado com o texto extra (não o original) e
        # foi limpo depois do upload
        assert path0 != a
        assert os.path.exists(path0) is False
    finally:
        os.unlink(a)


def test_render_story_extra_text_desenha_texto_na_posicao_escolhida():
    """`_render_story_extra_text` desenha texto branco com contorno na posição
    (x, y) TOTALMENTE livre pedida — não presa a topo/meio/baixo."""
    from PIL import Image

    from app.publishing.platforms.instagram import _render_story_extra_text

    a = _tmp_imagem()
    try:
        # posições verticais variadas (topo/meio/baixo) — x sempre centralizado
        for y in (0.14, 0.5, 0.86):
            caminho = _render_story_extra_text(a, "Oferta só hoje!", 0.5, y)
            try:
                with Image.open(caminho) as im:
                    assert im.size == (720, 1280)
                    y_centro = round(1280 * y)
                    banda = (60, max(0, y_centro - 80), 600, 160)
                    # branco (miolo da letra) e preto (contorno) na banda esperada
                    assert _tem_pixel(im, *banda, lambda r, g, b: r > 220 and g > 220 and b > 220)
                    assert _tem_pixel(im, *banda, lambda r, g, b: r < 40 and g < 40 and b < 40)
            finally:
                os.unlink(caminho)

        # posição horizontal também livre: texto perto da borda esquerda fica
        # concentrado do lado esquerdo da tela, não no centro (banda em y=0.5)
        caminho = _render_story_extra_text(a, "X", 0.1, 0.5)
        try:
            with Image.open(caminho) as im:
                metade_esquerda = _tem_pixel(im, 0, 560, 360, 160, lambda r, g, b: r > 220 and g > 220 and b > 220)
                metade_direita = _tem_pixel(im, 360, 560, 360, 160, lambda r, g, b: r > 220 and g > 220 and b > 220)
                assert metade_esquerda and not metade_direita
        finally:
            os.unlink(caminho)

        # x/y ausentes (None) caem no centro da tela
        caminho = _render_story_extra_text(a, "Centro", None, None)
        try:
            with Image.open(caminho) as im:
                banda = (60, 560, 600, 160)  # em torno de y=0.5
                assert _tem_pixel(im, *banda, lambda r, g, b: r > 220 and g > 220 and b > 220)
        finally:
            os.unlink(caminho)
    finally:
        os.unlink(a)


def test_story_link_sem_posicao_cai_na_inferior():
    a = _tmp_imagem()
    try:
        adapter = InstagramAdapter(client_factory=lambda proxy: StubClient(proxy))
        ctx = _ctx(kind="story", media_path=a, story_link="https://exemplo.com")
        adapter.open()
        session = adapter.login(ctx)
        ctx.session_data = session
        adapter.create_story(ctx)
        adapter.publish(ctx)
        path0, caption, links, stickers = adapter._client.stories[0]
        assert caption == ""
        assert links is None
        assert stickers[0]["y"] == pytest.approx(0.86, abs=0.06)
        assert os.path.exists(path0) is False
    finally:
        os.unlink(a)


def test_story_sem_link_mantem_legenda_nativa():
    a = _tmp_imagem()
    try:
        adapter = InstagramAdapter(client_factory=lambda proxy: StubClient(proxy))
        ctx = _ctx(kind="story", media_path=a, story_text="Sem link")
        adapter.open()
        session = adapter.login(ctx)
        ctx.session_data = session
        adapter.create_story(ctx)
        adapter.publish(ctx)
        path0, caption, links, stickers = adapter._client.stories[0]
        assert path0 == a  # mídia original, sem renderização
        assert caption == "Sem link"
        assert links is None and stickers is None
    finally:
        os.unlink(a)


def test_story_sem_link_nao_passa_stickers_none():
    """Regressão: o fork do instagrapi faz stickers.copy() no configure_story —
    story SEM link quebraria com AttributeError se o adapter passasse
    stickers=None. O adapter precisa omitir o kwarg (default vira [])."""
    a = _tmp_imagem()

    class ForkLikeClient(StubClient):
        def photo_upload_to_story(self, path, caption="", links=None, stickers=[]):
            if stickers is None:
                raise AttributeError("'NoneType' object has no attribute 'copy'")
            self.stories.append((path, caption, links, stickers))
            return StubMedia("pk-story-semlink")

    try:
        adapter = InstagramAdapter(client_factory=lambda proxy: ForkLikeClient(proxy))
        ctx = _ctx(kind="story", media_path=a, story_text="Sem link")
        adapter.open()
        session = adapter.login(ctx)
        ctx.session_data = session
        adapter.create_story(ctx)
        result = adapter.publish(ctx)
        assert result.external_id == "pk-story-semlink"
        path0, caption, links, stickers = adapter._client.stories[0]
        assert caption == "Sem link"
        assert stickers == []  # kwarg omitido -> default do fork
    finally:
        os.unlink(a)


def test_render_story_pill_desenha_pilula_branca_com_texto_preto():
    """A pílula é desenhada na imagem: fundo branco, ícone de corrente azul, texto
    preto e o sticker cobrindo exatamente a pílula (frações da tela)."""
    from PIL import Image

    from app.publishing.platforms.instagram import _render_story_pill

    a = _tmp_imagem()
    try:
        caminho, sticker = _render_story_pill(a, "🔥 Chama no link", "https://exemplo.com", "inferior")
        try:
            assert sticker["type"] == "story_link"
            assert sticker["extra"]["url"] == "https://exemplo.com"
            assert 0 < sticker["width"] < 1 and 0 < sticker["height"] < 1
            with Image.open(caminho) as im:
                assert im.size == (720, 1280)
                x0 = round(sticker["x"] * 720)
                y0 = round(sticker["y"] * 1280)
                pw = round(sticker["width"] * 720)
                ph = round(sticker["height"] * 1280)
                # área interna esquerda da pílula: branca
                assert im.getpixel((x0 - pw // 2 + 14, y0)) == (255, 255, 255)
                # há texto preto e (quando a fonte existe) emoji colorido — varre
                # só a faixa do texto, sem cantos/borda da pílula
                from app.publishing.platforms.instagram import _PILL_PAD_X, _PILL_PAD_Y

                banda = (
                    x0 - pw // 2 + _PILL_PAD_X,
                    y0 - ph // 2 + _PILL_PAD_Y,
                    pw - 2 * _PILL_PAD_X,
                    ph - 2 * _PILL_PAD_Y,
                )
                assert _tem_pixel(
                    im, *banda,
                    lambda r, g, b: r < 80 and g < 80 and b < 80,
                )
                # ícone de corrente (azul) à esquerda do rótulo: é o que identifica o link
                assert _tem_pixel(
                    im,
                    x0 - pw // 2 + _PILL_PAD_X,
                    y0 - ph // 2 + _PILL_PAD_Y,
                    _PILL_PAD_X,
                    ph - 2 * _PILL_PAD_Y,
                    lambda r, g, b: b > 200 and r < 60 and 100 < g < 200,
                )
                from app.services.video import _emoji_font

                if _emoji_font() is not None:
                    assert _tem_pixel(
                        im, *banda,
                        lambda r, g, b: max(r, g, b) - min(r, g, b) > 40,
                    )
        finally:
            os.unlink(caminho)
    finally:
        os.unlink(a)


def test_confirmacao_exige_midia_existente_na_plataforma():
    adapter = InstagramAdapter(client_factory=lambda proxy: StubClient(proxy))
    ctx = _ctx()
    assert adapter.confirm_publication(ctx, type("R", (), {"external_id": "pk-inexistente"})()) is False
    assert adapter.confirm_publication(ctx, type("R", (), {"external_id": None})()) is False


def test_throttle_429_vira_adapter_error_com_instrucao():
    from app.publishing.platforms.instagram import _error_from_exception

    erro = _error_from_exception(ClientThrottledError("429"), "login")
    assert isinstance(erro, AdapterError)
    assert not isinstance(erro, SessionExpiredError)
    assert "429" in str(erro)
    assert "aguarde" in str(erro).lower()


def test_please_wait_minutos_vira_throttle_nao_sessao_expirada():
    from app.publishing.platforms.instagram import _error_from_exception

    erro = _error_from_exception(PleaseWaitFewMinutes("wait"), "login")
    assert isinstance(erro, AdapterError)
    assert not isinstance(erro, SessionExpiredError)


def test_default_client_nao_engole_throttle_do_login_caa():
    """O fork do instagrapi engole o 429 do CAA e re-levanta o erro do login legado
    (ex.: 'out of date'); o client padrão do adapter precisa propagar o throttle."""
    try:
        from instagrapi.exceptions import ClientThrottledError as RealThrottle  # noqa: PLC0415

        from app.publishing.platforms.instagram import _default_client_factory  # noqa: PLC0415
    except ImportError:
        return  # ambiente sem instagrapi (ex.: host) — pulado

    client = _default_client_factory(None)

    def _bloks_429(verification_code=""):
        raise RealThrottle("429")

    client.bloks_caa_login = _bloks_429
    try:
        client._try_caa_login(RuntimeError("erro original do login legado"))
        raise AssertionError("deveria ter propagado o throttle em vez de engolir")
    except RealThrottle:
        pass


def test_login_com_sessionid_persiste_sessao():
    client = StubClient()
    adapter = InstagramAdapter(client_factory=lambda proxy: client)
    session = adapter.login_with_sessionid(_ctx(sessionid="12345678901234567890%3Aabcd1234abcd1234"))
    assert session is not None
    data = json.loads(session)
    assert data["authorization_data"]["user"] == "perfil01"


def test_login_com_sessionid_invalido_e_recusado():
    adapter = InstagramAdapter(client_factory=lambda proxy: StubClient(proxy))
    try:
        adapter.login_with_sessionid(_ctx(sessionid="curto"))
        raise AssertionError("deveria ter levantado")
    except SessionExpiredError as exc:
        assert "sessionid" in str(exc)


def _com_instagrapi() -> bool:
    try:
        import instagrapi  # noqa: PLC0415, F401
        return True
    except ImportError:
        return False


def _factory_legado(sucesso_na_versao=None, login_do_caa=None, erro_do_caa=None, erro_do_legado=None):
    """Factory dos testes de login (roda só com instagrapi instalado): cria
    clientes REAIS (init offline) com `login` (fluxo CAA do fork 3.x) e
    `login_legacy` substituídos por fakes que decidem por versão de app — sem
    tocar na rede."""
    from app.publishing.platforms.instagram import _default_client_factory  # noqa: PLC0415

    criados = []
    set_settings_calls = []

    def factory(proxy_url=None):
        client = _default_client_factory(proxy_url)

        original_set_settings = client.set_settings

        def _set_settings(settings_dict):
            set_settings_calls.append(settings_dict)
            return original_set_settings(settings_dict)

        client.set_settings = _set_settings

        def _login_caa(username, password, **kwargs):
            if erro_do_caa is not None:
                raise erro_do_caa
            if login_do_caa is None:
                raise ClientError("CAA login did not return a session")
            return login_do_caa(client, username, password)

        def _login_legado(username, password, **kwargs):
            if erro_do_legado is not None:
                raise erro_do_legado
            if client.device_settings.get("app_version") == sucesso_na_versao:
                # o fork serializa self.authorization_data (get_settings) — é o que o adapter persiste
                client.authorization_data = {"ds_user_id": "1", "user": username}
                return True
            raise UnknownError("needs_upgrade")

        client.login = _login_caa
        client.login_legacy = _login_legado
        criados.append(client)
        return client

    factory.set_settings_calls = set_settings_calls  # type: ignore[attr-defined]
    return factory, criados


def test_login_caa_primeiro_nao_toca_o_legado_quando_passa():
    """CAA (login do fork 3.x) é o fluxo principal: quando passa, o login
    legado NEM é tentado."""
    if not _com_instagrapi():
        return
    caa_called = []

    def login_do_caa(client, username, password):
        caa_called.append(True)
        client.authorization_data = {"ds_user_id": "1", "user": username}
        return True

    factory, criados = _factory_legado(sucesso_na_versao=None, login_do_caa=login_do_caa)
    adapter = InstagramAdapter(client_factory=factory)
    session = adapter.login(_ctx())
    assert session is not None
    assert json.loads(session)["authorization_data"]["user"] == "perfil01"
    assert caa_called == [True]
    # só o cliente inicial + o do CAA — nenhum cliente legado foi criado
    assert len(criados) == 2


def test_login_caa_falha_generica_cai_no_legado():
    """CAA falhou com erro genérico → o adapter tenta as versões legadas do
    fork (plano B) e conecta quando uma passa."""
    if not _com_instagrapi():
        return
    factory, criados = _factory_legado(sucesso_na_versao="428.0.0.47.67")
    adapter = InstagramAdapter(client_factory=factory)
    session = adapter.login(_ctx())
    assert session is not None
    assert json.loads(session)["authorization_data"]["user"] == "perfil01"
    # cliente inicial (vira a 1ª tentativa legada: 446 falha) + CAA + 428 ok
    assert len(criados) == 3
    assert not getattr(criados[1], "skip_caa_login", False)  # cliente do CAA
    assert getattr(criados[0], "skip_caa_login")  # tentativas legadas
    assert getattr(criados[2], "skip_caa_login")


def test_login_caa_com_throttle_levanta_erro_sem_tocar_o_legado():
    """429 no CAA: ThrottledError imediato — o legado não é queimado (não
    conserta limite de tentativas)."""
    if not _com_instagrapi():
        return
    factory, criados = _factory_legado(sucesso_na_versao=None, erro_do_caa=ClientThrottledError("429"))
    adapter = InstagramAdapter(client_factory=factory)
    try:
        adapter.login(_ctx())
        raise AssertionError("deveria ter levantado")
    except AdapterError as exc:
        assert "429" in str(exc)
    assert len(criados) == 2  # inicial + CAA; nenhum cliente legado


def test_login_caa_com_erro_de_conta_nao_tenta_o_legado():
    """Senha errada no CAA: SessionExpiredError imediato — tentar o legado com
    a mesma senha não muda o resultado."""
    if not _com_instagrapi():
        return
    factory, criados = _factory_legado(sucesso_na_versao=None, erro_do_caa=BadPassword("senha errada"))
    adapter = InstagramAdapter(client_factory=factory)
    try:
        adapter.login(_ctx())
        raise AssertionError("deveria ter levantado")
    except SessionExpiredError as exc:
        assert "BadPassword" in str(exc)
    assert len(criados) == 2


def test_login_caa_senha_errada_em_clienterror_generico_vira_senha_incorreta():
    """Senha errada NO FLUXO REAL: o CAA/bloks do fork não levanta BadPassword —
    devolve ClientError genérico com a mensagem real aninhada no payload (atributo
    `result`). O adapter precisa reconhecer o conteúdo e mostrar "senha incorreta"
    em vez de cair no legado e exibir a mensagem genérica de needs_upgrade."""
    if not _com_instagrapi():
        return
    erro = ClientError("CAA login did not return a session")
    erro.result = {
        "layout": {
            "bloks_payload": {
                "action": '{"screens": ["The password you entered is incorrect. Please try again."]}'
            }
        }
    }
    factory, criados = _factory_legado(sucesso_na_versao=None, erro_do_caa=erro)
    adapter = InstagramAdapter(client_factory=factory)
    try:
        adapter.login(_ctx())
        raise AssertionError("deveria ter levantado")
    except SessionExpiredError as exc:
        assert "senha incorreta" in str(exc)
        assert "needs_upgrade" not in str(exc)
    assert len(criados) == 2  # inicial + CAA — as versões legadas não foram queimadas


def test_login_legado_senha_incorreta_para_na_primeira_versao():
    """O legado devolveu mensagem de senha errada: para na primeira versão com
    "senha incorreta" — trocar de versão de app não conserta a senha."""
    if not _com_instagrapi():
        return
    erro = UnknownError("The password you entered is incorrect. Please try again.")
    factory, criados = _factory_legado(sucesso_na_versao=None, erro_do_legado=erro)
    adapter = InstagramAdapter(client_factory=factory)
    try:
        adapter.login(_ctx())
        raise AssertionError("deveria ter levantado")
    except SessionExpiredError as exc:
        assert "senha incorreta" in str(exc)
    assert len(criados) == 2  # inicial + CAA — parou na 1ª tentativa legada


def test_login_legado_unknown_error_sem_needs_upgrade_e_devolvido():
    """UnknownError do legado por OUTRO motivo (não needs_upgrade) não é
    engolido: a causa real chega ao operador em vez de virar a mensagem
    genérica do fim do fluxo."""
    if not _com_instagrapi():
        return
    erro = UnknownError("erro inesperado do endpoint legado")
    factory, criados = _factory_legado(sucesso_na_versao=None, erro_do_legado=erro)
    adapter = InstagramAdapter(client_factory=factory)
    try:
        adapter.login(_ctx())
        raise AssertionError("deveria ter levantado")
    except AdapterError as exc:
        assert "erro inesperado do endpoint legado" in str(exc)
        assert "needs_upgrade" not in str(exc)
    assert len(criados) == 2


def test_login_legado_todas_rejeitadas_erro_claro():
    """CAA genérico falhou e TODAS as versões legadas foram rejeitadas
    (needs_upgrade) → erro claro para o operador, incluindo a causa do CAA."""
    if not _com_instagrapi():
        return
    factory, criados = _factory_legado(sucesso_na_versao=None)
    adapter = InstagramAdapter(client_factory=factory)
    try:
        adapter.login(_ctx())
        raise AssertionError("deveria ter levantado")
    except AdapterError as exc:
        assert "needs_upgrade" in str(exc)
        assert "CAA login did not return a session" in str(exc)
    assert len(criados) == 5  # inicial + CAA + 3 clientes das versões seguintes


def test_login_caa_desafio_anexa_estado_pendente():
    """Desafio (código por e-mail) no CAA: SessionExpiredError com o estado do
    cliente anexado para o retry reusar os device ids."""
    if not _com_instagrapi():
        return
    factory, criados = _factory_legado(sucesso_na_versao=None, erro_do_caa=ChallengeRequired("code required"))
    adapter = InstagramAdapter(client_factory=factory)
    try:
        adapter.login(_ctx())
        raise AssertionError("deveria ter levantado")
    except SessionExpiredError as exc:
        assert "código" in str(exc) or "verificação" in str(exc)
        assert getattr(exc, "pending_login_data", None)
        dados = json.loads(exc.pending_login_data)
        assert "device_settings" in dados
    assert len(criados) == 2  # inicial + CAA; sem legado


def test_login_caa_code_entry_ausente_vira_desafio():
    """A extração do code_entry falhou (formato novo do Instagram): mesmo erro
    do desafio — pede o código e anexa o estado, sem cair no legado morto."""
    if not _com_instagrapi():
        return
    factory, criados = _factory_legado(
        sucesso_na_versao=None, erro_do_caa=ClientError("missing code_entry context_data")
    )
    adapter = InstagramAdapter(client_factory=factory)
    try:
        adapter.login(_ctx())
        raise AssertionError("deveria ter levantado")
    except SessionExpiredError as exc:
        assert getattr(exc, "pending_login_data", None)
    assert len(criados) == 2  # sem queimar as versões legadas


def test_login_retry_com_codigo_reusa_device_ids():
    """Retry com pending_login_data: o client do CAA reidrata o estado salvo
    (mesmos device ids) antes de tentar de novo."""
    if not _com_instagrapi():
        return
    from app.publishing.platforms.instagram import _default_client_factory  # noqa: PLC0415

    def login_do_caa(client, username, password):
        client.authorization_data = {"ds_user_id": "1", "user": username}
        return True

    factory, _ = _factory_legado(sucesso_na_versao=None, login_do_caa=login_do_caa)
    # estado pendente: settings de um client real (device ids fixos)
    c0 = _default_client_factory(None)
    pending = json.dumps(c0.get_settings())

    adapter = InstagramAdapter(client_factory=factory)
    session = adapter.login(_ctx(pending_login_data=pending))
    assert session is not None
    assert json.loads(session)["authorization_data"]["user"] == "perfil01"
    assert factory.set_settings_calls
    assert json.loads(pending)["uuids"]["uuid"] == factory.set_settings_calls[0]["uuids"]["uuid"]


def test_login_caa_aplica_fingerprint_da_conta():
    """Fingerprint persistida da conta: o client do CAA loga com o MESMO
    aparelho (device/hardware, uuids, user-agent, locale, fuso) — cada conta
    com identidade própria, sem o device padrão compartilhado do fork."""
    if not _com_instagrapi():
        return
    from app.publishing.core.fingerprint import gerar_fingerprint  # noqa: PLC0415

    fp = gerar_fingerprint("en_US", "America/New_York")
    dados = json.loads(fp)
    caa_client_capturado = []

    def login_do_caa(client, username, password):
        caa_client_capturado.append(client)
        client.authorization_data = {"ds_user_id": "1", "user": username}
        return True

    factory, _ = _factory_legado(sucesso_na_versao=None, login_do_caa=login_do_caa)
    adapter = InstagramAdapter(client_factory=factory)
    session = adapter.login(_ctx(fingerprint=fp))
    assert session is not None

    settings = caa_client_capturado[0].get_settings()
    assert settings["device_settings"]["model"] == dados["device_settings"]["model"]
    assert settings["device_settings"]["cpu"] == dados["device_settings"]["cpu"]
    assert settings["uuids"]["uuid"] == dados["uuids"]["uuid"]
    assert settings["user_agent"] == dados["user_agent"]
    assert settings["locale"] == "en_US"
    assert settings["timezone_offset"] == dados["timezone_offset"]
    assert settings["timezone_name"] == "America/New_York"


def test_login_caa_sem_fingerprint_segue_com_device_padrao():
    """Sem fingerprint na conta, o client do CAA segue com o device padrão do
    fork — comportamento antigo preservado."""
    if not _com_instagrapi():
        return
    caa_client_capturado = []

    def login_do_caa(client, username, password):
        caa_client_capturado.append(client)
        client.authorization_data = {"ds_user_id": "1", "user": username}
        return True

    factory, _ = _factory_legado(sucesso_na_versao=None, login_do_caa=login_do_caa)
    adapter = InstagramAdapter(client_factory=factory)
    session = adapter.login(_ctx(fingerprint=None))
    assert session is not None
    settings = caa_client_capturado[0].get_settings()
    assert settings["locale"] == "en_US"  # device padrão do fork (locale en_US)


def test_login_caa_throttle_nao_anexa_pendente():
    """429 segue sendo throttle puro: sem estado pendente anexado."""
    if not _com_instagrapi():
        return
    factory, _ = _factory_legado(sucesso_na_versao=None, erro_do_caa=ClientThrottledError("429"))
    adapter = InstagramAdapter(client_factory=factory)
    try:
        adapter.login(_ctx())
        raise AssertionError("deveria ter levantado")
    except AdapterError as exc:
        assert "429" in str(exc)
        assert getattr(exc, "pending_login_data", None) is None


def test_extract_context_tolerante_acha_mapa_antes_do_app_id():
    """O formato novo do Instagram põe o app do code_entry DEPOIS do mapa f4i;
    a extração tolerante acha o context_data mesmo assim (e a exata não)."""
    if not _com_instagrapi():
        return
    from app.publishing.platforms.instagram import _default_client_factory  # noqa: PLC0415
    from instagrapi.mixins.bloks import AP_2SV_CODE_ENTRY  # noqa: PLC0415

    client = _default_client_factory(None)
    blobs = {
        "payload": (
            '(f4i (dkc "chave" "context_data") (dkc "valor" "TOKEN_DO_DESAFIO_123")) '
            '"com.bloks.www.ap.two_step_verification.code_entry"'
        )
    }
    assert client._extract_context_tolerante(blobs) == "TOKEN_DO_DESAFIO_123"
    assert not client.bloks_extract_context_data(blobs, AP_2SV_CODE_ENTRY)


def test_extrair_audio_id_do_link():
    from app.publishing.platforms.instagram import extrair_audio_id_do_link

    assert extrair_audio_id_do_link("https://www.instagram.com/reels/audio/27428515753468092/") == "27428515753468092"
    assert extrair_audio_id_do_link("https://www.instagram.com/reels/audio/27428515753468092") == "27428515753468092"
    assert extrair_audio_id_do_link("instagram.com/reels/audio/123/") == "123"
    assert extrair_audio_id_do_link("https://www.instagram.com/reel/ABC123/") is None
    assert extrair_audio_id_do_link("") is None


class StubTrackClient:
    """Client fake só para fetch_audio_por_link: set_settings + track_info_by_id."""

    def __init__(self, pagina):
        self.pagina = pagina
        self.settings = None

    def set_settings(self, s):
        self.settings = s

    def track_info_by_id(self, track_id):
        assert str(track_id) == "27428515753468092"
        return self.pagina


def _pagina_som_original():
    return {
        "metadata": {
            "original_sound_info": {
                "audio_asset_id": "27428515753468092",
                "original_audio_title": "Original audio",
                "duration_in_ms": 8543,
                "progressive_download_url": "https://cdn.example/o1/v/t2/f2/m86/TOKEN",
                "ig_artist": {"username": "luisguilherrrme", "profile_pic_url": "https://cdn.example/pic.jpg"},
            }
        }
    }


def test_fetch_audio_por_link_som_original():
    from app.publishing.platforms.instagram import fetch_audio_por_link

    dados = fetch_audio_por_link(
        "https://www.instagram.com/reels/audio/27428515753468092/",
        '{"x": 1}',
        client_factory=lambda proxy: StubTrackClient(_pagina_som_original()),
    )
    assert dados["download_url"] == "https://cdn.example/o1/v/t2/f2/m86/TOKEN"
    assert dados["original"] is True
    assert dados["artista"] == "luisguilherrrme"
    assert "luisguilherrrme" in dados["titulo"]  # título genérico vira @artista


def test_fetch_audio_por_link_musica_licenciada():
    from app.publishing.platforms.instagram import fetch_audio_por_link

    pagina = {
        "metadata": {
            "music_info": {
                "music_asset_info": {
                    "title": "Música Viral",
                    "display_artist": "Artista Universal",
                    "duration_in_ms": 30000,
                }
            }
        }
    }
    dados = fetch_audio_por_link(
        "https://www.instagram.com/reels/audio/27428515753468092/",
        "{}",
        client_factory=lambda proxy: StubTrackClient(pagina),
    )
    assert dados["download_url"] is None
    assert dados["original"] is False
    assert dados["titulo"] == "Música Viral"
    assert dados["artista"] == "Artista Universal"


def test_fetch_audio_por_link_url_invalida():
    from app.publishing.platforms.instagram import fetch_audio_por_link

    try:
        fetch_audio_por_link("https://www.instagram.com/reel/ABC/", "{}", client_factory=lambda p: None)
        raise AssertionError("deveria ter levantado")
    except AdapterError as exc:
        assert "link inválido" in str(exc)


def test_login_usa_versao_configurada_do_operador(monkeypatch):
    """INSTAGRAM_APP_VERSION configurada: no plano B legado, o adapter registra
    a versão no APP_SETTINGS do fork, tenta SÓ ela (sem queimar as versões
    antigas) e monta o User-Agent com a versão/código do operador."""
    if not _com_instagrapi():
        return
    import instagrapi.config as ig_config  # noqa: PLC0415

    monkeypatch.setattr(settings, "instagram_app_version", "446.0.0.28.66")
    monkeypatch.setattr(settings, "instagram_app_version_code", "1060018354")
    try:
        factory, criados = _factory_legado(sucesso_na_versao="446.0.0.28.66")
        adapter = InstagramAdapter(client_factory=factory)
        session = adapter.login(_ctx())
        assert session is not None
        assert json.loads(session)["authorization_data"]["user"] == "perfil01"
        # inicial (reaproveitado no legado) + CAA — uma única tentativa legada
        assert len(criados) == 2
        assert getattr(criados[0], "skip_caa_login")
        assert not getattr(criados[1], "skip_caa_login", False)
        # User-Agent montado com a versão/código do operador
        assert "446.0.0.28.66" in criados[0].user_agent
        assert "1060018354" in criados[0].user_agent
    finally:
        monkeypatch.delitem(ig_config.APP_SETTINGS, "446.0.0.28.66", raising=False)


def test_login_operador_rejeitada_e_caa_falhou_erro_claro(monkeypatch):
    """Versão do operador também rejeitada no legado (com CAA já falho) → erro
    claro, sem queimar as 4 versões antigas do fork."""
    if not _com_instagrapi():
        return
    import instagrapi.config as ig_config  # noqa: PLC0415

    monkeypatch.setattr(settings, "instagram_app_version", "446.0.0.28.66")
    monkeypatch.setattr(settings, "instagram_app_version_code", "1060018354")
    try:
        factory, criados = _factory_legado(sucesso_na_versao=None)
        adapter = InstagramAdapter(client_factory=factory)
        try:
            adapter.login(_ctx())
            raise AssertionError("deveria ter levantado")
        except AdapterError as exc:
            assert "needs_upgrade" in str(exc)
        # inicial (legado com a versão do operador) + CAA — sem as 4 antigas
        assert len(criados) == 2
    finally:
        monkeypatch.delitem(ig_config.APP_SETTINGS, "446.0.0.28.66", raising=False)


def test_login_ignora_versao_configurada_sem_code(monkeypatch):
    """INSTAGRAM_APP_VERSION sem o _CODE: configuração incompleta é ignorada
    (aviso no log) e o plano B usa a lista completa do fork."""
    if not _com_instagrapi():
        return
    monkeypatch.setattr(settings, "instagram_app_version", "446.0.0.28.66")
    monkeypatch.setattr(settings, "instagram_app_version_code", "")
    factory, criados = _factory_legado(sucesso_na_versao="428.0.0.47.67")
    adapter = InstagramAdapter(client_factory=factory)
    session = adapter.login(_ctx())
    assert session is not None
    # inicial (446 falha) + CAA + 428 ok — lista completa do fork, sem override
    assert len(criados) == 3


if __name__ == "__main__":
    for nome, fn in sorted(globals().items()):
        if nome.startswith("test_") and callable(fn):
            fn()
            print(f"{nome} ok")
    print(">>> INSTAGRAM ADAPTER (transporte fake) OK")
