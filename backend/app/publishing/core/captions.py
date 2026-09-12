"""Legendas: templates com variáveis simples e seleção manual/automática (Seção 13)."""
from __future__ import annotations

import random
import re
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Account, CaptionTemplate

_EMOJIS = ["🔥", "👀", "✨", "😍", "🎬", "💬", "📌", "🚀"]
_VAR_PATTERN = re.compile(r"\{\{\s*(\w+)\s*\}\}")


def resolve_caption(texto: str, *, username: str | None = None, numero: int | None = None) -> str:
    """Substitui {{username}}, {{date}}, {{number}}, {{random_emoji}} no texto do template."""

    def _sub(match: re.Match[str]) -> str:
        var = match.group(1)
        if var == "username":
            return username or ""
        if var == "date":
            return date.today().strftime("%d/%m/%Y")
        if var == "number":
            return str(numero) if numero is not None else ""
        if var == "random_emoji":
            return random.choice(_EMOJIS)
        return match.group(0)

    return _VAR_PATTERN.sub(_sub, texto)


def pick_caption_for_account(db: Session, account: Account) -> str | None:
    """Escolhe uma legenda ativa: prioriza templates da conta, senão os globais do usuário."""
    templates = list(
        db.scalars(
            select(CaptionTemplate).where(
                CaptionTemplate.user_id == account.user_id,
                CaptionTemplate.ativo.is_(True),
                CaptionTemplate.account_id == account.id,
            )
        )
    )
    if not templates:
        templates = list(
            db.scalars(
                select(CaptionTemplate).where(
                    CaptionTemplate.user_id == account.user_id,
                    CaptionTemplate.ativo.is_(True),
                    CaptionTemplate.account_id.is_(None),
                )
            )
        )
    if not templates:
        return None
    template = random.choice(templates)
    return resolve_caption(template.texto, username=account.username)
