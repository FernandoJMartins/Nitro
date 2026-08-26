"""Ponto de entrada da API (FastAPI)."""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import settings
from .database import Base, engine
from .routers import auth, folders, media, phrases, videos

# Cria as tabelas que ainda não existem. (Em produção, trocar por migrations/Alembic.)
Base.metadata.create_all(bind=engine)

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
app.include_router(videos.router)


@app.get("/health", tags=["infra"])
def health():
    return {"status": "ok"}
