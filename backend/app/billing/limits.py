"""Regras de acesso e de limite por plano. Toda checagem passa por aqui.

Erros de plano usam HTTP 402 (Payment Required) com um `detail` legível — o
frontend mostra a mensagem e oferece a tela de planos.
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import exists, func, select
from sqlalchemy.orm import Session

from ..models import Job, User
from .plans import ADMIN_PLAN, Plan, get_plan

# status da assinatura Stripe que liberam o sistema. past_due = cobrança falhou
# e a Stripe ainda está tentando de novo (smart retries) — mantém o acesso até
# ela desistir (aí vira canceled/unpaid e o webhook bloqueia).
STATUS_COM_ACESSO = {"active", "trialing", "past_due"}


def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def has_access(user: User) -> bool:
    """O usuário pode usar o sistema agora?"""
    if user.is_admin:
        return True
    if user.bloqueado:
        return False
    manual = _aware(user.acesso_manual_ate)
    if manual and manual > datetime.now(timezone.utc) and get_plan(user.plano):
        return True
    return bool(get_plan(user.plano)) and (user.assinatura_status or "") in STATUS_COM_ACESSO


def effective_plan(user: User) -> Plan | None:
    """Plano que vale para o usuário (ADMIN_PLAN para admins; None = sem acesso)."""
    if user.is_admin:
        return ADMIN_PLAN
    if not has_access(user):
        return None
    return get_plan(user.plano)


def require_plan(user: User) -> Plan:
    plan = effective_plan(user)
    if plan is None:
        raise HTTPException(402, "Sua assinatura não está ativa. Escolha um plano para continuar.")
    return plan


def require_feature(user: User, feature: str, nome: str) -> None:
    """Bloqueia funções que o plano não inclui (ex.: 'ia', 'upscale', 'api_keys')."""
    plan = require_plan(user)
    if not getattr(plan, feature):
        raise HTTPException(402, f"{nome} não está incluído no plano {plan.nome}. Faça upgrade para usar.")


# ---------------- geração em massa ----------------
def _inicio_do_mes(agora: datetime | None = None) -> datetime:
    agora = agora or datetime.now(timezone.utc)
    return agora.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def videos_gerados_no_mes(db: Session, user_id: int) -> int:
    """Vídeos gerados em massa no mês corrente (UTC). Conta pelos JOBS (que nunca
    são apagados pela retenção nem pelo usuário — apagar vídeo não devolve cota):
    lote terminado conta o que de fato gerou; lote em andamento reserva o total."""
    inicio = _inicio_do_mes()
    rows = db.execute(
        select(Job.status, Job.total, Job.concluidos).where(Job.user_id == user_id, Job.criado_em >= inicio)
    ).all()
    total = 0
    for status, tot, conc in rows:
        total += (conc or 0) if status in ("concluido", "erro") else (tot or 0)
    return total


def check_bulk(db: Session, user: User, quantidade: int) -> int:
    """Valida um pedido de geração em massa. Retorna a quantidade permitida (o
    lote é recusado — não cortado — se passar do limite, para não surpreender)."""
    plan = require_plan(user)
    if quantidade > plan.max_por_lote:
        raise HTTPException(402, f"O plano {plan.nome} gera até {plan.max_por_lote} vídeos por lote.")
    usados = videos_gerados_no_mes(db, user.id)
    restante = max(0, plan.videos_por_mes - usados)
    if quantidade > restante:
        raise HTTPException(
            402,
            f"Limite mensal do plano {plan.nome}: {plan.videos_por_mes} vídeos. "
            f"Você já gerou {usados} este mês (restam {restante}).",
        )
    return quantidade


# ---------------- contas conectadas ----------------
def check_new_account(db: Session, user: User) -> None:
    from ..publishing.models import Account

    plan = require_plan(user)
    n = db.scalar(select(func.count(Account.id)).where(Account.user_id == user.id)) or 0
    if n >= plan.max_contas:
        raise HTTPException(402, f"O plano {plan.nome} permite até {plan.max_contas} perfis conectados.")


def allowed_account_ids(db: Session) -> set[int]:
    """Contas que o scheduler pode operar: dono com acesso ativo e, se o dono tem
    mais contas que o plano permite (ex.: fez downgrade), só as N mais antigas."""
    from ..publishing.models import Account

    rows = db.execute(select(Account.id, Account.user_id).order_by(Account.criado_em, Account.id)).all()
    por_user: dict[int, list[int]] = {}
    for acc_id, uid in rows:
        por_user.setdefault(uid, []).append(acc_id)
    permitidas: set[int] = set()
    for uid, ids in por_user.items():
        user = db.get(User, uid)
        plan = effective_plan(user) if user else None
        if plan is None:
            continue
        permitidas.update(ids[: plan.max_contas])
    return permitidas


# ---------------- calendário ----------------
def reels_no_calendario(db: Session, user_id: int) -> int:
    """Reels na fila de publicação: não rejeitados e ainda sem publicação confirmada."""
    from ..publishing.models import Content, Publication

    publicado = exists().where(Publication.content_id == Content.id, Publication.status == "PUBLISHED")
    return db.scalar(
        select(func.count(Content.id)).where(
            Content.user_id == user_id,
            Content.kind == "reel",
            Content.approval_status != "rejeitado",
            ~publicado,
        )
    ) or 0


def check_calendar(db: Session, user: User, novos: int) -> None:
    plan = require_plan(user)
    atual = reels_no_calendario(db, user.id)
    restante = max(0, plan.max_calendario - atual)
    if novos > restante:
        raise HTTPException(
            402,
            f"O plano {plan.nome} permite {plan.max_calendario} vídeos na fila de publicação. "
            f"Você tem {atual} (cabem mais {restante}).",
        )


# ---------------- stories por dia, por ASSINATURA ----------------
# O limite é do plano inteiro, somando todas as contas do usuário: no Básico
# (5/dia) dá para postar 5 stories numa conta só, ou 1 em cada uma de 5 contas.
# "Dia" = dia local no fuso padrão do usuário (Publicação > padrões), senão São Paulo.
def _user_tz(db: Session, user_id: int):
    from zoneinfo import ZoneInfo

    from ..publishing.models import PublishingDefaults

    d = db.scalar(select(PublishingDefaults).where(PublishingDefaults.user_id == user_id))
    nome = ((d.timezone if d else None) or "America/Sao_Paulo").strip() or "America/Sao_Paulo"
    try:
        return ZoneInfo(nome)
    except Exception:  # noqa: BLE001
        return ZoneInfo("America/Sao_Paulo")


def _dia_utc(db: Session, user_id: int) -> tuple[datetime, datetime]:
    tz = _user_tz(db, user_id)
    dia = datetime.now(timezone.utc).astimezone(tz).date()
    ini = datetime.combine(dia, time(0, 0), tzinfo=tz).astimezone(timezone.utc)
    return ini, ini + timedelta(days=1)


def stories_hoje(db: Session, user_id: int) -> int:
    """Stories de TODAS as contas do usuário hoje (não conta cancelados nem falhos)."""
    from ..publishing.models import Account, Content, Publication

    ini, fim = _dia_utc(db, user_id)
    return db.scalar(
        select(func.count(Publication.id))
        .join(Content, Content.id == Publication.content_id)
        .join(Account, Account.id == Publication.account_id)
        .where(
            Account.user_id == user_id,
            Content.kind == "story",
            Publication.status.not_in(("CANCELLED", "FAILED")),
            Publication.scheduled_at >= ini,
            Publication.scheduled_at < fim,
        )
    ) or 0


def stories_restantes_hoje(db: Session, account, dia: date | None = None) -> int:
    """Saldo de stories de hoje da ASSINATURA do dono desta conta."""
    owner = db.get(User, account.user_id)
    plan = effective_plan(owner) if owner else None
    if plan is None:
        return 0
    return max(0, plan.stories_por_dia - stories_hoje(db, account.user_id))


def check_story(db: Session, account) -> None:
    if stories_restantes_hoje(db, account) <= 0:
        owner = db.get(User, account.user_id)
        plan = effective_plan(owner) if owner else None
        if plan is None:
            raise HTTPException(402, "Sua assinatura não está ativa. Escolha um plano para continuar.")
        raise HTTPException(
            402, f"Limite do plano {plan.nome}: {plan.stories_por_dia} stories por dia, somando todas as contas."
        )


# ---------------- mídias (quantidade e espaço) ----------------
def midias_do_usuario(db: Session, user_id: int) -> tuple[int, int]:
    """(quantidade de mídias, bytes usados). Espaço = biblioteca + imagens ampliadas."""
    from ..models import Media, UpscaledImage

    n, b = db.execute(
        select(func.count(Media.id), func.coalesce(func.sum(Media.tamanho_bytes), 0)).where(Media.user_id == user_id)
    ).one()
    up = db.scalar(
        select(func.coalesce(func.sum(UpscaledImage.tamanho_bytes), 0)).where(UpscaledImage.user_id == user_id)
    )
    return int(n or 0), int(b or 0) + int(up or 0)


def check_media(db: Session, user_id: int, novos_bytes: int = 0, novos_arquivos: int = 1) -> None:
    """Antes de salvar um arquivo: cabe na quantidade e no espaço do plano?"""
    user = db.get(User, user_id)
    plan = require_plan(user)
    n, usados = midias_do_usuario(db, user_id)
    if n + novos_arquivos > plan.max_midias:
        raise HTTPException(
            402, f"O plano {plan.nome} permite até {plan.max_midias} mídias. Você tem {n}: apague algumas ou faça upgrade."
        )
    limite = int(plan.armazenamento_gb * 1024**3)
    if usados + novos_bytes > limite:
        raise HTTPException(
            402,
            f"Espaço do plano {plan.nome} cheio: {usados / 1024**3:.2f} GB de {plan.armazenamento_gb:g} GB. "
            "Apague mídias ou faça upgrade.",
        )


# ---------------- resumo (tela de planos) ----------------
def usage_summary(db: Session, user: User) -> dict:
    from ..publishing.models import Account

    contas = list(db.scalars(select(Account).where(Account.user_id == user.id).order_by(Account.criado_em)))
    return {
        "videos_mes": videos_gerados_no_mes(db, user.id),
        "contas": len(contas),
        "calendario": reels_no_calendario(db, user.id),
        "stories_hoje": stories_hoje(db, user.id),
        "midias": midias_do_usuario(db, user.id)[0],
        "armazenamento_bytes": midias_do_usuario(db, user.id)[1],
    }
