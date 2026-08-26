"""Rotas de pastas para organizar mídias (por usuário).

Uma pasta guarda vídeos + fotos + fotos hot juntos. Músicas são universais
(não usam pasta).
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_current_user
from ..models import Folder, Media, User
from ..schemas import FolderCreate, FolderOut

router = APIRouter(prefix="/api/v1/folders", tags=["folders"])


@router.post("", response_model=FolderOut)
def create_folder(body: FolderCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    nome = body.nome.strip()
    if not nome:
        raise HTTPException(status_code=400, detail="nome é obrigatório")
    if db.scalar(select(Folder).where(Folder.user_id == user.id, Folder.nome == nome)):
        raise HTTPException(status_code=409, detail=f"Você já tem uma pasta '{nome}'")
    folder = Folder(user_id=user.id, nome=nome)
    db.add(folder)
    db.commit()
    db.refresh(folder)
    return folder


@router.get("", response_model=list[FolderOut])
def list_folders(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    return list(db.scalars(select(Folder).where(Folder.user_id == user.id).order_by(Folder.nome)))


@router.delete("/{folder_id}", status_code=204)
def delete_folder(folder_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    folder = db.get(Folder, folder_id)
    if not folder or folder.user_id != user.id:
        raise HTTPException(status_code=404, detail="Pasta não encontrada")
    # as mídias NÃO são apagadas — só saem da pasta.
    db.execute(update(Media).where(Media.folder_id == folder_id).values(folder_id=None))
    db.delete(folder)
    db.commit()
