"""PlatformAdapter: fronteira entre o núcleo (contas, conteúdo, agendamento,
aprovação, distribuição) e uma plataforma concreta.

O núcleo nunca deve conhecer botão/seletor/URL/endpoint de uma rede social —
isso vive exclusivamente dentro de cada adapter concreto (ex.: instagram.py).
Isso é o que permite adicionar TikTok, YouTube Shorts etc. sem reescrever o
resto do sistema.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from urllib.parse import quote


class AdapterError(Exception):
    """Erro recuperável do adapter (upload falhou, elemento não apareceu, etc.)."""


class SessionExpiredError(AdapterError):
    """A sessão da conta não é mais válida — precisa de reautenticação manual."""


class ThrottledError(AdapterError):
    """A plataforma limitou as tentativas (rate limit/429). Recuperável, mas exige
    espera — re-tentar na hora só piora o bloqueio."""


def build_proxy_url(proxy: dict | None) -> str | None:
    """Converte o dict de proxy do núcleo na URL de transporte esperada pela
    automação (ex.: 'socks5://usuario:senha@host:porta')."""
    if not proxy or not proxy.get("host"):
        return None
    protocolo = proxy.get("protocol") or "socks5"
    host = proxy["host"]
    porta = proxy.get("port")
    auth = ""
    if proxy.get("username"):
        senha = proxy.get("password") or ""
        auth = f"{quote(str(proxy['username']))}:{quote(str(senha))}@"
    return f"{protocolo}://{auth}{host}:{porta}"


@dataclass
class PublishContext:
    """Tudo que um adapter precisa para publicar 1 Content numa Account."""

    account_username: str
    account_password: str | None  # descriptografado só em memória, na hora do uso (ver security.py)
    session_data: str | None
    proxy: dict | None  # {"protocol", "host", "port", "username", "password"} ou None
    media_path: str
    caption: str | None
    audio_reference: str | None
    kind: str  # 'reel' | 'story'
    story_text: str | None = None
    story_link: str | None = None
    # posição do link/sticker do story: 'superior' | 'meio' | 'inferior' (None = padrão do adapter)
    story_link_posicao: str | None = None
    story_text_extra: str | None = None
    # código de verificação (2FA/desafio) informado pelo operador na hora do login
    verification_code: str | None = None
    # cookie de sessão (sessionid) colado pelo operador — permite login sem o fluxo
    # de senha/CAA, que é o que o Instagram costuma responder com 429.
    sessionid: str | None = None
    # estado de login pendente (device ids do desafio CAA anterior) — o retry com o
    # código de verificação precisa reusar o MESMO device para o código valer.
    pending_login_data: str | None = None
    # stories com várias imagens em sequência: todos os caminhos na ordem (media_path é o primeiro)
    media_paths: list[str] = field(default_factory=list)


@dataclass
class PublishResult:
    external_id: str | None
    confirmed: bool


class PlatformAdapter(ABC):
    """Ciclo de vida completo de uma publicação, espelhando o fluxo normal do app/interface.

    Convenção de construção: todo adapter concreto aceita `proxy: dict | None` como
    keyword argument — o contexto de execução (e o proxy) é POR CONTA, nunca compartilhado.
    """

    name: str

    def __init__(self, *, proxy: dict | None = None) -> None:
        self._proxy = proxy

    @abstractmethod
    def open(self) -> None:
        """Abre/prepara o contexto de execução (browser/app context) para esta conta."""

    @abstractmethod
    def login(self, ctx: PublishContext) -> str | None:
        """Autentica e devolve o session_data atualizado (ou levanta SessionExpiredError)."""

    @abstractmethod
    def check_session(self, ctx: PublishContext) -> bool:
        """True se a sessão atual ainda é válida (sem precisar logar de novo)."""

    @abstractmethod
    def create_reel(self, ctx: PublishContext) -> None: ...

    @abstractmethod
    def set_caption(self, ctx: PublishContext) -> None: ...

    @abstractmethod
    def select_audio(self, ctx: PublishContext) -> None: ...

    @abstractmethod
    def publish(self, ctx: PublishContext) -> PublishResult: ...

    @abstractmethod
    def create_story(self, ctx: PublishContext) -> None: ...

    @abstractmethod
    def attach_link(self, ctx: PublishContext) -> None: ...

    @abstractmethod
    def confirm_publication(self, ctx: PublishContext, result: PublishResult) -> bool:
        """Confirma que a publicação REALMENTE concluiu — iniciar o upload não basta."""

    @abstractmethod
    def close(self) -> None:
        """Libera o contexto de execução desta conta."""
