"""Modelos do módulo de Publicação Automatizada Multicontas.

Núcleo desacoplado de plataforma: Account, Content, Publication, Proxy,
CaptionTemplate, AudioAsset, StoryConfig, PublicationLog. O Instagram é só o
primeiro PlatformAdapter (ver app/publishing/platforms) — nenhum detalhe de
botão/seletor/URL de rede social deve vazar para cá.
"""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..database import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Proxy(Base):
    """Proxy opcional de uma conta. Nunca compartilhado automaticamente entre contas."""

    __tablename__ = "pub_proxies"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, index=True)
    nome_interno: Mapped[str] = mapped_column(String(100))  # rótulo amigável exibido na UI (padrão: host:porta)
    protocolo: Mapped[str] = mapped_column(String(16), default="socks5")
    host: Mapped[str] = mapped_column(String(255))
    porta: Mapped[int] = mapped_column(Integer)
    usuario: Mapped[str | None] = mapped_column(String(255), nullable=True)
    senha: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # status: 'verde' | 'amarelo' | 'vermelho' | 'cinza' (nunca checado)
    status: Mapped[str] = mapped_column(String(16), default="cinza")
    latencia_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    ip_publico: Mapped[str | None] = mapped_column(String(64), nullable=True)
    ultimo_check_em: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ultimo_erro: Mapped[str | None] = mapped_column(Text, nullable=True)

    criado_em: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Account(Base):
    """Uma conta/perfil numa plataforma. Cada conta tem sua própria fila lógica (AccountWorker)."""

    __tablename__ = "pub_accounts"
    __table_args__ = (
        UniqueConstraint("user_id", "platform", "username", name="uq_pub_account_user_platform_username"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, index=True)

    nome_interno: Mapped[str] = mapped_column(String(100))
    username: Mapped[str] = mapped_column(String(100))
    platform: Mapped[str] = mapped_column(String(32), default="instagram", index=True)

    # status: 'rascunho' | 'conectando' | 'pronta' | 'pausada' | 'erro'
    status: Mapped[str] = mapped_column(String(16), default="rascunho", index=True)

    # blob opaco devolvido pelo PlatformAdapter (cookies/tokens/etc). Núcleo não interpreta.
    session_data: Mapped[str | None] = mapped_column(Text, nullable=True)

    # estado de um login CAA incompleto (device ids do desafio de código). O retry
    # com o código de verificação reidrata esse blob para reusar o MESMO device —
    # senão o Instagram emite um código novo e o código digitado não vale. Limpo
    # quando o login conclui (com sucesso ou erro terminal).
    pending_login_data: Mapped[str | None] = mapped_column(Text, nullable=True)

    proxy_id: Mapped[int | None] = mapped_column(ForeignKey("pub_proxies.id", ondelete="SET NULL"), nullable=True)

    # senha da conta, criptografada em repouso (Fernet — ver app/security.py). Nunca
    # devolvida pela API em texto puro; guardada para quando existir um adapter real.
    senha_enc: Mapped[str | None] = mapped_column(Text, nullable=True)

    # cookie de sessão (sessionid) colado pelo operador — criptografado em repouso
    # como a senha. Permite conectar ignorando o fluxo de login (que leva 429).
    sessionid_enc: Mapped[str | None] = mapped_column(Text, nullable=True)

    # override do PublishingDefaults do usuário quando setado (null = usa o padrão global)
    posts_por_hora: Mapped[int | None] = mapped_column(Integer, nullable=True)
    janela_inicio: Mapped[str | None] = mapped_column(String(5), nullable=True)  # "HH:MM"
    janela_fim: Mapped[str | None] = mapped_column(String(5), nullable=True)
    timezone: Mapped[str | None] = mapped_column(String(64), nullable=True)

    caption_mode: Mapped[str] = mapped_column(String(16), default="automatica")  # 'manual' | 'automatica'
    audio_mode: Mapped[str] = mapped_column(String(16), default="nenhum")  # 'manual' | 'automatica' | 'nenhum'
    stories_enabled: Mapped[bool] = mapped_column(Boolean, default=False)

    # conta desativada pelo operador: não participa de distribuição, não agenda e
    # não publica nada (nem story nem reel) enquanto estiver desativada. Independe
    # de automation_status, que é o estado interno do worker (ociosa/pausada/erro).
    ativa: Mapped[bool] = mapped_column(Boolean, default=True)

    # automação: 'ociosa' | 'pausada' | 'erro' — controla se o worker pode processar a fila
    automation_status: Mapped[str] = mapped_column(String(16), default="ociosa")

    ultimo_acesso_em: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ultimo_post_em: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ultimo_erro: Mapped[str | None] = mapped_column(Text, nullable=True)
    ultimo_erro_em: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    criado_em: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    proxy: Mapped["Proxy | None"] = relationship()

    @property
    def senha_configurada(self) -> bool:
        return bool(self.senha_enc)

    @property
    def sessionid_configurada(self) -> bool:
        return bool(self.sessionid_enc)

    @property
    def session_configurada(self) -> bool:
        return bool(self.session_data)


class PublishingDefaults(Base):
    """Configuração global do usuário (posts/hora e janela padrão). Cada conta pode sobrepor."""

    __tablename__ = "pub_defaults"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, unique=True, index=True)
    posts_por_hora: Mapped[int] = mapped_column(Integer, default=4)
    janela_inicio: Mapped[str] = mapped_column(String(5), default="08:00")
    janela_fim: Mapped[str] = mapped_column(String(5), default="23:00")
    timezone: Mapped[str] = mapped_column(String(64), default="America/Sao_Paulo")


