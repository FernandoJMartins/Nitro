"""Rotas de mídia: upload (com remoção de metadados), listagem, download, exclusão."""
from __future__ import annotations

import uuid
from pathlib import Path

import requests
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from pydantic import BaseModel

from ..config import settings
from ..database import get_db
from ..deps import get_current_user, get_user_for_file
from ..models import Folder, Media, User
from ..schemas import MediaOut
from ..services import metadata

router = APIRouter(prefix="/api/v1/media", tags=["media"])

# Extensões aceitas por tipo de mídia.
# 'photo'      = foto normal (pode ser base de vídeo)
# 'photo_hot'  = foto hot (usada só no flash do "desafio do pause")
# 'overlay'    = imagem estática sobreposta (tipo de vídeo "imagem estática")
# 'final_clip' = vídeo OU foto exibido no fim (tipo de vídeo "clipe final")
_IMG = {".jpg", ".jpeg", ".png", ".webp"}
_VID = {".mp4", ".mov", ".mkv", ".webm", ".avi"}
_AUDIO = {".mp3", ".wav", ".m4a", ".aac", ".ogg"}
ALLOWED = {
    "video": _VID,
    "photo": _IMG,
    "photo_hot": _IMG,
    "overlay": _IMG,
    "final_clip": _IMG | _VID,  # clipe final pode ser foto ou vídeo
    "music": _AUDIO,
}


def _is_av_ext(ext: str) -> bool:
    """Decide o método de limpeza de metadados pela EXTENSÃO (não pelo tipo).

    Necessário porque 'final_clip' aceita tanto foto (Pillow) quanto vídeo (ffmpeg).
    """
    return ext in _VID or ext in _AUDIO


def _validate_folder(db: Session, folder_id: int | None, user_id: int) -> int | None:
    if folder_id is None:
        return None
    folder = db.get(Folder, folder_id)
    if not folder or folder.user_id != user_id:
        raise HTTPException(status_code=404, detail="Pasta não encontrada")
    return folder_id


def _save_upload(
    tipo: str, upload: UploadFile, db: Session, user_id: int, *, is_trending: bool = False, folder_id: int | None = None
) -> Media:
    ext = Path(upload.filename or "").suffix.lower()
    if ext not in ALLOWED[tipo]:
        raise HTTPException(
            status_code=400,
            detail=f"Extensão '{ext}' não permitida para {tipo}. Aceitas: {sorted(ALLOWED[tipo])}",
        )

    storage = settings.storage_path
    tmp_dir = storage / "_tmp"
    dest_dir = storage / tipo
    tmp_dir.mkdir(parents=True, exist_ok=True)
    dest_dir.mkdir(parents=True, exist_ok=True)

    token = uuid.uuid4().hex
    tmp_path = tmp_dir / f"{token}{ext}"
    final_rel = f"{tipo}/{token}{ext}"
    final_path = storage / final_rel

    # 1) grava o arquivo enviado em um temporário
    try:
        with tmp_path.open("wb") as f:
            while chunk := upload.file.read(1024 * 1024):
                f.write(chunk)

        # 2) remove os metadados escrevendo no caminho final
        if _is_av_ext(ext):
            metadata.strip_av_metadata(tmp_path, final_path)
        else:
            metadata.strip_image_metadata(tmp_path, final_path)
    except Exception as exc:  # noqa: BLE001
        final_path.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail=f"Falha ao processar mídia: {exc}") from exc
    finally:
        tmp_path.unlink(missing_ok=True)

    # 3) registra no banco
    duracao = metadata.probe_duration(final_path) if _is_av_ext(ext) else None
    media = Media(
        user_id=user_id,
        folder_id=folder_id,
        tipo=tipo,
        caminho=final_rel,
        nome_original=upload.filename or f"{token}{ext}",
        duracao=duracao,
        tamanho_bytes=final_path.stat().st_size,
        metadados_removidos=True,
        is_trending=is_trending,
    )
    db.add(media)
    db.commit()
    db.refresh(media)
    return media


