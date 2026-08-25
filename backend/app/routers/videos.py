"""Geração de vídeo (Fase 3 + 4). Monta 1 vídeo a partir da biblioteca de mídias.

A geração EM MASSA (várias de uma vez, música aleatória, IA para legenda) vem
na Fase 5. Aqui já dá para gerar um vídeo com todas as opções, inclusive o
flash hot de 1 frame.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..models import GeneratedVideo, Job, Media, Phrase
from ..schemas import BulkRequest, GeneratedVideoOut, JobOut
from ..services import bulk, video
from ..services.bulk import BulkConfig

router = APIRouter(prefix="/api/v1/videos", tags=["videos"])


class GenerateRequest(BaseModel):
    base_media_id: int              # foto ou vídeo base
    phrase_id: int | None = None    # texto que aparece DENTRO do vídeo
    music_media_id: int | None = None
    duration: float = 10.0          # 8–14s recomendado
    use_flash: bool = False         # requisito #9 (checkbox)
    hot_media_id: int | None = None # imagem do flash (obrigatória se use_flash)
    flash_at: float | None = None   # segundo do flash (padrão: meio)


class GenerateResponse(BaseModel):
    id: str
    url: str
    duration: float
    used_flash: bool


def _media_or_404(db: Session, media_id: int, tipos: set[str]) -> Media:
    m = db.get(Media, media_id)
    if not m:
        raise HTTPException(status_code=404, detail=f"Mídia {media_id} não encontrada")
    if m.tipo not in tipos:
        raise HTTPException(status_code=400, detail=f"Mídia {media_id} deve ser {tipos}, é '{m.tipo}'")
    return m


@router.post("/generate", response_model=GenerateResponse)
def generate_video(body: GenerateRequest, db: Session = Depends(get_db)):
    duration = max(1.0, min(body.duration, 60.0))
    storage = settings.storage_path

    base = _media_or_404(db, body.base_media_id, {"video", "photo"})
    base_path = storage / base.caminho

    text = None
    if body.phrase_id is not None:
        ph = db.get(Phrase, body.phrase_id)
        if not ph:
            raise HTTPException(status_code=404, detail="Frase não encontrada")
        text = ph.texto

    music_path = None
    if body.music_media_id is not None:
        music = _media_or_404(db, body.music_media_id, {"music"})
        music_path = storage / music.caminho

    hot_path = None
    if body.use_flash:
        if body.hot_media_id is None:
            raise HTTPException(status_code=400, detail="use_flash exige hot_media_id")
        hot = _media_or_404(db, body.hot_media_id, {"photo_hot"})
        hot_path = storage / hot.caminho

    gen_dir = storage / "generated"
    gen_dir.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex
    out_path = gen_dir / f"{token}.mp4"

    try:
        video.build_video(
            base_path, out_path,
            duration=duration,
            text=text,
            music_path=music_path,
            hot_path=hot_path,
            flash_at=body.flash_at,
        )
    except Exception as exc:  # noqa: BLE001
        out_path.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail=f"Falha ao gerar vídeo: {exc}") from exc

    return GenerateResponse(
        id=token,
        url=f"/api/v1/videos/gen/{token}/download",
        duration=duration,
        used_flash=body.use_flash,
    )


@router.get("/gen/{token}/download")
def download_generated(token: str):
    # token é hex de uuid — evita path traversal.
    if not token.isalnum():
        raise HTTPException(status_code=400, detail="token inválido")
    path = settings.storage_path / "generated" / f"{token}.mp4"
    if not path.exists():
        raise HTTPException(status_code=404, detail="Vídeo não encontrado")
    return FileResponse(path, filename=f"video_{token}.mp4", media_type="video/mp4")


# ---------- Geração em massa (Fase 5) ----------
@router.post("/bulk", response_model=JobOut)
def generate_bulk(body: BulkRequest, background: BackgroundTasks, db: Session = Depends(get_db)):
    if not body.base_media_ids:
        raise HTTPException(status_code=400, detail="Selecione ao menos uma mídia base")
    quantidade = max(1, min(body.quantidade, 200))

    # valida pré-condição de texto: precisa de frases OU IA de texto (ou nenhum texto)
    if body.use_ia_texto and body.phrase_type_id is None:
        raise HTTPException(status_code=400, detail="use_ia_texto exige um phrase_type_id de referência")
    if body.use_flash and not body.hot_media_ids:
        raise HTTPException(status_code=400, detail="use_flash exige ao menos uma foto hot")

    # range de duração: clamp em [1, 60] e garante min <= max
    dur_min = max(1.0, min(body.duration_min, 60.0))
    dur_max = max(1.0, min(body.duration_max, 60.0))
    dur_min, dur_max = min(dur_min, dur_max), max(dur_min, dur_max)

    job = Job(status="fila", total=quantidade, concluidos=0)
    db.add(job)
    db.commit()
    db.refresh(job)

    cfg = BulkConfig(
        quantidade=quantidade,
        base_media_ids=body.base_media_ids,
        music_media_ids=body.music_media_ids,
        hot_media_ids=body.hot_media_ids,
        phrase_type_id=body.phrase_type_id,
        use_ia_texto=body.use_ia_texto,
        gerar_legenda_ia=body.gerar_legenda_ia,
        duration_min=dur_min,
        duration_max=dur_max,
        use_flash=body.use_flash,
    )
    background.add_task(bulk.run_bulk_job, job.id, cfg)
    return job


@router.get("/jobs/{job_id}", response_model=JobOut)
def get_job(job_id: int, db: Session = Depends(get_db)):
    job = db.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job não encontrado")
    return job


# ---------- Histórico (Fase 6, alimentado pela geração em massa) ----------
@router.get("/history", response_model=list[GeneratedVideoOut])
def history(job_id: int | None = None, db: Session = Depends(get_db)):
    stmt = select(GeneratedVideo).order_by(GeneratedVideo.criado_em.desc())
    if job_id is not None:
        stmt = stmt.where(GeneratedVideo.job_id == job_id)
    return list(db.scalars(stmt))


class DeleteBatch(BaseModel):
    ids: list[int]


@router.post("/history/delete")
def delete_history_batch(body: DeleteBatch, db: Session = Depends(get_db)):
    """Apaga vários vídeos gerados de uma vez (arquivo no disco + registro)."""
    removidos = 0
    for vid in body.ids:
        gv = db.get(GeneratedVideo, vid)
        if gv:
            (settings.storage_path / gv.caminho).unlink(missing_ok=True)
            db.delete(gv)
            removidos += 1
    db.commit()
    return {"removidos": removidos}


@router.get("/{video_id}/download")
def download_video(video_id: int, db: Session = Depends(get_db)):
    gv = db.get(GeneratedVideo, video_id)
    if not gv:
        raise HTTPException(status_code=404, detail="Vídeo não encontrado")
    path = settings.storage_path / gv.caminho
    if not path.exists():
        raise HTTPException(status_code=404, detail="Arquivo não existe no disco")
    return FileResponse(path, filename=f"video_{video_id}.mp4", media_type="video/mp4")
