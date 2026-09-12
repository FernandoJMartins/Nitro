"""Ponto de entrada da API (FastAPI)."""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import inspect, text

from .config import settings
from .database import Base, engine
from .publishing import models as pub_models  # noqa: F401 — registra as tabelas em Base.metadata
from .publishing.core.workers import start_background_scheduler
from .routers import auth, folders, media, phrases, pub_accounts, pub_content, pub_dashboard, upscale, videos

# Cria as tabelas que ainda não existem. (Em produção, trocar por migrations/Alembic.)
Base.metadata.create_all(bind=engine)


def _ensure_column(table: str, column: str, ddl_type: str) -> None:
    """Mini-migração idempotente: adiciona uma coluna nova a uma tabela já existente.

    Como o projeto usa create_all (sem Alembic), bancos antigos não ganham colunas
    novas automaticamente. Isso cobre esse caso sem quebrar bancos novos.
    """
    insp = inspect(engine)
    if table not in insp.get_table_names():
        return
    existentes = {c["name"] for c in insp.get_columns(table)}
    if column not in existentes:
        with engine.begin() as conn:
            conn.execute(text(f'ALTER TABLE {table} ADD COLUMN {column} {ddl_type}'))


_ensure_column("generated_videos", "tipo_video", "VARCHAR(16)")
_ensure_column("phrase_types", "share_slug", "VARCHAR(32)")
_ensure_column("pub_accounts", "senha_enc", "TEXT")
_ensure_column("pub_accounts", "ultimo_erro_em", "TIMESTAMP")
_ensure_column("pub_contents", "link", "TEXT")
_ensure_column("pub_defaults", "trending_enabled", "BOOLEAN")
_ensure_column("pub_defaults", "ultima_coleta_em", "TIMESTAMP")

app = FastAPI(title="Vídeos em Massa API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(folders.router)
app.include_router(media.router)
app.include_router(phrases.router)
app.include_router(upscale.router)
app.include_router(videos.router)
app.include_router(pub_accounts.router)
app.include_router(pub_content.router)
app.include_router(pub_dashboard.router)


@app.on_event("startup")
def _start_publishing_scheduler() -> None:
    start_background_scheduler()


@app.get("/health", tags=["infra"])
def health():
    return {"status": "ok"}
