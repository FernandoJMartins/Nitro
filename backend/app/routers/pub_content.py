"""Importação de conteúdo, fila de aprovação e redistribuição/agendamento manual
(Seções 6, 8 e 22)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_current_user
from ..models import GeneratedVideo, User
from ..publishing.core.distribution import distribute_uniform, eligible_accounts
from ..publishing.core.scheduling import schedule_specific
from ..publishing.models import Account, Content
from ..publishing.schemas import (
    ApprovalAction,
    ContentEdit,
    ContentOut,
    ImportFromGeneratorRequest,
    PublicationOut,
    RescheduleRequest,
)

router = APIRouter(prefix="/api/v1/publishing/content", tags=["publishing"])


def _get_content(db: Session, user: User, content_id: int) -> Content:
    content = db.get(Content, content_id)
    if content is None or content.user_id != user.id:
        raise HTTPException(404, "Conteúdo não encontrado.")
    return content


@router.get("/importable")
def list_importable(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Vídeos do Sistema A (geração em massa) que ainda não foram importados para publicação."""
    already = set(
        db.scalars(
            select(Content.generated_video_id).where(
                Content.user_id == user.id, Content.generated_video_id.is_not(None)
            )
        )
    )
    videos = db.scalars(
        select(GeneratedVideo)
        .where(GeneratedVideo.user_id == user.id)
        .order_by(GeneratedVideo.criado_em.desc())
        .limit(200)
    )
    return [
        {
            "id": v.id,
            "job_id": v.job_id,
            "caminho": v.caminho,
            "duracao": v.duracao,
            "legenda": v.legenda,
            "criado_em": v.criado_em,
        }
        for v in videos
        if v.id not in already
    ]


@router.post("", response_model=list[ContentOut])
def import_from_generator(
    body: ImportFromGeneratorRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    videos = list(
        db.scalars(
            select(GeneratedVideo).where(
                GeneratedVideo.id.in_(body.generated_video_ids), GeneratedVideo.user_id == user.id
            )
        )
    )
    if not videos:
        raise HTTPException(404, "Nenhum vídeo encontrado para importar.")

    created: list[Content] = []
    for video in videos:
        content = Content(
            user_id=user.id,
            kind="reel",
            origem="gerador",
            generated_video_id=video.id,
            caminho=video.caminho,
            duracao=video.duracao,
            legenda=video.legenda,
        )
        db.add(content)
        created.append(content)
    db.commit()
    for c in created:
        db.refresh(c)

    if body.auto_distribute:
        accounts = eligible_accounts(db, user.id)
        distribute_uniform(db, created, accounts)

    return created


@router.get("", response_model=list[ContentOut])
def list_content(
    approval_status: str | None = None,
    kind: str | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    stmt = select(Content).where(Content.user_id == user.id)
    if approval_status:
        stmt = stmt.where(Content.approval_status == approval_status)
    if kind:
        stmt = stmt.where(Content.kind == kind)
    return list(db.scalars(stmt.order_by(Content.criado_em.desc())))


@router.patch("/{content_id}", response_model=ContentOut)
def edit_content(
    content_id: int, body: ContentEdit, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    content = _get_content(db, user, content_id)
    if content.approval_status != "pendente":
        raise HTTPException(409, "Só é possível editar conteúdo ainda pendente de aprovação.")
    if body.account_id is not None:
        account = db.get(Account, body.account_id)
        if account is None or account.user_id != user.id:
            raise HTTPException(404, "Conta não encontrada.")
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(content, k, v)
    db.commit()
    db.refresh(content)
    return content


@router.post("/approve", response_model=list[ContentOut])
def approve_content(body: ApprovalAction, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    items = list(db.scalars(select(Content).where(Content.id.in_(body.ids), Content.user_id == user.id)))
    for c in items:
        c.approval_status = "aprovado"
    db.commit()
    return items


@router.post("/reject", response_model=list[ContentOut])
def reject_content(body: ApprovalAction, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    items = list(db.scalars(select(Content).where(Content.id.in_(body.ids), Content.user_id == user.id)))
    for c in items:
        c.approval_status = "rejeitado"
    db.commit()
    return items


@router.post("/approve-all")
def approve_all(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    items = list(db.scalars(select(Content).where(Content.user_id == user.id, Content.approval_status == "pendente")))
    for c in items:
        c.approval_status = "aprovado"
    db.commit()
    return {"aprovados": len(items)}


@router.post("/reject-all")
def reject_all(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    items = list(db.scalars(select(Content).where(Content.user_id == user.id, Content.approval_status == "pendente")))
    for c in items:
        c.approval_status = "rejeitado"
    db.commit()
    return {"rejeitados": len(items)}


@router.post("/{content_id}/redistribute", response_model=ContentOut)
def redistribute_content(content_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    content = _get_content(db, user, content_id)
    accounts = eligible_accounts(db, user.id)
    distribute_uniform(db, [content], accounts)
    db.commit()
    db.refresh(content)
    return content


@router.post("/{content_id}/schedule", response_model=PublicationOut)
def schedule_content(
    content_id: int, body: RescheduleRequest, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    content = _get_content(db, user, content_id)
    if content.approval_status != "aprovado":
        raise HTTPException(409, "Só é possível agendar conteúdo aprovado.")
    return schedule_specific(db, content, body.scheduled_at)