class CaptionTemplate(Base):
    """Modelo de legenda. Pode ser global (account_id nulo) ou específico de um perfil."""

    __tablename__ = "pub_captions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, index=True)
    account_id: Mapped[int | None] = mapped_column(
        ForeignKey("pub_accounts.id", ondelete="CASCADE"), nullable=True, index=True
    )
    titulo: Mapped[str] = mapped_column(String(100))
    # pode conter variáveis: {{username}} {{date}} {{number}} {{random_emoji}}
    texto: Mapped[str] = mapped_column(Text)
    ativo: Mapped[bool] = mapped_column(Boolean, default=True)
    criado_em: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class AudioAsset(Base):
    """Um áudio catalogado (manual ou coletado de uma fonte de tendências, desacoplada da plataforma)."""

    __tablename__ = "pub_audios"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, index=True)
    provider: Mapped[str] = mapped_column(String(16), default="manual")  # 'manual' | 'trending'
    nome: Mapped[str] = mapped_column(String(255))
    external_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    platform: Mapped[str] = mapped_column(String(32), default="instagram")
    referencia: Mapped[str | None] = mapped_column(String(512), nullable=True)
    popularidade: Mapped[int | None] = mapped_column(Integer, nullable=True)
    coletado_em: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    status: Mapped[str] = mapped_column(String(16), default="ativo")  # 'ativo' | 'inativo'


