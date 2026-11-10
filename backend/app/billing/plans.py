"""Definição dos planos — ÚNICO lugar para mudar limites e funções de cada plano.

Admins (settings.admin_emails) ignoram tudo isto: sem assinatura e sem limites.
Preço NÃO fica aqui: é o price_id mensal de cada plano na Stripe
(STRIPE_PRICE_BASICO / _PRO / _AGENCIA no .env).
"""
from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class Plan:
    id: str
    nome: str
    preco_mensal: float        # SÓ exibição (R$). Quem cobra é o price_id na Stripe — mantenha igual.
    # --- limites ---
    max_contas: int            # perfis (contas do Instagram) conectados
    videos_por_mes: int        # vídeos gerados em massa por mês (soma de todos os lotes)
    max_por_lote: int          # vídeos por lote de geração em massa
    max_calendario: int        # reels na fila de publicação (aprovados/agendados, ainda não publicados)
    stories_por_dia: int       # stories por dia, somando TODAS as contas da assinatura
    max_midias: int            # arquivos na biblioteca (vídeos, fotos, músicas...)
    armazenamento_gb: float    # espaço total da biblioteca + imagens ampliadas
    # --- funções ---
    ia: bool                   # IA de frases, textos e legendas
    upscale: bool              # utilitário de ampliar imagens
    stories_compartilhados: bool  # um story publicado em várias contas de uma vez
    api_keys: bool             # chaves de API para sistemas externos

    def as_dict(self) -> dict:
        return asdict(self)


PLANS: dict[str, Plan] = {
    "basico": Plan(
        id="basico", nome="Básico", preco_mensal=147.0,
        max_contas=10, videos_por_mes=600, max_por_lote=50, max_calendario=60, stories_por_dia=5,
        max_midias=200, armazenamento_gb=5,
        ia=False, upscale=False, stories_compartilhados=False, api_keys=False,
    ),
    "pro": Plan(
        id="pro", nome="Pro", preco_mensal=297.0,
        max_contas=50, videos_por_mes=3000, max_por_lote=100, max_calendario=400, stories_por_dia=25,
        max_midias=1000, armazenamento_gb=20,
        ia=True, upscale=True, stories_compartilhados=True, api_keys=False,
    ),
    "agencia": Plan(
        id="agencia", nome="Agência", preco_mensal=497.0,
        max_contas=200, videos_por_mes=10000, max_por_lote=200, max_calendario=2000, stories_por_dia=100,
        max_midias=3000, armazenamento_gb=50,
        ia=True, upscale=True, stories_compartilhados=True, api_keys=True,
    ),
}

# "plano" dos admins: sem limite prático e com todas as funções
ADMIN_PLAN = Plan(
    id="admin", nome="Admin", preco_mensal=0.0,
    max_contas=10**9, videos_por_mes=10**9, max_por_lote=200, max_calendario=10**9, stories_por_dia=10**9,
    max_midias=10**9, armazenamento_gb=10**9,
    ia=True, upscale=True, stories_compartilhados=True, api_keys=True,
)

# limite técnico do motor por lote, independente do plano
MAX_LOTE_SISTEMA = 200


def get_plan(plan_id: str | None) -> Plan | None:
    return PLANS.get(plan_id or "")
