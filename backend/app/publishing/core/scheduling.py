"""Scheduler (Seções 7-9): janelas de tempo persistentes — nunca `sleep(3600); post()`.

Cria o calendário automaticamente após a aprovação (`build_schedule_for_account`)
e também permite agendamento manual de um horário específico (`schedule_specific`).
"""
from __future__ import annotations

import random
from datetime import date, datetime, time, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Account, Content, Publication, PublishingDefaults

DEFAULT_POSTS_PER_HOUR = 4
DEFAULT_WINDOW = ("08:00", "23:00")
JITTER_SECONDS = 90  # pequena variação natural entre posts, evita intervalos idênticos


def _parse_hhmm(value: str) -> time:
    h, m = value.split(":")
    return time(int(h), int(m))


def _aware(dt: datetime) -> datetime:
    """SQLite não guarda timezone (volta naive); Postgres já devolve aware. Normaliza pra UTC."""
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def effective_window(db: Session, account: Account) -> tuple[int, time, time]:
    """Resolve posts/hora e janela: valor da conta, senão o padrão global do usuário."""
    defaults = db.scalar(select(PublishingDefaults).where(PublishingDefaults.user_id == account.user_id))
    posts_hora = account.posts_por_hora or (defaults.posts_por_hora if defaults else DEFAULT_POSTS_PER_HOUR)
    inicio = _parse_hhmm(account.janela_inicio or (defaults.janela_inicio if defaults else DEFAULT_WINDOW[0]))
    fim = _parse_hhmm(account.janela_fim or (defaults.janela_fim if defaults else DEFAULT_WINDOW[1]))
    return posts_hora, inicio, fim


def _window_tz(db: Session, account: Account):
    """Timezone da conta (ou do padrão global) para interpretar a janela. Fallback: UTC."""
    defaults = db.scalar(select(PublishingDefaults).where(PublishingDefaults.user_id == account.user_id))
    nome = (account.timezone or (defaults.timezone if defaults else None) or "UTC").strip() or "UTC"
    try:
        from zoneinfo import ZoneInfo  # noqa: PLC0415

        return ZoneInfo(nome)
    except Exception:  # noqa: BLE001 — nome inválido: interpreta como UTC
        return timezone.utc


def _window_bounds_utc(day: date, inicio: time, fim: time, tz) -> tuple[datetime, datetime]:
    """Janela do dia em UTC. Fim <= início atravessa a meia-noite (ex.: 08:00–00:00
    = das 8h até meia-noite do mesmo dia) — sem isso, o agendamento escapa para
    o dia seguinte a cada lote."""
    start_local = datetime.combine(day, inicio, tzinfo=tz)
    end_local = datetime.combine(day, fim, tzinfo=tz)
    if fim <= inicio:
        end_local += timedelta(days=1)
    return start_local.astimezone(timezone.utc), end_local.astimezone(timezone.utc)


def _existing_slots(db: Session, account_id: int, start: datetime, end: datetime) -> list[datetime]:
    rows = db.scalars(
        select(Publication.scheduled_at).where(
            Publication.account_id == account_id,
            Publication.scheduled_at >= start,
            Publication.scheduled_at < end,
            Publication.status.notin_(("CANCELLED", "FAILED")),
        )
    )
    return sorted(rows)


def _next_free_slot(taken: list[datetime], candidate: datetime, min_gap: timedelta) -> datetime:
    """Empurra o candidato para frente até não colidir com um slot já ocupado."""
    for raw in taken:
        t = _aware(raw)
        if abs((t - candidate).total_seconds()) < min_gap.total_seconds():
            candidate = t + min_gap
    return candidate


