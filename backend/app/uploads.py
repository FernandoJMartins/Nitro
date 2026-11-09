"""Limite de tamanho de arquivos enviados (settings.max_upload_mb, padrão 50 MB)."""
from __future__ import annotations

from pathlib import Path
from typing import BinaryIO, Iterable

from fastapi import HTTPException

from .config import settings

CHUNK = 1024 * 1024


def max_bytes() -> int:
    return settings.max_upload_mb * 1024 * 1024


def too_big(nome: str | None = None) -> HTTPException:
    alvo = f'"{nome}" ' if nome else ""
    return HTTPException(status_code=413, detail=f"O arquivo {alvo}passa do limite de {settings.max_upload_mb} MB.")


def save_limited(src: BinaryIO, dest: Path, nome: str | None = None) -> int:
    """Copia em blocos até o limite; passou -> apaga o parcial e levanta 413."""
    return save_chunks(iter(lambda: src.read(CHUNK), b""), dest, nome)


def save_chunks(chunks: Iterable[bytes], dest: Path, nome: str | None = None) -> int:
    limite = max_bytes()
    total = 0
    try:
        with dest.open("wb") as f:
            for chunk in chunks:
                total += len(chunk)
                if total > limite:
                    raise too_big(nome)
                f.write(chunk)
    except BaseException:
        dest.unlink(missing_ok=True)
        raise
    return total
