"""Distribution Engine (Seção 5): distribui conteúdos entre contas ativas
proporcionalmente à capacidade diária de cada uma (horários/posts por dia) —
nunca tudo na primeira conta disponível.
"""
from __future__ import annotations

import heapq

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import Account, Content, Publication
from .scheduling import daily_capacity

ELIGIBLE_STATUSES = ("pronta",)


def eligible_accounts(db: Session, user_id: int, platform: str = "instagram") -> list[Account]:
    return list(
        db.scalars(
            select(Account).where(
                Account.user_id == user_id,
                Account.platform == platform,
                Account.status.in_(ELIGIBLE_STATUSES),
                Account.ativa.is_(True),
                Account.automation_status != "pausada",
            )
        )
    )


def _current_load(db: Session, account_id: int) -> int:
    """Fila PENDENTE da conta: reels não rejeitados que ainda vão ser publicados
    (sem publicação ou com publicação em andamento). O histórico já publicado não
    conta — senão contas antigas parecem "cheias" e as novas recebem tudo."""
    finalizada = Content.publications.any(Publication.status.in_(("PUBLISHED", "FAILED", "CANCELLED")))
    return (
        db.scalar(
            select(func.count(Content.id)).where(
                Content.account_id == account_id,
                Content.kind == "reel",
                Content.approval_status != "rejeitado",
                ~finalizada,
            )
        )
        or 0
    )


def distribute_by_capacity(db: Session, contents: list[Content], accounts: list[Account]) -> dict[int, int]:
    """Atribui account_id a cada Content proporcionalmente aos posts/dia de cada conta.

    Regra de negócio: conta com mais horários (ou mais posts no dia) tem prioridade.
    Cada conteúdo vai para a conta cuja fila, medida em DIAS (carga / capacidade
    diária), fica menor depois de recebê-lo — a fila termina junto em todas.
    """
    if not accounts:
        return {}
    capacidades = [daily_capacity(db, acc) for acc in accounts]
    if not any(c > 0 for c in capacidades):
        capacidades = [1.0] * len(accounts)  # nenhuma capacidade configurada: uniforme
    heap = []
    for i, (acc, cap) in enumerate(zip(accounts, capacidades)):
        if cap > 0:
            load = _current_load(db, acc.id)
            heap.append(((load + 1) / cap, i, load, cap, acc))
    heapq.heapify(heap)

    assignment: dict[int, int] = {}
    for content in contents:
        _, i, load, cap, acc = heapq.heappop(heap)
        content.account_id = acc.id
        assignment[content.id] = acc.id
        heapq.heappush(heap, ((load + 2) / cap, i, load + 1, cap, acc))
    db.commit()
    return assignment
