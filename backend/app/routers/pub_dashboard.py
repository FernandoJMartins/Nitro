"""Dashboard, calendário, fila de publicações e logs de auditoria (Seções 17, 18, 21)."""
from __future__ import annotations

from datetime import datetime, time, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_current_user
from ..models import User
from ..publishing.models import Account, Content, Proxy, Publication, PublicationLog, StoryConfig
from ..publishing.schemas import (
    AccountErrorOut,
    CalendarItem,
    DashboardOut,
    LogOut,
    PublicationOut,
    RescheduleRequest,
    TimelineItem,
)

router = APIRouter(prefix="/api/v1/publishing", tags=["publishing"])


def _today_bounds() -> tuple[datetime, datetime]:
    now = datetime.now(timezone.utc)
    start = datetime.combine(now.date(), time.min, tzinfo=timezone.utc)
    return start, start + timedelta(days=1)


def _aware(dt: datetime) -> datetime:
    """SQLite não guarda timezone (volta naive); Postgres já devolve aware. Normaliza pra UTC."""
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


@router.get("/dashboard", response_model=DashboardOut)
def dashboard(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    start, end = _today_bounds()

    aguardando = len(
        list(db.scalars(select(Content).where(Content.user_id == user.id, Content.approval_status == "pendente")))
    )
    aprovados = len(
        list(db.scalars(select(Content).where(Content.user_id == user.id, Content.approval_status == "aprovado")))
    )

    agendados_hoje = len(
        list(
            db.scalars(
                select(Publication)
                .join(Content)
                .where(
                    Content.user_id == user.id,
                    Publication.scheduled_at >= start,
                    Publication.scheduled_at < end,
                    Publication.status.in_(("PENDING", "RETRYING")),
                )
            )
        )
    )
    publicados_hoje = len(
        list(
            db.scalars(
                select(Publication)
                .join(Content)
                .where(
                    Content.user_id == user.id,
                    Publication.confirmado_em >= start,
                    Publication.confirmado_em < end,
                    Publication.status == "PUBLISHED",
                )
            )
        )
    )
    falhas_hoje = len(
        list(
            db.scalars(
                select(Publication)
                .join(Content)
                .where(
                    Content.user_id == user.id,
                    Publication.falhou_em >= start,
                    Publication.falhou_em < end,
                    Publication.status == "FAILED",
                )
            )
        )
    )

    accounts = list(db.scalars(select(Account).where(Account.user_id == user.id)))
    contas_ativas = sum(1 for a in accounts if a.status == "pronta" and a.automation_status != "pausada")

    # estado real das automações por conta
    sessoes_validas = sum(1 for a in accounts if a.status == "pronta" and a.session_data)
    sessoes_expiradas = sum(1 for a in accounts if a.status == "erro" or (a.senha_configurada and not a.session_data))

    em_execucao = len(
        list(
            db.scalars(
                select(Publication)
                .join(Content)
                .where(Content.user_id == user.id, Publication.status.in_(("UPLOADING", "PROCESSING")))
            )
        )
    )
    retries = len(
        list(
            db.scalars(
                select(Publication)
                .join(Content)
                .where(Content.user_id == user.id, Publication.status == "RETRYING")
            )
        )
    )

    proxies = list(db.scalars(select(Proxy).where(Proxy.user_id == user.id)))
    proxies_ativos = sum(1 for p in proxies if p.status in ("verde", "amarelo"))
    proxies_inativos = len(proxies) - proxies_ativos

    story_cfgs = list(
        db.scalars(select(StoryConfig).join(Account).where(Account.user_id == user.id, StoryConfig.enabled.is_(True)))
    )
    stories_hoje = sum(1 for c in story_cfgs if c.ultima_geracao_em and start <= _aware(c.ultima_geracao_em) < end)

    erros = [a for a in accounts if a.ultimo_erro]
    erros.sort(key=lambda a: a.ultimo_erro_em or a.criado_em, reverse=True)
    ultimos_erros = [
        AccountErrorOut(account_id=a.id, username=a.username, erro=a.ultimo_erro, em=a.ultimo_erro_em)
        for a in erros[:10]
    ]

    return DashboardOut(
        aguardando_aprovacao=aguardando,
        aprovados=aprovados,
        agendados_hoje=agendados_hoje,
        publicados_hoje=publicados_hoje,
        falhas_hoje=falhas_hoje,
        contas_ativas=contas_ativas,
        contas_total=len(accounts),
        proxies_ativos=proxies_ativos,
        proxies_inativos=proxies_inativos,
        proxies_total=len(proxies),
        stories_hoje=stories_hoje,
        stories_configuradas=len(story_cfgs),
        sessoes_validas=sessoes_validas,
        sessoes_expiradas=sessoes_expiradas,
        em_execucao=em_execucao,
        retries=retries,
        ultimos_erros=ultimos_erros,
    )


@router.get("/timeline", response_model=list[TimelineItem])
def timeline(limit: int = Query(30, le=200), user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    pubs = list(
        db.scalars(
            select(Publication)
            .join(Content)
            .where(Content.user_id == user.id)
            .order_by(Publication.scheduled_at.desc())
            .limit(limit)
        )
    )
    return [
        TimelineItem(
            horario=_aware(p.confirmado_em or p.falhou_em or p.scheduled_at),
            account_username=p.account.username,
            status=p.status,
            kind=p.content.kind,
        )
        for p in pubs
    ]


@router.get("/calendar", response_model=list[CalendarItem])
def calendar(
    start: datetime = Query(...),
    end: datetime = Query(...),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    pubs = list(
        db.scalars(
            select(Publication)
            .join(Content)
            .where(Content.user_id == user.id, Publication.scheduled_at >= start, Publication.scheduled_at < end)
            .order_by(Publication.scheduled_at)
        )
    )
    return [
        CalendarItem(
            publication_id=p.id,
            content_id=p.content_id,
            account_id=p.account_id,
            account_username=p.account.username,
            kind=p.content.kind,
            status=p.status,
            scheduled_at=_aware(p.scheduled_at),
            caminho=p.content.caminho,
        )
        for p in pubs
    ]


@router.get("/publications", response_model=list[PublicationOut])
def list_publications(
    account_id: int | None = None,
    status_filter: str | None = Query(None, alias="status"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    stmt = select(Publication).join(Content).where(Content.user_id == user.id)
    if account_id is not None:
        stmt = stmt.where(Publication.account_id == account_id)
    if status_filter:
        stmt = stmt.where(Publication.status == status_filter)
    return list(db.scalars(stmt.order_by(Publication.scheduled_at.desc())))


@router.patch("/publications/{publication_id}/reschedule", response_model=PublicationOut)
def reschedule_publication(
    publication_id: int,
    body: RescheduleRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    pub = db.get(Publication, publication_id)
    if pub is None or pub.content.user_id != user.id:
        raise HTTPException(404, "Publicação não encontrada.")
    if pub.status not in ("PENDING", "RETRYING"):
        raise HTTPException(409, "Só é possível reagendar publicações pendentes.")
    pub.scheduled_at = body.scheduled_at
    pub.content.scheduled_at = body.scheduled_at
    db.commit()
    db.refresh(pub)
    return pub


@router.get("/logs", response_model=list[LogOut])
def list_logs(
    account_id: int | None = None,
    publication_id: int | None = None,
    limit: int = Query(100, le=500),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # PublicationLog não guarda user_id diretamente: filtra pelas contas do usuário.
    account_ids = set(db.scalars(select(Account.id).where(Account.user_id == user.id)))
    stmt = select(PublicationLog).where(PublicationLog.account_id.in_(account_ids))
    if account_id is not None:
        stmt = stmt.where(PublicationLog.account_id == account_id)
    if publication_id is not None:
        stmt = stmt.where(PublicationLog.publication_id == publication_id)
    return list(db.scalars(stmt.order_by(PublicationLog.criado_em.desc()).limit(limit)))
