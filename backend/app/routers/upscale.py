"""Utilitário de upscaling de imagens EM MASSA.

Dois modos de entrada:
- `POST /upload`  : joga as imagens direto (multipart) — não usa a biblioteca.
- `POST /from-media` : usa fotos que já estão na biblioteca (ex.: a pasta de uma modelo).

Ambos criam um UpscaleJob e processam em background, alimentando um histórico
próprio (`GET /history`), separado do histórico de vídeos.
"""
from __future__ import annotations

import io
import uuid
import zipfile
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..deps import get_current_user, get_user_for_file
from ..models import Media, UpscaledImage, UpscaleJob, User
from ..schemas import UpscaledImageOut, UpscaleFromMediaRequest, UpscaleJobOut
from ..services import upscale
from ..services.upscale import UpscaleItem

router = APIRouter(prefix="/api/v1/upscale", tags=["upscale"])


def _valida_escala(escala: int) -> int:
    if escala not in (2, 4):
        raise HTTPException(status_code=400, detail="Escala deve ser 2 ou 4")
    return escala


def _cria_job(db: Session, user_id: int, escala: int, total: int) -> UpscaleJob:
    job = UpscaleJob(user_id=user_id, status="fila", escala=escala, total=total, concluidos=0)
    db.add(job)
    db.commit()
    db.refresh(job)
    return job


@router.post("/upload", response_model=UpscaleJobOut)
def upscale_upload(
    background: BackgroundTasks,
    files: list[UploadFile] = File(...),
    escala: int = Query(2),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Recebe as imagens direto e amplia. Guarda os originais em storage/upscale_src/."""
    escala = _valida_escala(escala)
    if not files:
        raise HTTPException(status_code=400, detail="Envie ao menos uma imagem")

    storage = settings.storage_path
    src_dir = storage / "upscale_src"
    src_dir.mkdir(parents=True, exist_ok=True)

    itens: list[UpscaleItem] = []
    for up in files:
        ext = Path(up.filename or "").suffix.lower()
        if ext not in upscale.SUPORTADOS:
            continue  # ignora arquivos não suportados em vez de derrubar o lote
        token = uuid.uuid4().hex
        dest = src_dir / f"{token}{ext}"
        with dest.open("wb") as f:
            while chunk := up.file.read(1024 * 1024):
                f.write(chunk)
        itens.append(UpscaleItem(src=dest, nome_original=up.filename or f"{token}{ext}"))

    if not itens:
        raise HTTPException(
            status_code=400,
            detail=f"Nenhuma imagem válida. Aceitas: {sorted(upscale.SUPORTADOS)}",
        )

    job = _cria_job(db, user.id, escala, len(itens))
    background.add_task(upscale.run_upscale_job, job.id, itens, escala)
    return job


@router.post("/from-media", response_model=UpscaleJobOut)
def upscale_from_media(
    body: UpscaleFromMediaRequest,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Amplia fotos que já estão na biblioteca (ex.: todas as fotos de uma pasta)."""
    escala = _valida_escala(body.escala)
    if not body.media_ids:
        raise HTTPException(status_code=400, detail="Selecione ao menos uma imagem")

    storage = settings.storage_path
    itens: list[UpscaleItem] = []
    for mid in body.media_ids:
        m = db.get(Media, mid)
        if not m or m.user_id != user.id:
            raise HTTPException(status_code=404, detail=f"Mídia {mid} não encontrada")
        ext = Path(m.caminho).suffix.lower()
        if ext not in upscale.SUPORTADOS:
            raise HTTPException(status_code=400, detail=f"Mídia {mid} não é uma imagem suportada")
        itens.append(UpscaleItem(src=storage / m.caminho, nome_original=m.nome_original))

    job = _cria_job(db, user.id, escala, len(itens))
    background.add_task(upscale.run_upscale_job, job.id, itens, escala)
    return job


@router.get("/jobs/{job_id}", response_model=UpscaleJobOut)
def get_upscale_job(job_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    job = db.get(UpscaleJob, job_id)
    if not job or job.user_id != user.id:
        raise HTTPException(status_code=404, detail="Job não encontrado")
    return job


@router.get("/history", response_model=list[UpscaledImageOut])
def upscale_history(
    job_id: int | None = None, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    stmt = (
        select(UpscaledImage)
        .where(UpscaledImage.user_id == user.id)
        .order_by(UpscaledImage.criado_em.desc())
    )
    if job_id is not None:
        stmt = stmt.where(UpscaledImage.job_id == job_id)
    return list(db.scalars(stmt))


class DeleteBatch(BaseModel):
    ids: list[int]


@router.post("/history/delete")
def delete_upscale_batch(
    body: DeleteBatch, db: Session = Depends(get_db), user: User = Depends(get_current_user)
):
    """Apaga várias imagens ampliadas de uma vez (arquivo no disco + registro)."""
    removidos = 0
    for iid in body.ids:
        img = db.get(UpscaledImage, iid)
        if img and img.user_id == user.id:
            (settings.storage_path / img.caminho).unlink(missing_ok=True)
            db.delete(img)
            removidos += 1
    db.commit()
    return {"removidos": removidos}


@router.get("/history/zip")
def download_upscale_zip(
    ids: str = Query(..., description="ids separados por vírgula, ex.: 1,2,3"),
    db: Session = Depends(get_db),
    user: User = Depends(get_user_for_file),
):
    """Empacota várias imagens ampliadas em um único .zip para download.

    GET (com ?token= na URL) para que o download possa ser disparado por um link
    direto <a download>, igual aos downloads individuais — evita o bloqueio de
    download programático via fetch/blob em alguns navegadores.
    """
    try:
        id_list = [int(x) for x in ids.split(",") if x.strip()]
    except ValueError:
        raise HTTPException(status_code=400, detail="ids inválidos")

    imagens = []
    for iid in id_list:
        img = db.get(UpscaledImage, iid)
        if img and img.user_id == user.id:
            path = settings.storage_path / img.caminho
            if path.exists():
                imagens.append((img, path))
    if not imagens:
        raise HTTPException(status_code=404, detail="Nenhuma imagem encontrada")

    buf = io.BytesIO()
    usados: set[str] = set()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for img, path in imagens:
            base = f"upscaled_{img.escala}x_{img.nome_original}"
            nome = base
            n = 1
            while nome in usados:  # evita colisão de nomes iguais no zip
                stem, dot, ext = base.rpartition(".")
                nome = f"{stem}_{n}.{ext}" if dot else f"{base}_{n}"
                n += 1
            usados.add(nome)
            zf.write(path, arcname=nome)
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="upscaled.zip"'},
    )


@router.get("/{image_id}/download")
def download_upscaled(image_id: int, db: Session = Depends(get_db), user: User = Depends(get_user_for_file)):
    img = db.get(UpscaledImage, image_id)
    if not img or img.user_id != user.id:
        raise HTTPException(status_code=404, detail="Imagem não encontrada")
    path = settings.storage_path / img.caminho
    if not path.exists():
        raise HTTPException(status_code=404, detail="Arquivo não existe no disco")
    nome = f"upscaled_{img.escala}x_{img.nome_original}"
    return FileResponse(path, filename=nome)
