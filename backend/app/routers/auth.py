"""Rotas de autenticação: registro, login, perfil e chaves de API."""
from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import security
from ..database import get_db
from ..deps import get_current_user
from ..models import ApiKey, User
from ..schemas import (
    ApiKeyCreate,
    ApiKeyCreated,
    ApiKeyOut,
    TokenOut,
    UserCreate,
    UserOut,
)

router = APIRouter(prefix="/api/v1", tags=["auth"])

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


@router.post("/auth/register", response_model=TokenOut)
def register(body: UserCreate, db: Session = Depends(get_db)):
    email = body.email.strip().lower()
    if not _EMAIL_RE.match(email):
        raise HTTPException(status_code=400, detail="E-mail inválido")
    if len(body.senha) < 6:
        raise HTTPException(status_code=400, detail="A senha deve ter ao menos 6 caracteres")
    if db.scalar(select(User).where(User.email == email)):
        raise HTTPException(status_code=409, detail="Este e-mail já está cadastrado")

    user = User(email=email, senha_hash=security.hash_password(body.senha))
    db.add(user)
    db.commit()
    db.refresh(user)
    return TokenOut(access_token=security.create_access_token(user.id))


@router.post("/auth/login", response_model=TokenOut)
def login(body: UserCreate, db: Session = Depends(get_db)):
    email = body.email.strip().lower()
    user = db.scalar(select(User).where(User.email == email))
    if not user or not security.verify_password(body.senha, user.senha_hash):
        raise HTTPException(status_code=401, detail="E-mail ou senha incorretos")
    return TokenOut(access_token=security.create_access_token(user.id))


@router.get("/auth/me", response_model=UserOut)
def me(user: User = Depends(get_current_user)):
    return user


# ---------- Chaves de API ----------
@router.post("/keys", response_model=ApiKeyCreated)
def create_key(body: ApiKeyCreate, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    raw, chave_hash, prefixo = security.generate_api_key()
    ak = ApiKey(user_id=user.id, nome=body.nome.strip() or "Minha chave", chave_hash=chave_hash, prefixo=prefixo)
    db.add(ak)
    db.commit()
    db.refresh(ak)
    # a chave crua vai SÓ nesta resposta; depois não dá mais para recuperá-la.
    return ApiKeyCreated(
        id=ak.id, nome=ak.nome, prefixo=ak.prefixo, ativo=ak.ativo, criado_em=ak.criado_em, chave=raw
    )


@router.get("/keys", response_model=list[ApiKeyOut])
def list_keys(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return list(db.scalars(select(ApiKey).where(ApiKey.user_id == user.id).order_by(ApiKey.criado_em.desc())))


@router.delete("/keys/{key_id}", status_code=204)
def delete_key(key_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    ak = db.get(ApiKey, key_id)
    if not ak or ak.user_id != user.id:
        raise HTTPException(status_code=404, detail="Chave não encontrada")
    db.delete(ak)
    db.commit()
