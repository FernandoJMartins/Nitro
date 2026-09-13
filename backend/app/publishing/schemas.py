"""Schemas de entrada/saída do módulo de Publicação Automatizada Multicontas."""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict


# ---------- Proxies ----------
class ProxyCreate(BaseModel):
    nome_interno: str | None = None  # vazio = padrão host:porta
    protocolo: str = "socks5"
    host: str
    porta: int
    usuario: str | None = None
    senha: str | None = None


class ProxyUpdate(BaseModel):
    """Edição de proxy: só os campos enviados mudam; senha em branco mantém a atual."""

    nome_interno: str | None = None
    protocolo: str | None = None
    host: str | None = None
    porta: int | None = None
    usuario: str | None = None
    senha: str | None = None


class ProxyOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    nome_interno: str
    protocolo: str
    host: str
    porta: int
    usuario: str | None
    status: str
    latencia_ms: float | None
    ip_publico: str | None
    ultimo_check_em: datetime | None
    ultimo_erro: str | None
    criado_em: datetime


# ---------- Contas ----------
class AccountCreate(BaseModel):
    nome_interno: str
    username: str
    platform: str = "instagram"
    # senha em texto puro só nesta requisição — é criptografada antes de salvar
    # (ver security.encrypt_secret) e nunca é devolvida pela API.
    senha: str | None = None
    # cookie de sessão do navegador — alternativa à senha que contorna o fluxo
    # de login (senha/CAA) que o Instagram costuma responder com 429.
    sessionid: str | None = None
    proxy_id: int | None = None
    posts_por_hora: int | None = None
    janela_inicio: str | None = None
    janela_fim: str | None = None
    timezone: str | None = None
    caption_mode: str = "automatica"
    audio_mode: str = "nenhum"
    stories_enabled: bool = False


class AccountUpdate(BaseModel):
    nome_interno: str | None = None
    username: str | None = None
    status: str | None = None
    senha: str | None = None
    sessionid: str | None = None
    proxy_id: int | None = None
    posts_por_hora: int | None = None
    janela_inicio: str | None = None
    janela_fim: str | None = None
    timezone: str | None = None
    caption_mode: str | None = None
    audio_mode: str | None = None
    stories_enabled: bool | None = None
    automation_status: str | None = None
    session_data: str | None = None


class ConnectRequest(BaseModel):
    """Login real da conta — código de verificação opcional para 2FA/desafio."""

    verification_code: str | None = None


class ProxyOutBase(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    nome_interno: str
    status: str


class AccountOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    nome_interno: str
    username: str
    platform: str
    status: str
    senha_configurada: bool
    sessionid_configurada: bool
    session_configurada: bool
    proxy_id: int | None
    posts_por_hora: int | None
    janela_inicio: str | None
    janela_fim: str | None
    timezone: str | None
    caption_mode: str
    audio_mode: str
    stories_enabled: bool
    automation_status: str
    ultimo_acesso_em: datetime | None
    ultimo_post_em: datetime | None
    ultimo_erro: str | None
    ultimo_erro_em: datetime | None
    criado_em: datetime
    proxy: ProxyOutBase | None = None


class PublishingDefaultsUpdate(BaseModel):
    posts_por_hora: int
    janela_inicio: str
    janela_fim: str
    timezone: str


class PublishingDefaultsOut(PublishingDefaultsUpdate):
    model_config = ConfigDict(from_attributes=True)


# ---------- Legendas ----------
class CaptionCreate(BaseModel):
    titulo: str
    texto: str
    account_id: int | None = None


class CaptionUpdate(BaseModel):
    titulo: str | None = None
    texto: str | None = None
    ativo: bool | None = None
    account_id: int | None = None


class CaptionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    titulo: str
    texto: str
    ativo: bool
    account_id: int | None
    criado_em: datetime


# ---------- Áudios ----------
class AudioCreate(BaseModel):
    nome: str
    provider: str = "manual"
    platform: str = "instagram"
    external_id: str | None = None
    referencia: str | None = None
    popularidade: int | None = None


class AudioOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    nome: str
    provider: str
    platform: str
    external_id: str | None
    referencia: str | None
    popularidade: int | None
    status: str
    coletado_em: datetime


# ---------- Stories ----------
class StoryFrameUpdate(BaseModel):
    media_id: int
    texto: str | None = None
    link: str | None = None


class StoryPlanUpdate(BaseModel):
    horario: str
    # texto/link/posição do link/texto extra do story inteiro (1 story = 1 texto, 1 link)
    texto: str | None = None
    link: str | None = None
    link_posicao: str | None = None  # 'superior' | 'meio' | 'inferior'
    texto_extra: str | None = None
    frames: list[StoryFrameUpdate] = []


class StoryConfigUpdate(BaseModel):
    enabled: bool
    imagem_media_id: int | None = None
    texto: str | None = None
    link: str | None = None
    horario: str = "18:00"
    plans: list[StoryPlanUpdate] | None = None  # None = não mexer nos plans existentes


class StoryPlanOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    horario: str
    ordem: int
    media_ids: list[int]
    texto: str | None
    link: str | None
    link_posicao: str | None
    texto_extra: str | None
    ultima_geracao_em: datetime | None


class StoryConfigOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    account_id: int
    enabled: bool
    imagem_media_id: int | None
    texto: str | None
    link: str | None
    horario: str
    ultima_geracao_em: datetime | None
    plans: list[StoryPlanOut] = []


# ---------- Conteúdo / aprovação ----------
class ContentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    kind: str
    origem: str
    generated_video_id: int | None
    caminho: str
    duracao: float | None
    legenda: str | None
    link: str | None
    audio_id: int | None
    account_id: int | None
    approval_status: str
    schedule_mode: str
    scheduled_at: datetime | None
    criado_em: datetime


class ImportFromGeneratorRequest(BaseModel):
    generated_video_ids: list[int]
    auto_distribute: bool = True


class ApprovalAction(BaseModel):
    ids: list[int]


class ContentEdit(BaseModel):
    legenda: str | None = None
    account_id: int | None = None
    audio_id: int | None = None


class RescheduleRequest(BaseModel):
    scheduled_at: datetime


class PublicationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    content_id: int
    account_id: int
    status: str
    tentativas: int
    scheduled_at: datetime
    iniciado_em: datetime | None
    confirmado_em: datetime | None
    falhou_em: datetime | None
    erro: str | None


class CalendarItem(BaseModel):
    publication_id: int
    content_id: int
    account_id: int
    account_username: str
    kind: str
    status: str
    scheduled_at: datetime
    caminho: str


class AccountErrorOut(BaseModel):
    account_id: int
    username: str
    erro: str
    em: datetime | None


class DashboardOut(BaseModel):
    aguardando_aprovacao: int
    aprovados: int
    agendados_hoje: int
    publicados_hoje: int
    falhas_hoje: int
    contas_ativas: int
    contas_total: int
    proxies_ativos: int
    proxies_inativos: int
    proxies_total: int
    stories_hoje: int
    stories_configuradas: int
    sessoes_validas: int
    sessoes_expiradas: int
    em_execucao: int
    retries: int
    ultimos_erros: list[AccountErrorOut]


class TimelineItem(BaseModel):
    horario: datetime
    account_username: str
    status: str
    kind: str


class LogOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    account_id: int | None
    publication_id: int | None
    nivel: str
    mensagem: str
    criado_em: datetime
