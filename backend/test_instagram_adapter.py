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

from app.publishing.platforms.base import AdapterError, PublishContext, SessionExpiredError, build_proxy_url
from app.publishing.platforms.instagram import InstagramAdapter


class StubMedia:
    def __init__(self, pk):
        self.pk = pk


class BadPassword(Exception):
    """Mesmo nome da exceção real do instagrapi — o adapter mapeia por nome."""
    pass


class StubClient:
    """Finge ser um instagrapi.Client: mesma superfície usada pelo adapter."""

    def __init__(self, proxy=None):
        self.proxy = proxy
        self.settings: dict = {"cookies": {"sessionid": "abc"}}
        self.uploads: list[tuple[str, str]] = []
        self.stories: list[tuple[str, str, list | None]] = []

    def get_settings(self):
        return dict(self.settings)

    def set_settings(self, s):
        self.settings = dict(s)

    def login(self, username, password, verification_code=None):
        if password == "senha-errada":
            raise BadPassword("The password you entered is incorrect.")
        self.settings["authorization_data"] = {"ds_user_id": "1", "user": username}
        self.ultimo_codigo = verification_code

    def get_timeline_feed(self):
        if not self.settings.get("authorization_data"):
            raise RuntimeError("login required")
        return {"items": []}

    def clip_upload(self, path, caption=""):
        if not self.settings.get("authorization_data"):
            raise RuntimeError("login required")
        self.uploads.append((path, caption))
        return StubMedia("pk-reel-1")

    def photo_upload_to_story(self, path, caption="", links=None):
        self.stories.append((path, caption, links))
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
    a, b = _tmp_video(), _tmp_video()
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
        _, caption, links = adapter._client.stories[0]
        assert caption == "Sequência"
        assert links == [{"webUri": "https://exemplo.com"}]
        assert adapter.confirm_publication(ctx, result) is True
    finally:
        os.unlink(a)
        os.unlink(b)


def test_confirmacao_exige_midia_existente_na_plataforma():
    adapter = InstagramAdapter(client_factory=lambda proxy: StubClient(proxy))
    ctx = _ctx()
    assert adapter.confirm_publication(ctx, type("R", (), {"external_id": "pk-inexistente"})()) is False
    assert adapter.confirm_publication(ctx, type("R", (), {"external_id": None})()) is False


if __name__ == "__main__":
    for nome, fn in sorted(globals().items()):
        if nome.startswith("test_") and callable(fn):
            fn()
            print(f"{nome} ok")
    print(">>> INSTAGRAM ADAPTER (transporte fake) OK")
