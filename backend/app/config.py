"""Configuração da aplicação, lida do arquivo .env."""
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    database_url: str = "postgresql+psycopg://postgres:postgres@localhost:5432/videos_em_massa"
    storage_dir: str = "./storage"
    cors_origins: str = "http://localhost:5173"
    openai_api_key: str = ""
    openai_model: str = "gpt-4o-mini"  # a opção mais barata da OpenAI para texto

    # fonte externa de áudios em alta (tendências) para o módulo de publicação
    trending_source: str = "apple_music"
    trending_country: str = "br"  # chart brasileiro (mais tocadas no Brasil)
    trending_limit: int = 100  # máximo suportado pelo feed Apple RSS (200 devolve HTTP 500)
    trending_brasileiras_only: bool = True  # filtra por gêneros de música brasileira
    trending_min_brasileiras: int = 20  # se o filtro sobrar menos que isso, usa o chart completo
    trending_refresh_hours: int = 24

    # quantas contas podem executar publicações em paralelo (cada conta = 1 slot,
    # sempre serializada dentro de si mesma — fila própria por conta)
    publishing_concurrency: int = 4

    # timeout (segundos) de cada tentativa da checagem de proxy
    proxy_check_timeout_seconds: int = 8

    # segredo para assinar os tokens JWT — TROQUE em produção (via .env)
    secret_key: str = "dev-secret-troque-em-producao"
    jwt_expire_hours: int = 720  # 30 dias

    @property
    def storage_path(self) -> Path:
        p = Path(self.storage_dir)
        p.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