@router.post("/video", response_model=MediaOut)
def upload_video(
    file: UploadFile = File(...), folder_id: int | None = None,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
):
    return _save_upload("video", file, db, user.id, folder_id=_validate_folder(db, folder_id, user.id))


@router.post("/photo", response_model=MediaOut)
def upload_photo(
    file: UploadFile = File(...), folder_id: int | None = None,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
):
    return _save_upload("photo", file, db, user.id, folder_id=_validate_folder(db, folder_id, user.id))


@router.post("/photo_hot", response_model=MediaOut)
def upload_photo_hot(
    file: UploadFile = File(...), folder_id: int | None = None,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
):
    return _save_upload("photo_hot", file, db, user.id, folder_id=_validate_folder(db, folder_id, user.id))


@router.post("/overlay", response_model=MediaOut)
def upload_overlay(
    file: UploadFile = File(...), folder_id: int | None = None,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
):
    return _save_upload("overlay", file, db, user.id, folder_id=_validate_folder(db, folder_id, user.id))


@router.post("/final_clip", response_model=MediaOut)
def upload_final_clip(
    file: UploadFile = File(...), folder_id: int | None = None,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
):
    return _save_upload("final_clip", file, db, user.id, folder_id=_validate_folder(db, folder_id, user.id))


@router.post("/music", response_model=MediaOut)
def upload_music(
    file: UploadFile = File(...),
    is_trending: bool = False,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    # músicas são universais: nunca ficam em pasta.
    return _save_upload("music", file, db, user.id, is_trending=is_trending, folder_id=None)


class ImportMusicLink(BaseModel):
    url: str
    is_trending: bool = False


# User-Agent de navegador para o download do arquivo no CDN do Instagram.
_UA_NAVEGADOR = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)


def _save_imported_audio(
    db: Session,
    user_id: int,
    *,
    nome: str,
    content: bytes,
    ext: str,
    is_trending: bool,
) -> Media:
    """Mesmo pipeline do upload (strip de metadados + registro), mas a partir de
    bytes baixados — usado pela importação de áudio por link."""
    if ext not in _AUDIO:
        raise HTTPException(status_code=422, detail=f"Formato do áudio baixado não suportado: {ext}")
    storage = settings.storage_path
    tmp_dir = storage / "_tmp"
    dest_dir = storage / "music"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    dest_dir.mkdir(parents=True, exist_ok=True)

    token = uuid.uuid4().hex
    tmp_path = tmp_dir / f"{token}{ext}"
    final_rel = f"music/{token}{ext}"
    final_path = storage / final_rel
    try:
        tmp_path.write_bytes(content)
        metadata.strip_av_metadata(tmp_path, final_path)
    except Exception as exc:  # noqa: BLE001
        final_path.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail=f"Falha ao processar áudio importado: {exc}") from exc
    finally:
        tmp_path.unlink(missing_ok=True)

    media = Media(
        user_id=user_id,
        folder_id=None,
        tipo="music",
        caminho=final_rel,
        nome_original=nome,
        duracao=metadata.probe_duration(final_path),
        tamanho_bytes=final_path.stat().st_size,
        metadados_removidos=True,
        is_trending=is_trending,
    )
    db.add(media)
    db.commit()
    db.refresh(media)
    return media


