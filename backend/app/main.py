"""Ponto de entrada da API (FastAPI)."""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import inspect, text

from .config import settings
from .database import Base, engine
from .routers import auth, folders, media, phrases, upscale, videos

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


@app.get("/health", tags=["infra"])
def health():
    return {"status": "ok"}
