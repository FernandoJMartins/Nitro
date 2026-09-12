"""Stories automáticos (Seção 15): um StoryConfig pode ter VÁRIOS StoryPlans por
dia, cada um com uma sequência de imagens (StoryFrame). Cada plan gera 1 Content
(kind='story') por dia, no horário do plan — nada de "1 imagem = 1 story = 1/dia".
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ...models import Media
from ..models import Account, Content, ContentMedia, Publication, StoryConfig, StoryFrame, StoryPlan
from .scheduling import _parse_hhmm


def _scheduled_for(today: date, horario: str) -> datetime:
    agora = datetime.now(timezone.utc)
    alvo = datetime.combine(today, _parse_hhmm(horario), tzinfo=timezone.utc)
    if alvo < agora:
        alvo = agora + timedelta(minutes=2)
    return alvo


def _create_story_content(
    db: Session,
    account: Account,
    paths: list[str],
    horario: str,
    texto: str | None,
    link: str | None,
    today: date,
) -> Content:
    scheduled_at = _scheduled_for(today, horario)
    content = Content(
        user_id=account.user_id,
        kind="story",
        origem="manual",
        caminho=paths[0],
        legenda=texto,
        link=link,
        account_id=account.id,
        approval_status="aprovado",  # stories automáticos seguem a config já aprovada pelo usuário
        schedule_mode="especifico",
        scheduled_at=scheduled_at,
    )
    db.add(content)
    db.flush()
    for ordem, caminho in enumerate(paths):
        db.add(ContentMedia(content_id=content.id, caminho=caminho, ordem=ordem))
    db.add(Publication(content_id=content.id, account_id=account.id, status="PENDING", scheduled_at=scheduled_at))
    return content


def _frames_of_plan(db: Session, plan: StoryPlan) -> list[tuple[str, str | None, str | None]]:
    """Resolve os frames do plan para (caminho da mídia, texto, link), na ordem."""
    frames = list(
        db.scalars(select(StoryFrame).where(StoryFrame.story_plan_id == plan.id).order_by(StoryFrame.ordem))
    )
    resolved: list[tuple[str, str | None, str | None]] = []
    for frame in frames:
        media = db.get(Media, frame.media_id)
        if media is None:
            continue
        resolved.append((media.caminho, frame.texto, frame.link))
    return resolved


def ensure_daily_stories(db: Session, account: Account, *, today: date | None = None) -> list[Content]:
    """Gera os stories do dia para a conta: um Content por StoryPlan com horário ainda
    não executado hoje. Idempotente — chamar de novo no mesmo dia não duplica nada."""
    cfg = db.scalar(select(StoryConfig).where(StoryConfig.account_id == account.id, StoryConfig.enabled.is_(True)))
    if cfg is None:
        return []

    today = today or datetime.now(timezone.utc).date()
    agora = datetime.now(timezone.utc)
    created: list[Content] = []

    plans = list(
        db.scalars(select(StoryPlan).where(StoryPlan.story_config_id == cfg.id).order_by(StoryPlan.ordem))
    )
    if not plans:
        # modo legado: config antiga com 1 imagem / 1 horário — comporta-se como um plano único
        if cfg.ultima_geracao_em and cfg.ultima_geracao_em.date() == today:
            return []
        if not cfg.imagem_media_id:
            return []
        media = db.get(Media, cfg.imagem_media_id)
        if media is None:
            return []
        content = _create_story_content(db, account, [media.caminho], cfg.horario, cfg.texto, cfg.link, today)
        created.append(content)
        cfg.ultima_geracao_em = agora
    else:
        for plan in plans:
            if plan.ultima_geracao_em and plan.ultima_geracao_em.date() == today:
                continue
            frames = _frames_of_plan(db, plan)
            if not frames:
                continue
            paths = [caminho for caminho, _, _ in frames]
            texto = " / ".join(t for _, t, _ in frames if t) or cfg.texto
            link = next((lnk for _, _, lnk in frames if lnk), cfg.link)
            content = _create_story_content(db, account, paths, plan.horario, texto, link, today)
            created.append(content)
            plan.ultima_geracao_em = agora
        if created:
            cfg.ultima_geracao_em = agora

    db.commit()
    for c in created:
        db.refresh(c)
    return created


# alias para compatibilidade com código/tests existentes
ensure_daily_story = ensure_daily_stories