@router.post("/music/importar-link", response_model=MediaOut)
def import_music_link(
    body: ImportMusicLink,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """Importa um áudio do Instagram por link (https://www.instagram.com/reels/audio/{id}/).

    Som original: baixa o arquivo completo (progressive_download_url) e salva
    na biblioteca de músicas, como o upload normal. Música licenciada: o
    Instagram não libera o arquivo — devolve 400 com os metadados encontrados.
    Usa a sessão da conta do Instagram conectada mais recentemente.
    """
    from ..publishing.core.publications import _proxy_dict
    from ..publishing.models import Account
    from ..publishing.platforms.base import AdapterError, SessionExpiredError, build_proxy_url
    from ..publishing.platforms.instagram import fetch_audio_por_link

    conta = db.scalar(
        select(Account)
        .where(Account.user_id == user.id, Account.session_data.is_not(None))
        .order_by(Account.ultimo_acesso_em.desc().nullslast())
        .limit(1)
    )
    if conta is None:
        raise HTTPException(
            status_code=400,
            detail="Nenhuma conta do Instagram conectada — conecte uma conta antes de importar áudio por link.",
        )
    try:
        dados = fetch_audio_por_link(body.url, conta.session_data, build_proxy_url(_proxy_dict(conta.proxy)))
    except SessionExpiredError as exc:
        raise HTTPException(
            status_code=400, detail=f"A sessão da conta @{conta.username} expirou — reconecte-a: {exc}"
        ) from exc
    except AdapterError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    download_url = dados.get("download_url")
    if not download_url:
        raise HTTPException(
            status_code=400,
            detail=(
                "Música licenciada — o Instagram não libera o arquivo para download. "
                f"Encontrado: “{dados.get('titulo')}” — artista: {dados.get('artista') or '?'}. "
                "Para usar em vídeos, baixe o áudio de outra fonte e envie pelo upload normal."
            ),
        )

    try:
        resp = requests.get(download_url, stream=True, timeout=90, headers={"User-Agent": _UA_NAVEGADOR})
        resp.raise_for_status()
        content = resp.content  # áudios de reels são curtos (segundos) — ok em memória
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=f"Falha ao baixar o áudio do Instagram: {exc}") from exc

    ctype = (resp.headers.get("Content-Type") or "").lower()
    ext = ".m4a" if ("mp4" in ctype or "m4a" in ctype or "octet-stream" in ctype) else (
        ".mp3" if "mpeg" in ctype else ".m4a"
    )
    artista = dados.get("artista")
    titulo = dados.get("titulo") or "áudio"
    nome = f"@{artista} — {titulo}{ext}" if artista else f"{titulo}{ext}"
    return _save_imported_audio(
        db, user.id, nome=nome, content=content, ext=ext, is_trending=body.is_trending
    )


@router.get("", response_model=list[MediaOut])
def list_media(
    tipo: str | None = None,
    folder_id: int | None = None,
    sem_pasta: bool = False,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    stmt = select(Media).where(Media.user_id == user.id).order_by(Media.criado_em.desc())
    if tipo:
        if tipo not in ALLOWED:
            raise HTTPException(status_code=400, detail=f"tipo inválido: {tipo}")
        stmt = stmt.where(Media.tipo == tipo)
    if sem_pasta:
        stmt = stmt.where(Media.folder_id.is_(None))
    elif folder_id is not None:
        stmt = stmt.where(Media.folder_id == folder_id)
    return list(db.scalars(stmt))


class MoveMedia(BaseModel):
    folder_id: int | None = None


@router.patch("/{media_id}/folder", response_model=MediaOut)
def move_media(media_id: int, body: MoveMedia, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    media = _owned_media(db, media_id, user.id)
    media.folder_id = _validate_folder(db, body.folder_id, user.id)
    db.commit()
    db.refresh(media)
    return media


def _owned_media(db: Session, media_id: int, user_id: int) -> Media:
    media = db.get(Media, media_id)
    if not media or media.user_id != user_id:
        raise HTTPException(status_code=404, detail="Mídia não encontrada")
    return media


@router.get("/{media_id}/download")
def download_media(media_id: int, db: Session = Depends(get_db), user: User = Depends(get_user_for_file)):
    media = _owned_media(db, media_id, user.id)
    path = settings.storage_path / media.caminho
    if not path.exists():
        raise HTTPException(status_code=404, detail="Arquivo não existe no disco")
    return FileResponse(path, filename=media.nome_original)


@router.delete("/{media_id}", status_code=204)
def delete_media(media_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    media = _owned_media(db, media_id, user.id)
    (settings.storage_path / media.caminho).unlink(missing_ok=True)
    db.delete(media)
    db.commit()
