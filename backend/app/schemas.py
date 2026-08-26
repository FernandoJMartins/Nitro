"""Schemas de entrada/saída da API (Pydantic)."""
from datetime import datetime

from pydantic import BaseModel, ConfigDict


# ---------- Auth ----------
class UserCreate(BaseModel):
    email: str
    senha: str


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: str
    criado_em: datetime


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"


class ApiKeyCreate(BaseModel):
    nome: str = "Minha chave"


class ApiKeyOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    nome: str
    prefixo: str
    ativo: bool
    criado_em: datetime


class ApiKeyCreated(ApiKeyOut):
    chave: str  # a chave crua — mostrada só uma vez, na criação


class MediaOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    tipo: str
    folder_id: int | None
    nome_original: str
    caminho: str
    duracao: float | None
    tamanho_bytes: int
    metadados_removidos: bool
    is_trending: bool
    observacao: str | None
    criado_em: datetime


# ---------- Pastas ----------
class FolderCreate(BaseModel):
    nome: str


class FolderOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    nome: str
    criado_em: datetime


# ---------- Tipos de frase ----------
class PhraseTypeCreate(BaseModel):
    nome: str
    descricao: str | None = None


class PhraseTypeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    nome: str
    descricao: str | None
    criado_em: datetime


# ---------- Frases ----------
class PhraseCreate(BaseModel):
    phrase_type_id: int
    texto: str


class PhraseOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    phrase_type_id: int
    texto: str
    origem: str
    criado_em: datetime


# ---------- IA ----------
class AIGenerateRequest(BaseModel):
    phrase_type_id: int
    quantidade: int = 5
    instrucao_extra: str | None = None


class AIGenerateResponse(BaseModel):
    frases: list[str]
    modelo: str
    baseado_em: int  # quantas frases existentes serviram de exemplo


class PhraseBulkSave(BaseModel):
    phrase_type_id: int
    textos: list[str]
    origem: str = "ia"


# ---------- Geração em massa (Fase 5) ----------
class BulkRequest(BaseModel):
    quantidade: int = 5
    base_media_ids: list[int]
    music_media_ids: list[int] = []
    hot_media_ids: list[int] = []
    phrase_type_id: int | None = None   # pool de textos (lista do usuário)
    use_ia_texto: bool = False          # IA gera os textos no lugar da lista
    gerar_legenda_ia: bool = False      # legenda da postagem por IA (opcional)
    # duração é um RANGE: cada vídeo pega um valor aleatório entre min e max.
    duration_min: float = 5.0
    duration_max: float = 15.0
    use_flash: bool = False


class JobOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    status: str
    total: int
    concluidos: int
    erro: str | None
    criado_em: datetime


class GeneratedVideoOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    job_id: int | None
    caminho: str
    duracao: float
    texto: str | None
    legenda: str | None
    usou_flash: bool
    criado_em: datetime
