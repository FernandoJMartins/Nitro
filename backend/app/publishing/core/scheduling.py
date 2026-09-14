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
SELECTED_OFFSET_SECONDS = 15 * 60  # offset aleatório (±15min) em torno do horário selecionado
SELECTED_MIN_GAP = timedelta(minutes=30)  # colisão com publicação existente perto do horário selecionado


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


def effective_cadence(db: Session, account: Account) -> tuple[int, float] | None:
    """Resolve a cadência "X posts a cada Y horas": valor da conta, senão o padrão
    global. Retorna None quando nenhuma cadência está configurada — nesse caso o
    agendamento usa o teto posts/hora tradicional."""
    x = account.posts_por_ciclo
    y = account.horas_por_ciclo
    if not (x and y):
        defaults = db.scalar(select(PublishingDefaults).where(PublishingDefaults.user_id == account.user_id))
        if defaults and defaults.posts_por_ciclo and defaults.horas_por_ciclo:
            x, y = defaults.posts_por_ciclo, defaults.horas_por_ciclo
        else:
            return None
    if x <= 0 or y <= 0:
        return None
    return x, float(y)


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


def effective_selected_hours(db: Session, account: Account) -> list[time] | None:
    """Resolve os horários selecionados da conta (senão do padrão global). None quando
    nada foi selecionado — nesse caso o agendamento usa cadência/posts-hora."""
    selecionados = account.horarios_selecionados
    if not selecionados:
        defaults = db.scalar(select(PublishingDefaults).where(PublishingDefaults.user_id == account.user_id))
        selecionados = defaults.horarios_selecionados if defaults else None
    if not selecionados:
        return None
    horas: list[time] = []
    for item in selecionados:
        try:
            horas.append(_parse_hhmm(item))
        except (ValueError, AttributeError, TypeError):
            continue
    return sorted(set(horas)) or None


def _build_selected_hours_schedule(
    db: Session, account: Account, pendentes: list[Content], horarios: list[time], now: datetime
) -> list[Publication]:
    """Agenda cada conteúdo em um horário selecionado pelo operador: 1 post por horário
    por dia, com offset aleatório de ±15min para nunca repetir o horário exato. Só usa
    horários que caem dentro da janela configurada; o que não couber hoje vai para o
    próximo dia (mesmo padrão do agendamento por janela).
    """
    _, janela_inicio, janela_fim = effective_window(db, account)
    tz = _window_tz(db, account)
    day = now.astimezone(tz).date()

    def _dentro_da_janela(cand: datetime) -> bool:
        # janelas que atravessam a meia-noite: o horário pode pertencer à janela
        # do próprio dia OU à do dia anterior (que invade hoje de madrugada).
        cday = cand.astimezone(tz).date()
        s1, e1 = _window_bounds_utc(cday, janela_inicio, janela_fim, tz)
        s0, e0 = _window_bounds_utc(cday - timedelta(days=1), janela_inicio, janela_fim, tz)
        return (s1 <= cand < e1) or (s0 <= cand < e0)

    def _iter_candidatos():
        d = day
        dias = 0
        while dias < 370:  # horizonte de ~1 ano — só defesa contra fuso/DST bizarro
            for hora in horarios:
                cand = datetime.combine(d, hora, tzinfo=tz).astimezone(timezone.utc)
                if _dentro_da_janela(cand):
                    yield cand
            d += timedelta(days=1)
            dias += 1

    # nenhum horário selecionado cai dentro da janela em dia algum? sem agendamento.
    # (validar antes evita iterar o gerador para sempre nesse caso)
    w1 = _window_bounds_utc(day, janela_inicio, janela_fim, tz)
    w0 = _window_bounds_utc(day - timedelta(days=1), janela_inicio, janela_fim, tz)
    algum_valido = any(
        (w1[0] <= datetime.combine(day, hora, tzinfo=tz).astimezone(timezone.utc) < w1[1])
        or (w0[0] <= datetime.combine(day, hora, tzinfo=tz).astimezone(timezone.utc) < w0[1])
        for hora in horarios
    )
    if not algum_valido:
        return []

    candidatos = _iter_candidatos()
    # pula o passado (aprovou depois do horário de hoje — vai para o próximo)
    cand = next(candidatos, None)
    while cand is not None and cand < now:
        cand = next(candidatos, None)
    if cand is None:
        return []  # nenhum horário selecionado cai dentro da janela

    created: list[Publication] = []
    for content in pendentes:
        # evita colidir com publicações já existentes (agendadas à mão, ex.)
        while True:
            if cand is None:
                return created
            if not _existing_slots(db, account.id, cand - SELECTED_MIN_GAP, cand + SELECTED_MIN_GAP):
                break
            cand = next(candidatos, None)

        offset = timedelta(seconds=random.randint(-SELECTED_OFFSET_SECONDS, SELECTED_OFFSET_SECONDS))
        final_slot = max(cand + offset, now)

        content.scheduled_at = final_slot
        pub = Publication(content_id=content.id, account_id=account.id, status="PENDING", scheduled_at=final_slot)
        db.add(pub)
        created.append(pub)
        cand = next(candidatos, None)

    db.commit()
    return created


def build_schedule_for_account(db: Session, account: Account, *, now: datetime | None = None) -> list[Publication]:
    """Cria Publication (PENDING) para os Content aprovados, atribuídos a esta conta, ainda
    sem publicação e com schedule_mode='automatico'. Distribui os horários dentro da janela
    configurada, respeitando o intervalo de posts/hora e o que já está agendado.
    """
    now = now or datetime.now(timezone.utc)
    if not account.ativa:
        return []

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

    # horários selecionados pelo operador têm prioridade: 1 post por horário/dia,
    # com offset aleatório — substituem cadência e posts/hora.
    horarios = effective_selected_hours(db, account)
    if horarios:
        return _build_selected_hours_schedule(db, account, pendentes, horarios, now)

    posts_hora, janela_inicio, janela_fim = effective_window(db, account)
    cadencia = effective_cadence(db, account)
    if cadencia:
        # "X posts a cada Y horas": espaço médio de Y/X horas entre publicações —
        # um ritmo mais natural/humano que o teto fixo por hora (que cai em spam).
        posts_x, horas_y = cadencia
        min_gap = timedelta(seconds=max(horas_y * 3600 / posts_x, 60))
    else:
        if posts_hora <= 0:
            return []
        min_gap = timedelta(seconds=max(3600 // posts_hora, 60))
    tz = _window_tz(db, account)
    # o dia é o LOCAL da conta — aprovar de madrugada agenda para HOJE, não para amanhã
    day = now.astimezone(tz).date()


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
