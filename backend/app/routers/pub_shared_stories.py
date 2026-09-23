"""Stories COMPARTILHADOS: 1 story cadastrado uma vez, postado em VÁRIAS contas
escolhidas — evita recadastrar o mesmo story conta por conta (texto, link,
imagens, posições...). Editar e salvar de novo atualiza o story em TODAS as
contas-alvo — fonte única, sem retrabalho.

Complementa (não substitui) o fluxo por conta em pub_accounts.py
(StoryConfig/StoryPlan): os dois convivem, e o scheduler gera os dois tipos
(ver core/workers.py). A publicação em si continua por conta — cada uma tem
sessão/proxy/fingerprint próprios — mas a CONFIGURAÇÃO é uma só.
"""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_current_user
from ..models import User
from ..publishing.core.publications import execute_publication
from ..publishing.core.stories import _frames_of_shared_plan
from ..publishing.models import (
    Account,
    Content,
    ContentMedia,
    Publication,
    SharedStoryFrame,
    SharedStoryPlan,
    SharedStoryTarget,
)
from ..publishing.schemas import SharedStoryOut, SharedStoryUpdate, StoryHistoryOut

router = APIRouter(prefix="/api/v1/publishing", tags=["publishing"])


def _get_shared_plan(db: Session, user: User, plan_id: int) -> SharedStoryPlan:
    plan = db.get(SharedStoryPlan, plan_id)
    if plan is None or plan.user_id != user.id:
        raise HTTPException(404, "Story compartilhado não encontrado.")
    return plan


def _owned_account_ids(db: Session, user: User, account_ids: list[int]) -> None:
    for aid in set(account_ids):
        acc = db.get(Account, aid)
        if acc is None or acc.user_id != user.id:
            raise HTTPException(404, f"Conta {aid} não encontrada.")


def _to_out(db: Session, plan: SharedStoryPlan) -> SharedStoryOut:
    frames = list(
        db.scalars(
            select(SharedStoryFrame).where(SharedStoryFrame.shared_story_plan_id == plan.id).order_by(SharedStoryFrame.ordem)
        )
    )
    targets = list(db.scalars(select(SharedStoryTarget).where(SharedStoryTarget.shared_story_plan_id == plan.id)))
    return SharedStoryOut(
        id=plan.id,
        enabled=plan.enabled,
        horario=plan.horario,
        media_ids=[f.media_id for f in frames],
        texto=plan.texto,
        link=plan.link,
        link_posicao=plan.link_posicao,
        texto_extra=plan.texto_extra,
        texto_extra_x=plan.texto_extra_x,
        texto_extra_y=plan.texto_extra_y,
        account_ids=[t.account_id for t in targets],
        ultima_geracao_por_conta={t.account_id: t.ultima_geracao_em for t in targets},
        criado_em=plan.criado_em,
    )


def _substitui_frames(db: Session, plan: SharedStoryPlan, body: SharedStoryUpdate) -> None:
    for frame in list(db.scalars(select(SharedStoryFrame).where(SharedStoryFrame.shared_story_plan_id == plan.id))):
        db.delete(frame)
    db.flush()
    for ordem, frame in enumerate(body.frames):
        db.add(SharedStoryFrame(shared_story_plan_id=plan.id, media_id=frame.media_id, ordem=ordem))


def _reconcilia_targets(db: Session, plan: SharedStoryPlan, account_ids: list[int]) -> None:
    """Acrescenta/remove contas-alvo SEM mexer no ``ultima_geracao_em`` das que
    continuam — só reseta (implicitamente, criando de novo) quem foi removida e
    voltou depois."""
    existentes = {
        t.account_id: t for t in db.scalars(select(SharedStoryTarget).where(SharedStoryTarget.shared_story_plan_id == plan.id))
    }
    novos = set(account_ids)
    for aid, target in existentes.items():
        if aid not in novos:
            db.delete(target)
    for aid in novos:
        if aid not in existentes:
            db.add(SharedStoryTarget(shared_story_plan_id=plan.id, account_id=aid))


