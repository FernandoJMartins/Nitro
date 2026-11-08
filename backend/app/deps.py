"""Dependências de autenticação."""
from __future__ import annotations

from fastapi import Depends, Header, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from . import security
from .billing import limits as billing_limits
from .database import get_db
from .models import ApiKey, User


def _resolve_user(token: str, db: Session) -> User | None:
    """Resolve o usuário de um token que pode ser JWT (web) ou API key (externo)."""
    if security.is_api_key(token):
        ak = db.scalar(
            select(ApiKey).where(ApiKey.chave_hash == security.hash_api_key(token), ApiKey.ativo.is_(True))
        )
        return db.get(User, ak.user_id) if ak else None
    uid = security.decode_access_token(token)
    return db.get(User, uid) if uid is not None else None


def _check_access(user: User, token: str) -> User:
    """SaaS: sem assinatura ativa (e sem ser admin) não usa o sistema — 402.
    API key só funciona se o plano incluir a função de API."""
    plan = billing_limits.require_plan(user)
    if security.is_api_key(token) and not plan.api_keys:
        raise HTTPException(402, f"Acesso via API não está incluído no plano {plan.nome}.")
    return user


def get_authenticated_user(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> User:
    """Só autentica (JWT ou API key), SEM exigir assinatura. Usado pelas rotas de
    login/perfil e de cobrança — quem não pagou ainda precisa conseguir assinar."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Não autenticado. Envie Authorization: Bearer <token>.")
    user = _resolve_user(authorization[7:].strip(), db)
    if user is None:
        raise HTTPException(status_code=401, detail="Token ou API key inválidos/expirados.")
    return user


def get_current_user(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> User:
    """Autenticação padrão via header Authorization: Bearer <token> (JWT ou API key)
    + assinatura ativa (admins passam sempre)."""
    user = get_authenticated_user(authorization, db)
    return _check_access(user, authorization[7:].strip())


def get_admin_user(user: User = Depends(get_authenticated_user)) -> User:
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Apenas administradores.")
    return user


def get_user_for_file(
    authorization: str | None = Header(default=None),
    token: str | None = Query(default=None),
    db: Session = Depends(get_db),
) -> User:
    """Igual ao get_current_user, mas aceita também ?token= na URL.

    Necessário porque tags <video src> e <a download> do navegador não enviam
    header Authorization. Usado só nos endpoints que servem o arquivo em si.
    """
    raw = None
    if authorization and authorization.lower().startswith("bearer "):
        raw = authorization[7:].strip()
    elif token:
        raw = token.strip()
    user = _resolve_user(raw, db) if raw else None
    if user is None:
        raise HTTPException(status_code=401, detail="Token inválido ou ausente.")
    return _check_access(user, raw)