class StoryConfig(Base):
    """Configuração de stories automáticos de uma conta: vários por dia (StoryPlan),
    cada um com N imagens em sequência (StoryFrame)."""

    __tablename__ = "pub_story_configs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int] = mapped_column(
        ForeignKey("pub_accounts.id", ondelete="CASCADE"), unique=True, index=True
    )
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    # campos legados (1 imagem / 1 horário) — mantidos para compatibilidade com
    # bancos antigos; quando existem StoryPlans, eles têm prioridade.
    imagem_media_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    texto: Mapped[str | None] = mapped_column(Text, nullable=True)
    link: Mapped[str | None] = mapped_column(String(512), nullable=True)
    horario: Mapped[str] = mapped_column(String(5), default="18:00")  # "HH:MM"
    ultima_geracao_em: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class StoryPlan(Base):
    """Um story agendado dentro de um StoryConfig — vários por dia, cada um com sua janela.

    Texto/link/posição do link/texto extra vivem AQUI (1 story = 1 texto, 1 link).
    StoryFrame.texto/link seguem existindo por compatibilidade com bancos antigos
    (quando o plano não tem valores próprios, a geração cai neles).
    """

    __tablename__ = "pub_story_plans"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    story_config_id: Mapped[int] = mapped_column(
        ForeignKey("pub_story_configs.id", ondelete="CASCADE"), index=True
    )
    horario: Mapped[str] = mapped_column(String(5), default="18:00")  # "HH:MM"
    ordem: Mapped[int] = mapped_column(Integer, default=0)
    texto: Mapped[str | None] = mapped_column(Text, nullable=True)
    link: Mapped[str | None] = mapped_column(String(512), nullable=True)
    # posição do link/sticker do story: 'superior' | 'meio' | 'inferior' (padrão de envio: inferior)
    link_posicao: Mapped[str | None] = mapped_column(String(16), nullable=True)
    texto_extra: Mapped[str | None] = mapped_column(Text, nullable=True)
    ultima_geracao_em: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    criado_em: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class StoryFrame(Base):
    """Uma imagem (frame) da sequência de um StoryPlan."""

    __tablename__ = "pub_story_frames"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    story_plan_id: Mapped[int] = mapped_column(
        ForeignKey("pub_story_plans.id", ondelete="CASCADE"), index=True
    )
    media_id: Mapped[int] = mapped_column(Integer)  # id em Media (biblioteca existente)
    ordem: Mapped[int] = mapped_column(Integer, default=0)
    texto: Mapped[str | None] = mapped_column(Text, nullable=True)
    link: Mapped[str | None] = mapped_column(String(512), nullable=True)
    criado_em: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Content(Base):
    """Um conteúdo (reel ou story) percorrendo: aprovação -> distribuição -> agendamento -> publicação."""

    __tablename__ = "pub_contents"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, index=True)

    kind: Mapped[str] = mapped_column(String(16), default="reel")  # 'reel' | 'story'
    origem: Mapped[str] = mapped_column(String(16), default="manual")  # 'manual' | 'gerador'
    generated_video_id: Mapped[int | None] = mapped_column(
        ForeignKey("generated_videos.id", ondelete="SET NULL"), nullable=True, index=True
    )

    caminho: Mapped[str] = mapped_column(String(512))  # relativo a STORAGE_DIR
    duracao: Mapped[float | None] = mapped_column(Float, nullable=True)

    legenda: Mapped[str | None] = mapped_column(Text, nullable=True)
    audio_id: Mapped[int | None] = mapped_column(ForeignKey("pub_audios.id", ondelete="SET NULL"), nullable=True)

    account_id: Mapped[int | None] = mapped_column(
        ForeignKey("pub_accounts.id", ondelete="SET NULL"), nullable=True, index=True
    )
    link: Mapped[str | None] = mapped_column(String(512), nullable=True)  # link clicável (stories)
    # posição do link do story ('superior' | 'meio' | 'inferior') — snapshot no momento da geração
    link_posicao: Mapped[str | None] = mapped_column(String(16), nullable=True)
    texto_extra: Mapped[str | None] = mapped_column(Text, nullable=True)  # texto extra opcional do story

    approval_status: Mapped[str] = mapped_column(String(16), default="pendente", index=True)
    # 'pendente' | 'aprovado' | 'rejeitado'

    schedule_mode: Mapped[str] = mapped_column(String(16), default="automatico")  # 'automatico' | 'especifico'
    scheduled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)

    criado_em: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    atualizado_em: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)

    account: Mapped["Account | None"] = relationship()
    media: Mapped[list["ContentMedia"]] = relationship(
        back_populates="content", cascade="all, delete-orphan", order_by="ContentMedia.ordem"
    )
    publications: Mapped[list["Publication"]] = relationship(
        back_populates="content", cascade="all, delete-orphan"
    )


class ContentMedia(Base):
    """Mídias adicionais de um Content (story com várias imagens em sequência)."""

    __tablename__ = "pub_content_media"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    content_id: Mapped[int] = mapped_column(
        ForeignKey("pub_contents.id", ondelete="CASCADE"), index=True
    )
    caminho: Mapped[str] = mapped_column(String(512))  # relativo a STORAGE_DIR
    ordem: Mapped[int] = mapped_column(Integer, default=0)
    criado_em: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    content: Mapped["Content"] = relationship(back_populates="media")


class Publication(Base):
    """Execução de UM Content em UMA conta. Iniciar o upload não é o mesmo que estar publicado —
    só PUBLISHED depois de o adapter confirmar de verdade.
    """

    __tablename__ = "pub_publications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    content_id: Mapped[int] = mapped_column(ForeignKey("pub_contents.id", ondelete="CASCADE"), index=True)
    account_id: Mapped[int] = mapped_column(ForeignKey("pub_accounts.id", ondelete="CASCADE"), index=True)

    # PENDING | UPLOADING | PROCESSING | PUBLISHED | FAILED | RETRYING | CANCELLED
    status: Mapped[str] = mapped_column(String(16), default="PENDING", index=True)
    tentativas: Mapped[int] = mapped_column(Integer, default=0)
    proxy_id_usado: Mapped[int | None] = mapped_column(Integer, nullable=True)

    scheduled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    iniciado_em: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    upload_concluido_em: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    confirmado_em: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    falhou_em: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    erro: Mapped[str | None] = mapped_column(Text, nullable=True)

    criado_em: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    atualizado_em: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)

    content: Mapped["Content"] = relationship(back_populates="publications")
    account: Mapped["Account"] = relationship()


class PublicationLog(Base):
    """Log de auditoria por conta e/ou por publicação."""

    __tablename__ = "pub_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    account_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    publication_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    nivel: Mapped[str] = mapped_column(String(16), default="info")  # 'info' | 'aviso' | 'erro'
    mensagem: Mapped[str] = mapped_column(Text)
    criado_em: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, index=True)