@router.get("/shared-stories", response_model=list[SharedStoryOut])
def list_shared_stories(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    plans = list(db.scalars(select(SharedStoryPlan).where(SharedStoryPlan.user_id == user.id).order_by(SharedStoryPlan.criado_em)))
    return [_to_out(db, p) for p in plans]


@router.post("/shared-stories", response_model=SharedStoryOut)
def create_shared_story(body: SharedStoryUpdate, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    _owned_account_ids(db, user, body.account_ids)
    plan = SharedStoryPlan(
        user_id=user.id,
        enabled=body.enabled,
        horario=body.horario,
        texto=body.texto,
        link=body.link,
        link_posicao=body.link_posicao,
        texto_extra=body.texto_extra,
        texto_extra_x=body.texto_extra_x,
        texto_extra_y=body.texto_extra_y,
    )
    db.add(plan)
    db.flush()
    _substitui_frames(db, plan, body)
    _reconcilia_targets(db, plan, body.account_ids)
    db.commit()
    db.refresh(plan)
    return _to_out(db, plan)


@router.patch("/shared-stories/{plan_id}", response_model=SharedStoryOut)
def update_shared_story(
    plan_id: int, body: SharedStoryUpdate, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    plan = _get_shared_plan(db, user, plan_id)
    _owned_account_ids(db, user, body.account_ids)
    plan.enabled = body.enabled
    plan.horario = body.horario
    plan.texto = body.texto
    plan.link = body.link
    plan.link_posicao = body.link_posicao
    plan.texto_extra = body.texto_extra
    plan.texto_extra_x = body.texto_extra_x
    plan.texto_extra_y = body.texto_extra_y
    _substitui_frames(db, plan, body)
    _reconcilia_targets(db, plan, body.account_ids)
    db.commit()
    db.refresh(plan)
    return _to_out(db, plan)


@router.delete("/shared-stories/{plan_id}", status_code=204)
def delete_shared_story(plan_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    plan = _get_shared_plan(db, user, plan_id)
    db.delete(plan)
    db.commit()


@router.post("/shared-stories/{plan_id}/post-now", response_model=list[StoryHistoryOut])
def post_shared_story_now(plan_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Publica AGORA em TODAS as contas-alvo do story compartilhado (uma de cada
    vez — cada conta isolada: uma falhar não impede as outras). Cada conta conta
    como "já gerada hoje" depois de publicar — não repete no horário normal."""
    plan = _get_shared_plan(db, user, plan_id)
    paths = _frames_of_shared_plan(db, plan.id)
    if not paths:
        raise HTTPException(400, "Story sem imagens — adicione imagens e salve antes de postar.")

    targets = list(db.scalars(select(SharedStoryTarget).where(SharedStoryTarget.shared_story_plan_id == plan.id)))
    if not targets:
        raise HTTPException(400, "Nenhuma conta selecionada para este story.")

    resultados: list[StoryHistoryOut] = []
    for target in targets:
        account = db.get(Account, target.account_id)
        if account is None or not account.ativa or account.status != "pronta":
            continue  # conta indisponível: pula, sem derrubar as outras

        agora = datetime.now(timezone.utc)
        content = Content(
            user_id=account.user_id,
            kind="story",
            origem="manual",
            caminho=paths[0],
            legenda=plan.texto,
            link=plan.link,
            link_posicao=plan.link_posicao,
            texto_extra=plan.texto_extra,
            texto_extra_x=plan.texto_extra_x,
            texto_extra_y=plan.texto_extra_y,
            account_id=account.id,
            approval_status="aprovado",
            schedule_mode="especifico",
            scheduled_at=agora,
        )
        db.add(content)
        db.flush()
        for ordem, caminho in enumerate(paths):
            db.add(ContentMedia(content_id=content.id, caminho=caminho, ordem=ordem))
        pub = Publication(content_id=content.id, account_id=account.id, status="PENDING", scheduled_at=agora)
        db.add(pub)
        db.commit()
        db.refresh(pub)

        if pub.status == "PENDING":
            try:
                execute_publication(db, pub)
                db.refresh(pub)
            except Exception:  # noqa: BLE001 — isolamento por conta: uma falha não derruba as outras
                pass

        if pub.status == "PUBLISHED":
            target.ultima_geracao_em = datetime.now(timezone.utc)
            db.commit()

        resultados.append(
            StoryHistoryOut(
                id=pub.id,
                content_id=pub.content.id,
                status=pub.status,
                scheduled_at=pub.scheduled_at,
                confirmado_em=pub.confirmado_em,
                erro=pub.erro,
                legenda=pub.content.legenda,
                link=pub.content.link,
            )
        )
    return resultados
