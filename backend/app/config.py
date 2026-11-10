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

    # quantas contas podem executar publicações em paralelo (cada conta = 1 slot,
    # sempre serializada dentro de si mesma — fila própria por conta)
    publishing_concurrency: int = 4

    # timeout (segundos) de cada tentativa da checagem de proxy
    proxy_check_timeout_seconds: int = 8

    # versão de app do Instagram usada no LOGIN LEGADO (o User-Agent que o fork
    # do instagrapi monta). O fork só conhece versões antigas (446/428/385/364)
    # que o Instagram passou a rejeitar com "Your version of Instagram is out of
    # date" — configure aqui a versão atual + version_code (loja do app) para o
    # login legado voltar a passar sem mexer no código. Vazio = usa só as
    # versões do fork.
    # ATENÇÃO: o transporte declara User-Agent Android; se a versão informada
    # for de outra plataforma (ex.: build iOS), o Instagram pode seguir
    # rejeitando — nesse caso use a versão Android atual (Play Store/apkmirror).
    instagram_app_version: str = ""
    instagram_app_version_code: str = ""

    # segredo para assinar os tokens JWT — TROQUE em produção (via .env)
    secret_key: str = "dev-secret-troque-em-producao"
    jwt_expire_hours: int = 720  # 30 dias

    # ---------- SaaS: admins, planos e cobrança (ver backend/app/billing) ----------
    # e-mails com controle TOTAL: sem assinatura, sem limites, acesso ao painel admin.
    admin_emails: str = "scarlett.campelo@gmail.com,julio8martins@gmail.com"

    # Stripe (pagamento recorrente mensal, cartão). Sem STRIPE_SECRET_KEY o checkout
    # fica indisponível (503) — o resto do sistema funciona (admins e acessos manuais).
    stripe_secret_key: str = ""
    stripe_webhook_secret: str = ""
    # price_id (mensal recorrente) de cada plano, criados no painel da Stripe
    stripe_price_basico: str = ""
    stripe_price_pro: str = ""
    stripe_price_agencia: str = ""
    # URL pública do frontend — para onde a Stripe devolve o usuário após pagar
    app_url: str = "http://localhost:5273"

    # tamanho máximo de qualquer arquivo enviado pelo usuário (MB)
    max_upload_mb: int = 50
    # duração máxima (segundos) de um vídeo gerado pelo Nitro
    max_video_seconds: float = 60.0

    # vídeos gerados são apagados (arquivo + registro) após N dias
    video_retention_days: int = 3  # vídeos gerados e NÃO agendados
    delete_after_publish: bool = True  # apaga o vídeo gerado assim que a postagem é confirmada
    # a retenção vale também para os admins? (padrão: não)
    video_retention_include_admins: bool = True

    @property
    def storage_path(self) -> Path:
        p = Path(self.storage_dir)
        p.mkdir(parents=True, exist_ok=True)
        return p

    @property
    def admin_emails_set(self) -> set[str]:
        return {e.strip().lower() for e in self.admin_emails.split(",") if e.strip()}

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