def build_schedule_for_account(db: Session, account: Account, *, now: datetime | None = None) -> list[Publication]:
    """Cria Publication (PENDING) para os Content aprovados, atribuídos a esta conta, ainda
    sem publicação e com schedule_mode='automatico'. Distribui os horários dentro da janela
    configurada, respeitando o intervalo de posts/hora e o que já está agendado.
    """
    now = now or datetime.now(timezone.utc)
    if not account.ativa:
        return []
    posts_hora, janela_inicio, janela_fim = effective_window(db, account)
    if posts_hora <= 0:
        return []
    min_gap = timedelta(seconds=max(3600 // posts_hora, 60))
    tz = _window_tz(db, account)
    # o dia é o LOCAL da conta — aprovar de madrugada agenda para HOJE, não para amanhã
    day = now.astimezone(tz).date()

    pendentes = list(
        db.scalars(
            select(Content).where(
                Content.account_id == account.id,
                Content.approval_status == "aprovado",
                Content.schedule_mode == "automatico",
                Content.kind == "reel",
                ~Content.publications.any(),
            )
        )
    )
    if not pendentes:
        return []

    def window_for(d: date) -> tuple[datetime, datetime]:
        return _window_bounds_utc(d, janela_inicio, janela_fim, tz)

    w_start, w_end = window_for(day)
    cursor = max(w_start, now)
    if cursor > w_end:
        day += timedelta(days=1)
        w_start, w_end = window_for(day)
        cursor = w_start

    created: list[Publication] = []
    for content in pendentes:
        taken = _existing_slots(db, account.id, w_start, w_end)
        slot = _next_free_slot(taken, cursor, min_gap)
        if slot > w_end:
            day += timedelta(days=1)
            w_start, w_end = window_for(day)
            taken = _existing_slots(db, account.id, w_start, w_end)
            slot = _next_free_slot(taken, w_start, min_gap)

        jitter = timedelta(seconds=random.randint(-JITTER_SECONDS, JITTER_SECONDS))
        final_slot = max(slot + jitter, now)

        content.scheduled_at = final_slot
        pub = Publication(content_id=content.id, account_id=account.id, status="PENDING", scheduled_at=final_slot)
        db.add(pub)
        created.append(pub)
        cursor = slot + min_gap  # avança a partir do slot "limpo" (sem jitter)

    db.commit()
    return created


def schedule_specific(db: Session, content: Content, when: datetime) -> Publication:
    """Agendamento manual: horário específico escolhido pelo usuário para um Content já aprovado.

    Idempotente por conteúdo: se já existe uma publicação ativa (PENDING/RETRYING),
    apenas reagenda o horário dela — nunca cria uma segunda publicação do mesmo
    conteúdo (que resultaria em post duplicado).
    """
    if content.account_id is None:
        raise ValueError("conteúdo sem conta destinada")
    account = db.get(Account, content.account_id)
    if account is None:
        raise ValueError("conta destinada não encontrada")
    if not account.ativa:
        raise ValueError(f"Conta @{account.username} está desativada — reative-a para programar publicações.")

    ativas = list(
        db.scalars(
            select(Publication).where(
                Publication.content_id == content.id,
                Publication.status.notin_(("CANCELLED", "FAILED")),
            )
        )
    )
    if any(p.status in ("UPLOADING", "PROCESSING") for p in ativas):
        raise ValueError("publicação em execução — aguarde concluir para reagendar.")
    if any(p.status == "PUBLISHED" for p in ativas):
        raise ValueError("conteúdo já publicado — não é possível reagendar.")

    pendentes = [p for p in ativas if p.status in ("PENDING", "RETRYING")]
    if pendentes:
        pub = pendentes[0]
        pub.scheduled_at = when
        pub.erro = None
        if pub.status == "RETRYING":
            pub.status = "PENDING"
        content.schedule_mode = "especifico"
        content.scheduled_at = when
        db.commit()
        db.refresh(pub)
        return pub

    content.schedule_mode = "especifico"
    content.scheduled_at = when
    pub = Publication(content_id=content.id, account_id=content.account_id, status="PENDING", scheduled_at=when)
    db.add(pub)
    db.commit()
    db.refresh(pub)
    return pub
