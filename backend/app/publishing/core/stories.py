"""Stories automáticos (Seção 15): um StoryConfig pode ter VÁRIOS StoryPlans por
dia, cada um com uma sequência de imagens (StoryFrame). Cada plan gera 1 Content
(kind='story') por dia, no horário do plan — nada de "1 imagem = 1 story = 1/dia".

Horários dos plans são interpretados no TIMEZONE DA CONTA (não UTC) — o usuário
marca 23:22 e o story sai às 23:22 no relógio dele. A deduplicação do dia é pelo
`ultima_geracao_em` do plan comparado com o dia LOCAL da conta.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ...models import Media
from ..models import (
    Account,
    Content,
    ContentMedia,
    Publication,
    SharedStoryFrame,
    SharedStoryTarget,
    StoryConfig,
    StoryFrame,
    StoryPlan,
)
from .scheduling import _aware, _parse_hhmm, _window_tz


def _scheduled_for(today: date, horario: str, tz) -> datetime:
    """Horário do plan no dia LOCAL da conta, convertido para UTC. Se o horário
    já passou, agenda para daqui a 2 minutos (o usuário quer ver o story sair)."""
    agora = datetime.now(timezone.utc)
    alvo = datetime.combine(today, _parse_hhmm(horario), tzinfo=tz).astimezone(timezone.utc)
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
    tz,
    *,
    link_posicao: str | None = None,
    texto_extra: str | None = None,
    texto_extra_x: float | None = None,
    texto_extra_y: float | None = None,
) -> Content:
    scheduled_at = _scheduled_for(today, horario, tz)
    content = Content(
        user_id=account.user_id,
        kind="story",
        origem="manual",
        caminho=paths[0],
        legenda=texto,
        link=link,
        link_posicao=link_posicao,
        texto_extra=texto_extra,
        texto_extra_x=texto_extra_x,
        texto_extra_y=texto_extra_y,
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


def _ja_gerado_hoje(marcador: datetime | None, tz, today: date) -> bool:
    """Dedup do dia: o marcador (UTC) cai no MESMO dia local da conta?"""
    if marcador is None:
        return False
    return _aware(marcador).astimezone(tz).date() == today


def ensure_daily_stories(db: Session, account: Account, *, today: date | None = None) -> list[Content]:
    """Gera os stories do dia para a conta: um Content por StoryPlan com horário ainda
    não executado hoje (dia LOCAL da conta). Idempotente — chamar de novo no mesmo
    dia não duplica nada (o `ultima_geracao_em` do plan sobrevive a saves: a API de
    story-config atualiza os plans no lugar, sem recriá-los)."""
    cfg = db.scalar(select(StoryConfig).where(StoryConfig.account_id == account.id, StoryConfig.enabled.is_(True)))
    if cfg is None:
        return []

    if not account.ativa:
        return []

    tz = _window_tz(db, account)
    today = today or datetime.now(timezone.utc).astimezone(tz).date()
    agora = datetime.now(timezone.utc)
    created: list[Content] = []

    plans = list(
        db.scalars(select(StoryPlan).where(StoryPlan.story_config_id == cfg.id).order_by(StoryPlan.ordem))
    )
    if not plans:
        # modo legado: config antiga com 1 imagem / 1 horário — comporta-se como um plano único
        if _ja_gerado_hoje(cfg.ultima_geracao_em, tz, today):
            return []
        if not cfg.imagem_media_id:
            return []
        media = db.get(Media, cfg.imagem_media_id)
        if media is None:
            return []
        content = _create_story_content(db, account, [media.caminho], cfg.horario, cfg.texto, cfg.link, today, tz)
        created.append(content)
        cfg.ultima_geracao_em = agora
    else:
        for plan in plans:
            if _ja_gerado_hoje(plan.ultima_geracao_em, tz, today):
                continue
            frames = _frames_of_plan(db, plan)
            if not frames:
                continue
            paths = [caminho for caminho, _, _ in frames]
            # texto/link do story inteiro vivem no plano; frames antigos (e a config
            # legada) funcionam como fallback, nesta ordem.
            texto = plan.texto or " / ".join(t for _, t, _ in frames if t) or cfg.texto
            link = plan.link or next((lnk for _, _, lnk in frames if lnk), None) or cfg.link
            content = _create_story_content(
                db,
                account,
                paths,
                plan.horario,
                texto,
                link,
                today,
                tz,
                link_posicao=plan.link_posicao,
                texto_extra=plan.texto_extra,
                texto_extra_x=plan.texto_extra_x,
                texto_extra_y=plan.texto_extra_y,
            )
            created.append(content)
            plan.ultima_geracao_em = agora
        if created:
            cfg.ultima_geracao_em = agora

    db.commit()
    for c in created:
        db.refresh(c)
    return created


def _frames_of_shared_plan(db: Session, plan_id: int) -> list[str]:
    """Caminhos das mídias de um SharedStoryPlan, na ordem — mesma ideia de
    ``_frames_of_plan``, sem texto/link por frame (só existem no StoryPlan legado)."""
    frames = list(
        db.scalars(
            select(SharedStoryFrame).where(SharedStoryFrame.shared_story_plan_id == plan_id).order_by(SharedStoryFrame.ordem)
        )
    )
    caminhos: list[str] = []
    for frame in frames:
        media = db.get(Media, frame.media_id)
        if media is not None:
            caminhos.append(media.caminho)
    return caminhos


def ensure_daily_shared_stories(db: Session, account: Account, *, today: date | None = None) -> list[Content]:
    """Gera os stories COMPARTILHADOS do dia para a conta: um Content por
    SharedStoryTarget dela com horário ainda não executado hoje (dia LOCAL da
    conta). Mesma ideia de ``ensure_daily_stories``, mas a configuração (texto,
    link, imagens...) é UMA SÓ, compartilhada entre várias contas — só o dedup
    diário (``ultima_geracao_em``) é por conta, porque cada uma tem seu fuso."""
    if not account.ativa:
        return []

    tz = _window_tz(db, account)
    today = today or datetime.now(timezone.utc).astimezone(tz).date()
    agora = datetime.now(timezone.utc)
    created: list[Content] = []

    targets = list(
        db.scalars(
            select(SharedStoryTarget).where(
                SharedStoryTarget.account_id == account.id,
                SharedStoryTarget.plan.has(enabled=True),
            )
        )
    )
    for target in targets:
        if _ja_gerado_hoje(target.ultima_geracao_em, tz, today):
            continue
        plan = target.plan
        paths = _frames_of_shared_plan(db, plan.id)
        if not paths:
            continue
        content = _create_story_content(
            db,
            account,
            paths,
            plan.horario,
            plan.texto,
            plan.link,
            today,
            tz,
            link_posicao=plan.link_posicao,
            texto_extra=plan.texto_extra,
            texto_extra_x=plan.texto_extra_x,
            texto_extra_y=plan.texto_extra_y,
        )
        created.append(content)
        target.ultima_geracao_em = agora

    if created:
        db.commit()
        for c in created:
            db.refresh(c)
    return created


# alias para compatibilidade com código/tests existentes
ensure_daily_story = ensure_daily_stories
