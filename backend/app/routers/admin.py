"""Painel admin: os e-mails de settings.admin_emails têm controle total —
veem todos os usuários, uso e assinatura, concedem acesso manual (cortesia,
sem Stripe) e bloqueiam/desbloqueiam usuários."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..billing import limits
from ..billing.plans import PLANS
from ..database import get_db
from ..deps import get_admin_user
from ..models import User

router = APIRouter(prefix="/api/v1/admin", tags=["admin"])


def _user_out(db: Session, u: User) -> dict:
    plan = limits.effective_plan(u)
    return {
        "id": u.id,
        "email": u.email,
        "criado_em": u.criado_em,
        "is_admin": u.is_admin,
        "plano": u.plano,
        "assinatura_status": u.assinatura_status,
        "periodo_fim": u.periodo_fim,
        "acesso_manual_ate": u.acesso_manual_ate,
        "bloqueado": u.bloqueado,
        "tem_acesso": plan is not None,
        "uso": limits.usage_summary(db, u),
    }


@router.get("/users")
def list_users(_: User = Depends(get_admin_user), db: Session = Depends(get_db)):
    return [_user_out(db, u) for u in db.scalars(select(User).order_by(User.criado_em.desc()))]


class AdminUserUpdate(BaseModel):
    # concede/estende acesso manual: plano + quantos dias (0 = remove o acesso manual)
    plano: str | None = None
    dias_acesso_manual: int | None = None
    bloqueado: bool | None = None


@router.patch("/users/{user_id}")
def update_user(user_id: int, body: AdminUserUpdate, _: User = Depends(get_admin_user), db: Session = Depends(get_db)):
    u = db.get(User, user_id)
    if not u:
        raise HTTPException(404, "Usuário não encontrado.")
    if body.plano is not None:
        if body.plano not in PLANS:
            raise HTTPException(400, "Plano inválido.")
        u.plano = body.plano
    if body.dias_acesso_manual is not None:
        u.acesso_manual_ate = (
            datetime.now(timezone.utc) + timedelta(days=body.dias_acesso_manual) if body.dias_acesso_manual > 0 else None
        )
    if body.bloqueado is not None:
        if u.is_admin and body.bloqueado:
            raise HTTPException(400, "Não é possível bloquear um administrador.")
        u.bloqueado = body.bloqueado
    db.commit()
    db.refresh(u)
    return _user_out(db, u)
