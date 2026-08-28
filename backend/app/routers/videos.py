"""Geração de vídeo (Fase 3 + 4). Monta 1 vídeo a partir da biblioteca de mídias.

A geração EM MASSA (várias de uma vez, música aleatória, IA para legenda) vem
na Fase 5. Aqui já dá para gerar um vídeo com todas as opções, inclusive o
flash hot de 1 frame.
"""
from __future__ import annotations

import io
import uuid
import zipfile

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..database import get_db
from ..deps import get_current_user, get_user_for_file
from ..models import GeneratedVideo, Job, Media, Phrase, PhraseType, User
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


def _media_or_404(db: Session, media_id: int, tipos: set[str], user_id: int) -> Media:
    m = db.get(Media, media_id)
    if not m or m.user_id != user_id:
        raise HTTPException(status_code=404, detail=f"Mídia {media_id} não encontrada")
    if m.tipo not in tipos:
        raise HTTPException(status_code=400, detail=f"Mídia {media_id} deve ser {tipos}, é '{m.tipo}'")
    return m


@router.post("/generate", response_model=GenerateResponse)
def generate_video(body: GenerateRequest, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    duration = max(1.0, min(body.duration, 60.0))
    storage = settings.storage_path

    base = _media_or_404(db, body.base_media_id, {"video", "photo"}, user.id)
    base_path = storage / base.caminho

    text = None
    if body.phrase_id is not None:
        ph = db.get(Phrase, body.phrase_id)
        if not ph or ph.user_id != user.id:
            raise HTTPException(status_code=404, detail="Frase não encontrada")
        text = ph.texto

    music_path = None
    if body.music_media_id is not None:
        music = _media_or_404(db, body.music_media_id, {"music"}, user.id)
        music_path = storage / music.caminho

    hot_path = None
    if body.use_flash:
        if body.hot_media_id is None:
            raise HTTPException(status_code=400, detail="use_flash exige hot_media_id")
        hot = _media_or_404(db, body.hot_media_id, {"photo_hot"}, user.id)
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


@router.get("/fonts")
def list_fonts(user: User = Depends(get_current_user)):
    """Fontes disponíveis para o texto do vídeo (curadas presentes + .ttf/.otf soltos)."""
    return video.available_fonts()


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
def _owned_media_ids(db: Session, ids: list[int], user_id: int) -> None:
    """Garante que todas as mídias do pool pertencem ao usuário."""
    for mid in set(ids):
        m = db.get(Media, mid)
        if not m or m.user_id != user_id:
            raise HTTPException(status_code=404, detail=f"Mídia {mid} não encontrada")


@router.post("/bulk", response_model=JobOut)
def generate_bulk(
    body: BulkRequest,
    background: BackgroundTasks,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    if not body.base_media_ids:
        raise HTTPException(status_code=400, detail="Selecione ao menos uma mídia base")
    quantidade = max(1, min(body.quantidade, 200))

    # tipos de vídeo habilitados. Back-compat: use_flash antigo vira o tipo "pause".
    tipos = list(dict.fromkeys(body.video_types))  # remove duplicatas, mantém ordem
    if body.use_flash and "pause" not in tipos:
        tipos.append("pause")
    validos = {"pause", "imagem", "final", "texto"}
    invalidos = [t for t in tipos if t not in validos]
    if invalidos:
        raise HTTPException(status_code=400, detail=f"Tipos de vídeo inválidos: {invalidos}")

    # tipo de frase efetivo por tipo de vídeo (o do tipo, ou o global como fallback)
    text_types = {k: v for k, v in body.text_types.items() if v}

    def _pt_do_tipo(t: str) -> int | None:
        return text_types.get(t) or body.phrase_type_id

    # IA de texto precisa de ao menos um tipo de frase de referência (global ou por tipo)
    if body.use_ia_texto and not (text_types or body.phrase_type_id is not None):
        raise HTTPException(status_code=400, detail="Para a IA de texto, escolha um tipo de frase em algum tipo de vídeo")

    # pré-condições por tipo de vídeo
    if "pause" in tipos and not body.hot_media_ids:
        raise HTTPException(status_code=400, detail='O tipo "pause" exige ao menos uma foto hot')
    if "imagem" in tipos:
        if not body.overlay_media_ids:
            raise HTTPException(status_code=400, detail='O tipo "imagem estática" exige ao menos uma imagem')
        if _pt_do_tipo("imagem") is None:
            raise HTTPException(status_code=400, detail='O tipo "imagem estática" exige um tipo de frase (textos)')
    if "final" in tipos and not body.final_media_ids:
        raise HTTPException(status_code=400, detail='O tipo "clipe final" exige ao menos um clipe')
    if "texto" in tipos and _pt_do_tipo("texto") is None:
        raise HTTPException(status_code=400, detail='O tipo "apenas texto" exige um tipo de frase (textos)')

    def _clamp01(v: float) -> float:
        return max(0.0, min(1.0, v))

    # todas as mídias precisam ser do próprio usuário
    _owned_media_ids(
        db,
        body.base_media_ids + body.music_media_ids + body.hot_media_ids
        + body.overlay_media_ids + body.final_media_ids,
        user.id,
    )
    # todos os tipos de frase usados (global + por tipo) precisam ser do usuário
    pt_ids = set(text_types.values())
    if body.phrase_type_id is not None:
        pt_ids.add(body.phrase_type_id)
    for pid in pt_ids:
        pt = db.get(PhraseType, pid)
        if not pt or pt.user_id != user.id:
            raise HTTPException(status_code=404, detail=f"Tipo de frase {pid} não encontrado")

    # range de duração: clamp em [1, 60] e garante min <= max
    dur_min = max(1.0, min(body.duration_min, 60.0))
    dur_max = max(1.0, min(body.duration_max, 60.0))
    dur_min, dur_max = min(dur_min, dur_max), max(dur_min, dur_max)

    job = Job(user_id=user.id, status="fila", total=quantidade, concluidos=0)
    db.add(job)
    db.commit()
    db.refresh(job)

    cfg = BulkConfig(
        user_id=user.id,
        quantidade=quantidade,
        base_media_ids=body.base_media_ids,
        music_media_ids=body.music_media_ids,
        phrase_type_id=body.phrase_type_id,
        text_types=text_types,
        use_ia_texto=body.use_ia_texto,
        gerar_legenda_ia=body.gerar_legenda_ia,
        duration_min=dur_min,
        duration_max=dur_max,
        video_types=tipos,
        hot_media_ids=body.hot_media_ids,
        overlay_media_ids=body.overlay_media_ids,
        final_media_ids=body.final_media_ids,
        font_id=body.font_id,
        text_x=_clamp01(body.text_x),
        text_y=_clamp01(body.text_y),
        overlay_x=_clamp01(body.overlay_x),
        overlay_y=_clamp01(body.overlay_y),
    )
    background.add_task(bulk.run_bulk_job, job.id, cfg)
    return job


@router.get("/jobs/{job_id}", response_model=JobOut)
def get_job(job_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    job = db.get(Job, job_id)
    if not job or job.user_id != user.id:
        raise HTTPException(status_code=404, detail="Job não encontrado")
    return job


# ---------- Histórico (Fase 6, alimentado pela geração em massa) ----------
@router.get("/history", response_model=list[GeneratedVideoOut])
def history(job_id: int | None = None, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    stmt = select(GeneratedVideo).where(GeneratedVideo.user_id == user.id).order_by(GeneratedVideo.criado_em.desc())
    if job_id is not None:
        stmt = stmt.where(GeneratedVideo.job_id == job_id)
    return list(db.scalars(stmt))


class DeleteBatch(BaseModel):
    ids: list[int]


@router.post("/history/delete")
def delete_history_batch(body: DeleteBatch, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """Apaga vários vídeos gerados de uma vez (arquivo no disco + registro)."""
    removidos = 0
    for vid in body.ids:
        gv = db.get(GeneratedVideo, vid)
        if gv and gv.user_id == user.id:
            (settings.storage_path / gv.caminho).unlink(missing_ok=True)
            db.delete(gv)
            removidos += 1
    db.commit()
    return {"removidos": removidos}


@router.get("/history/zip")
def download_history_zip(
    ids: str = Query(..., description="ids separados por vírgula, ex.: 1,2,3"),
    db: Session = Depends(get_db),
    user: User = Depends(get_user_for_file),
):
    """Empacota vários vídeos gerados em um único .zip para download.

    GET (com ?token= na URL) para que o download possa ser disparado por um link
    direto <a download>, igual aos downloads individuais — evita o bloqueio de
    download programático via fetch/blob em alguns navegadores.
    """
    try:
        id_list = [int(x) for x in ids.split(",") if x.strip()]
    except ValueError:
        raise HTTPException(status_code=400, detail="ids inválidos")

    videos = []
    for vid in id_list:
        gv = db.get(GeneratedVideo, vid)
        if gv and gv.user_id == user.id:
            path = settings.storage_path / gv.caminho
            if path.exists():
                videos.append((gv, path))
    if not videos:
        raise HTTPException(status_code=404, detail="Nenhum vídeo encontrado")

    buf = io.BytesIO()
    usados: set[str] = set()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for gv, path in videos:
            base = f"video_{gv.id}.mp4"
            nome = base
            n = 1
            while nome in usados:  # evita colisão de nomes iguais no zip
                nome = f"video_{gv.id}_{n}.mp4"
                n += 1
            usados.add(nome)
            zf.write(path, arcname=nome)
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="videos.zip"'},
    )


@router.get("/{video_id}/download")
def download_video(video_id: int, db: Session = Depends(get_db), user: User = Depends(get_user_for_file)):
    gv = db.get(GeneratedVideo, video_id)
    if not gv or gv.user_id != user.id:
        raise HTTPException(status_code=404, detail="Vídeo não encontrado")
    path = settings.storage_path / gv.caminho
    if not path.exists():
        raise HTTPException(status_code=404, detail="Arquivo não existe no disco")
    return FileResponse(path, filename=f"video_{video_id}.mp4", media_type="video/mp4")
