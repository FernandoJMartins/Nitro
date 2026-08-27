"""Upscaling de imagens EM MASSA (utilitário).

Amplia imagens 2x ou 4x usando Pillow (reamostragem LANCZOS — alta qualidade,
sem dependências pesadas). Roda em background (FastAPI BackgroundTasks) e
atualiza o progresso no UpscaleJob, igual à geração em massa de vídeos.

Para super-resolução "IA" real (Real-ESRGAN etc.) bastaria trocar
`upscale_image` por outro motor; o resto (job, histórico) continua igual.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from pathlib import Path

from PIL import Image

from ..config import settings
from ..database import SessionLocal
from ..models import UpscaledImage, UpscaleJob

# Formatos que sabemos abrir/ampliar.
SUPORTADOS = {".jpg", ".jpeg", ".png", ".webp"}


@dataclass
class UpscaleItem:
    """Uma imagem a ampliar: caminho absoluto no disco + nome amigável."""

    src: Path
    nome_original: str


def upscale_image(src: Path, dst: Path, escala: int) -> tuple[int, int]:
    """Amplia `src` em `escala`x e grava em `dst`. Devolve (largura, altura) final."""
    with Image.open(src) as im:
        im.load()
        larg, alt = im.size
        nova = (max(1, larg * escala), max(1, alt * escala))
        modo = im.mode
        # LANCZOS não funciona bem em modo P/1; converte para algo com canais.
        if modo in {"P", "1"}:
            im = im.convert("RGBA" if "transparency" in im.info else "RGB")
        ampliada = im.resize(nova, Image.LANCZOS)

    dst.parent.mkdir(parents=True, exist_ok=True)
    ext = dst.suffix.lower()
    if ext in {".jpg", ".jpeg"}:
        ampliada.convert("RGB").save(dst, quality=95, optimize=True)
    elif ext == ".webp":
        ampliada.save(dst, quality=95, method=6)
    else:  # .png (padrão): lossless
        ampliada.save(dst)
    return ampliada.size


def run_upscale_job(job_id: int, itens: list[UpscaleItem], escala: int) -> None:
    """Processa o lote inteiro. Cada imagem é isolada: erro em uma não derruba as outras."""
    db = SessionLocal()
    try:
        job = db.get(UpscaleJob, job_id)
        if job is None:
            return
        job.status = "processando"
        db.commit()

        storage = settings.storage_path
        out_dir = storage / "upscaled"
        out_dir.mkdir(parents=True, exist_ok=True)

        for item in itens:
            try:
                ext = item.src.suffix.lower()
                if ext not in SUPORTADOS:
                    ext = ".png"
                token = uuid.uuid4().hex
                rel = f"upscaled/{token}{ext}"
                out_path = storage / rel
                larg, alt = upscale_image(item.src, out_path, escala)

                db.add(UpscaledImage(
                    user_id=job.user_id,
                    job_id=job_id,
                    caminho=rel,
                    nome_original=item.nome_original,
                    escala=escala,
                    largura=larg,
                    altura=alt,
                    tamanho_bytes=out_path.stat().st_size,
                ))
                job.concluidos += 1
                db.commit()
            except Exception as exc:  # noqa: BLE001 — registra e segue
                job.erro = (job.erro or "") + f"[{item.nome_original} falhou: {exc}] "
                db.commit()

        job.status = "concluido"
        db.commit()
    finally:
        db.close()
