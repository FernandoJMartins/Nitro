"""Segurança: hash de senha, JWT, chaves de API e criptografia simétrica de segredos."""
from __future__ import annotations

import base64
import hashlib
import secrets
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from cryptography.fernet import Fernet, InvalidToken

from .config import settings

ALGO = "HS256"
API_KEY_PREFIX = "nitro_"


# ---------- senha ----------
def hash_password(senha: str) -> str:
    return bcrypt.hashpw(senha.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(senha: str, senha_hash: str) -> bool:
    try:
        return bcrypt.checkpw(senha.encode("utf-8"), senha_hash.encode("utf-8"))
    except ValueError:
        return False


# ---------- JWT (login web) ----------
def create_access_token(user_id: int) -> str:
    agora = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "iat": agora,
        "exp": agora + timedelta(hours=settings.jwt_expire_hours),
    }
    return jwt.encode(payload, settings.secret_key, algorithm=ALGO)


def decode_access_token(token: str) -> int | None:
    """Retorna o user_id do token, ou None se inválido/expirado."""
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[ALGO])
        return int(payload["sub"])
    except (jwt.InvalidTokenError, KeyError, ValueError):
        return None


# ---------- API keys (sistemas externos) ----------
def generate_api_key() -> tuple[str, str, str]:
    """Gera (chave_crua, hash, prefixo). A chave crua só é mostrada uma vez."""
    raw = API_KEY_PREFIX + secrets.token_hex(24)
    return raw, hash_api_key(raw), raw[: len(API_KEY_PREFIX) + 6]


def hash_api_key(raw: str) -> str:
    """SHA-256 — permite lookup rápido por hash (diferente do bcrypt da senha)."""
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def is_api_key(token: str) -> bool:
    return token.startswith(API_KEY_PREFIX)


# ---------- criptografia simétrica (credenciais de contas de publicação) ----------
def _fernet() -> Fernet:
    # Deriva uma chave de 32 bytes do SECRET_KEY existente — evita exigir mais uma
    # variável de ambiente só pra isso. Trocar o SECRET_KEY invalida os segredos salvos.
    key = hashlib.sha256(settings.secret_key.encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def encrypt_secret(value: str) -> str:
    return _fernet().encrypt(value.encode("utf-8")).decode("utf-8")


def decrypt_secret(token: str) -> str | None:
    try:
        return _fernet().decrypt(token.encode("utf-8")).decode("utf-8")
    except InvalidToken:
        return None
