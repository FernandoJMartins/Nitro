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
_ensure_column("pub_proxies", "nome_interno", "VARCHAR(100)")
# bancos antigos: a coluna legada "nome" (host:porta) vira o nome interno inicial
_insp = inspect(engine)
if "pub_proxies" in _insp.get_table_names() and "nome" in {c["name"] for c in _insp.get_columns("pub_proxies")}:
    with engine.begin() as conn:
        conn.execute(text("UPDATE pub_proxies SET nome_interno = nome WHERE nome_interno IS NULL OR nome_interno = ''"))
_ensure_column("pub_accounts", "senha_enc", "TEXT")
_ensure_column("pub_accounts", "sessionid_enc", "TEXT")
_ensure_column("pub_accounts", "pending_login_data", "TEXT")
_ensure_column("pub_accounts", "ultimo_erro_em", "TIMESTAMP")
_ensure_column("pub_accounts", "ativa", "BOOLEAN DEFAULT TRUE")
_ensure_column("pub_accounts", "posts_por_ciclo", "INTEGER")
_ensure_column("pub_accounts", "horas_por_ciclo", "FLOAT")
_ensure_column("pub_defaults", "posts_por_ciclo", "INTEGER DEFAULT 0")
_ensure_column("pub_defaults", "horas_por_ciclo", "FLOAT DEFAULT 0")
_ensure_column("pub_accounts", "horarios_selecionados", "TEXT")
_ensure_column("pub_defaults", "horarios_selecionados", "TEXT")
_ensure_column("pub_contents", "link", "TEXT")
_ensure_column("pub_contents", "link_posicao", "VARCHAR(16)")
_ensure_column("pub_contents", "texto_extra", "TEXT")
_ensure_column("pub_story_plans", "texto", "TEXT")
_ensure_column("pub_story_plans", "link", "TEXT")
_ensure_column("pub_story_plans", "link_posicao", "VARCHAR(16)")
_ensure_column("pub_story_plans", "texto_extra", "TEXT")

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
