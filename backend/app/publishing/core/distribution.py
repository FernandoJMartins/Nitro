"""Distribution Engine (Seção 5): distribui conteúdos entre contas ativas o mais
uniformemente possível — nunca tudo na primeira conta disponível.

'Uniforme' é a estratégia padrão. O ponto de extensão para 'Balanceado' /
'Manual' / 'Prioridade por conta' é trocar `distribute_uniform` por outra
função com a mesma assinatura.
"""
from __future__ import annotations

import heapq

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import Account, Content

ELIGIBLE_STATUSES = ("pronta",)


def eligible_accounts(db: Session, user_id: int, platform: str = "instagram") -> list[Account]:
    return list(
        db.scalars(
            select(Account).where(
                Account.user_id == user_id,
                Account.platform == platform,
                Account.status.in_(ELIGIBLE_STATUSES),
                Account.automation_status != "pausada",
            )
        )
    )


def _current_load(db: Session, account_id: int) -> int:
    """Quantos conteúdos (não rejeitados) já apontam para esta conta agora."""
    return (
        db.scalar(
            select(func.count(Content.id)).where(
                Content.account_id == account_id,
                Content.approval_status != "rejeitado",
            )
        )
        or 0
    )


def distribute_uniform(db: Session, contents: list[Content], accounts: list[Account]) -> dict[int, int]:
    """Atribui account_id a cada Content, mantendo a carga o mais uniforme possível.

    Usa um heap por carga ATUAL (não por índice fixo): contas que já têm fila
    maior — inclusive de distribuições anteriores — recebem menos desta vez.
    """
    if not accounts:
        return {}
    heap = [(_current_load(db, acc.id), i, acc) for i, acc in enumerate(accounts)]
    heapq.heapify(heap)

    assignment: dict[int, int] = {}
    for content in contents:
        load, i, acc = heapq.heappop(heap)
        content.account_id = acc.id
        assignment[content.id] = acc.id
        heapq.heappush(heap, (load + 1, i, acc))
    db.commit()
    return assignment
