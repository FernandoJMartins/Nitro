"""Log de auditoria (Content #21): toda ação importante de conta/publicação fica registrada."""
from __future__ import annotations

from sqlalchemy.orm import Session

from ..models import PublicationLog


def log_event(
    db: Session,
    mensagem: str,
    *,
    account_id: int | None = None,
    publication_id: int | None = None,
    nivel: str = "info",
) -> None:
    db.add(PublicationLog(account_id=account_id, publication_id=publication_id, nivel=nivel, mensagem=mensagem))
    db.commit()
