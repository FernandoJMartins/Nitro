"""Tabelas do banco de dados.

Nesta fase (1) só existe a tabela `media`. Users, frases, jobs, videos e
api_keys entram nas próximas fases (ver roadmap no README).
"""
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    senha_hash: Mapped[str] = mapped_column(String(255))
    criado_em: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class ApiKey(Base):
    """Chave de API de um usuário, para integração externa."""

    __tablename__ = "api_keys"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    nome: Mapped[str] = mapped_column(String(100), default="Minha chave")
    chave_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)  # sha256 hex
    prefixo: Mapped[str] = mapped_column(String(16))  # ex.: "nitro_ab12cd" (para exibição)
    ativo: Mapped[bool] = mapped_column(Boolean, default=True)
    criado_em: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class Media(Base):
    __tablename__ = "media"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)

    # user_id fica nullable por enquanto (auth chega na Fase 7).
    user_id: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # tipo: 'video' | 'photo' | 'music'
    tipo: Mapped[str] = mapped_column(String(16), index=True)

    # caminho RELATIVO dentro de STORAGE_DIR (ex.: "video/42_abc.mp4").
    caminho: Mapped[str] = mapped_column(String(512))
    nome_original: Mapped[str] = mapped_column(String(512))

    duracao: Mapped[float | None] = mapped_column(Float, nullable=True)  # segundos (áudio/vídeo)
    tamanho_bytes: Mapped[int] = mapped_column(Integer, default=0)
    metadados_removidos: Mapped[bool] = mapped_column(Boolean, default=False)

    # marca músicas "em alta" na lista curada manual.
    is_trending: Mapped[bool] = mapped_column(Boolean, default=False, index=True)

    observacao: Mapped[str | None] = mapped_column(Text, nullable=True)
    criado_em: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class PhraseType(Base):
    """Tipo/categoria de frase (ex.: FLIRT, SARCASMIC). Frases ficam DENTRO do vídeo."""

    __tablename__ = "phrase_types"
    # o mesmo nome pode existir para usuários diferentes, mas é único por usuário.
    __table_args__ = (UniqueConstraint("user_id", "nome", name="uq_phrase_type_user_nome"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    nome: Mapped[str] = mapped_column(String(64), index=True)
    descricao: Mapped[str | None] = mapped_column(Text, nullable=True)
    criado_em: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    phrases: Mapped[list["Phrase"]] = relationship(
        back_populates="phrase_type", cascade="all, delete-orphan"
    )


class Phrase(Base):
    """Uma frase que aparece dentro do vídeo. origem = 'manual' ou 'ia'."""

    __tablename__ = "phrases"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    phrase_type_id: Mapped[int] = mapped_column(
        ForeignKey("phrase_types.id", ondelete="CASCADE"), index=True
    )
    texto: Mapped[str] = mapped_column(Text)
    origem: Mapped[str] = mapped_column(String(8), default="manual")  # 'manual' | 'ia'
    criado_em: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    phrase_type: Mapped["PhraseType"] = relationship(back_populates="phrases")


class Job(Base):
    """Um lote de geração em massa. Acompanha o progresso (concluidos/total)."""

    __tablename__ = "jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # status: 'fila' | 'processando' | 'concluido' | 'erro'
    status: Mapped[str] = mapped_column(String(16), default="fila", index=True)
    total: Mapped[int] = mapped_column(Integer, default=0)
    concluidos: Mapped[int] = mapped_column(Integer, default=0)
    erro: Mapped[str | None] = mapped_column(Text, nullable=True)
    criado_em: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    videos: Mapped[list["GeneratedVideo"]] = relationship(back_populates="job")


class GeneratedVideo(Base):
    """Um vídeo gerado (alimenta o Histórico — Fase 6)."""

    __tablename__ = "generated_videos"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    job_id: Mapped[int | None] = mapped_column(
        ForeignKey("jobs.id", ondelete="SET NULL"), nullable=True, index=True
    )
    caminho: Mapped[str] = mapped_column(String(512))  # relativo a STORAGE_DIR
    duracao: Mapped[float] = mapped_column(Float, default=0.0)
    texto: Mapped[str | None] = mapped_column(Text, nullable=True)      # texto no vídeo
    legenda: Mapped[str | None] = mapped_column(Text, nullable=True)    # legenda da postagem
    usou_flash: Mapped[bool] = mapped_column(Boolean, default=False)
    criado_em: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    job: Mapped["Job | None"] = relationship(back_populates="videos")
