"""Painel admin: os e-mails de settings.admin_emails têm controle total —
veem todos os usuários, uso e assinatura, concedem acesso manual (cortesia,
sem Stripe) e bloqueiam/desbloqueiam usuários."""
from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..billing import limits
from ..billing.plans import PLANS
from ..config import settings
from ..database import get_db
from ..deps import get_admin_user
from ..models import User

router = APIRouter(prefix="/api/v1/admin", tags=["admin"])


def _user_out(db: Session, u: User) -> dict:
    plan = limits.effective_plan(u)
    return {
        "id": u.id,
        "email": u.email,
        "criado_em": u.criado_em,
        "is_admin": u.is_admin,
        "plano": u.plano,
        "assinatura_status": u.assinatura_status,
        "periodo_fim": u.periodo_fim,
        "acesso_manual_ate": u.acesso_manual_ate,
        "bloqueado": u.bloqueado,
        "tem_acesso": plan is not None,
        "uso": limits.usage_summary(db, u),
    }


@router.get("/users")
def list_users(_: User = Depends(get_admin_user), db: Session = Depends(get_db)):
    return [_user_out(db, u) for u in db.scalars(select(User).order_by(User.criado_em.desc()))]


class AdminUserUpdate(BaseModel):
    # concede/estende acesso manual: plano + quantos dias (0 = remove o acesso manual)
    plano: str | None = None
    dias_acesso_manual: int | None = None
    bloqueado: bool | None = None


@router.patch("/users/{user_id}")
def update_user(user_id: int, body: AdminUserUpdate, _: User = Depends(get_admin_user), db: Session = Depends(get_db)):
    u = db.get(User, user_id)
    if not u:
        raise HTTPException(404, "Usuário não encontrado.")
    if body.plano is not None:
        if body.plano not in PLANS:
            raise HTTPException(400, "Plano inválido.")
        u.plano = body.plano
    if body.dias_acesso_manual is not None:
        u.acesso_manual_ate = (
            datetime.now(timezone.utc) + timedelta(days=body.dias_acesso_manual) if body.dias_acesso_manual > 0 else None
        )
    if body.bloqueado is not None:
        if u.is_admin and body.bloqueado:
            raise HTTPException(400, "Não é possível bloquear um administrador.")
        u.bloqueado = body.bloqueado
    db.commit()
    db.refresh(u)
    return _user_out(db, u)


# ---------------- monitoramento (painel "Sistema") ----------------
def _nivel(frac: float, atencao: float, critico: float) -> str:
    return "critico" if frac >= critico else "atencao" if frac >= atencao else "ok"


@router.get("/system")
def system_status(_: User = Depends(get_admin_user), db: Session = Depends(get_db)):
    """Tudo o que o admin precisa ver de uma vez: servidor, banco, agendador,
    publicações e números do negócio. Os alertas vêm prontos (nível + motivo)."""
    from sqlalchemy import func, text

    from ..billing.retention import HEARTBEAT as RET
    from ..models import GeneratedVideo, Job, Media
    from ..publishing.core.workers import CYCLE_SECONDS, HEARTBEAT as SCH
    from ..publishing.models import Account, Publication, PublicationLog
    from ..services import sysinfo

    agora = datetime.now(timezone.utc)
    srv = sysinfo.snapshot(settings.storage_path)
    alertas: list[dict] = []

    def alerta(nivel: str, msg: str) -> None:
        if nivel != "ok":
            alertas.append({"nivel": nivel, "mensagem": msg})

    disco_frac = srv["disco"]["usado"] / max(1, srv["disco"]["total"])
    mem_frac = srv["memoria"]["usado"] / max(1, srv["memoria"]["total"])
    cpu_frac = srv["cpu"]["load5"] / max(1, srv["cpu"]["nucleos"])
    srv["disco"]["nivel"] = _nivel(disco_frac, 0.75, 0.9)
    srv["memoria"]["nivel"] = _nivel(mem_frac, 0.85, 0.95)
    srv["cpu"]["nivel"] = _nivel(cpu_frac, 1.0, 2.0)
    alerta(srv["disco"]["nivel"], f"Disco {disco_frac:.0%} cheio — apague mídias antigas ou aumente o disco.")
    alerta(srv["memoria"]["nivel"], f"Memória em {mem_frac:.0%} — o servidor pode ficar lento.")
    alerta(srv["cpu"]["nivel"], f"CPU sobrecarregada (carga {srv['cpu']['load5']:.1f} em {srv['cpu']['nucleos']} núcleo(s)).")

    # banco
    banco: dict = {"ok": True, "latencia_ms": None, "tamanho": None, "erro": None}
    try:
        t0 = time.perf_counter()
        db.execute(text("SELECT 1"))
        banco["latencia_ms"] = round((time.perf_counter() - t0) * 1000, 1)
        if db.bind.dialect.name == "postgresql":
            banco["tamanho"] = db.scalar(text("SELECT pg_database_size(current_database())"))
    except Exception as exc:  # noqa: BLE001
        banco.update(ok=False, erro=str(exc)[:200])
        alerta("critico", "Banco de dados inacessível.")

    # agendador de publicações
    ult = SCH.get("ultimo_ciclo_em")
    atraso = (agora - ult).total_seconds() if ult else None
    sch_ok = atraso is not None and atraso < CYCLE_SECONDS * 6
    agendador = {
        "ok": sch_ok,
        "ultimo_ciclo_em": ult,
        "segundos_desde_ultimo": atraso,
        "ciclos": SCH.get("ciclos", 0),
        "ultimo_erro": SCH.get("ultimo_erro"),
        "ultimo_erro_em": SCH.get("ultimo_erro_em"),
    }
    if not sch_ok and srv["uptime_app_s"] > CYCLE_SECONDS * 6:
        alerta("critico", "O agendador de publicações parou de rodar.")

    # publicações nas últimas 24h
    desde = agora - timedelta(hours=24)
    por_status = dict(
        db.execute(
            select(Publication.status, func.count(Publication.id))
            .where(Publication.atualizado_em >= desde)
            .group_by(Publication.status)
        ).all()
    )
    pendentes = db.scalar(select(func.count(Publication.id)).where(Publication.status.in_(("PENDING", "RETRYING")))) or 0
    atrasadas = db.scalar(
        select(func.count(Publication.id)).where(
            Publication.status.in_(("PENDING", "RETRYING")), Publication.scheduled_at < agora - timedelta(minutes=30)
        )
    ) or 0
    falhas = por_status.get("FAILED", 0)
    publicadas = por_status.get("PUBLISHED", 0)
    if falhas and falhas >= max(3, publicadas):
        alerta("atencao", f"{falhas} publicações falharam nas últimas 24h.")
    if atrasadas:
        alerta("atencao", f"{atrasadas} publicações atrasadas há mais de 30 min.")
    contas_erro = db.scalar(
        select(func.count(Account.id)).where(Account.ultimo_erro_em.is_not(None), Account.ultimo_erro_em >= desde)
    ) or 0
    erros_recentes = [
        {"em": l.criado_em, "conta_id": l.account_id, "mensagem": (l.mensagem or "")[:240]}
        for l in db.scalars(
            select(PublicationLog).where(PublicationLog.nivel == "erro").order_by(PublicationLog.criado_em.desc()).limit(8)
        )
    ]

    # negócio
    users = list(db.scalars(select(User)))
    clientes = [u for u in users if not u.is_admin]
    pagantes = [u for u in clientes if u.assinatura_status in limits.STATUS_COM_ACESSO and PLANS.get(u.plano or "")]
    cortesia = [
        u for u in clientes
        if u not in pagantes and limits.has_access(u) and not u.bloqueado
    ]
    por_plano = {pid: sum(1 for u in pagantes if u.plano == pid) for pid in PLANS}
    mrr = sum(PLANS[u.plano].preco_mensal for u in pagantes)
    inicio_mes = agora.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    videos_mes = sum(
        (c or 0) if s in ("concluido", "erro") else (t or 0)
        for s, t, c in db.execute(select(Job.status, Job.total, Job.concluidos).where(Job.criado_em >= inicio_mes)).all()
    )
    novos_7d = sum(1 for u in clientes if u.criado_em and limits._aware(u.criado_em) >= agora - timedelta(days=7))

    return {
        "gerado_em": agora,
        "alertas": alertas,
        "servidor": srv,
        "banco": banco,
        "agendador": agendador,
        "retencao": {**RET, "dias": settings.video_retention_days},
        "publicacoes": {
            "ultimas_24h": por_status,
            "pendentes": pendentes,
            "atrasadas": atrasadas,
            "contas_com_erro_24h": contas_erro,
            "erros_recentes": erros_recentes,
        },
        "negocio": {
            "usuarios": len(clientes),
            "novos_7d": novos_7d,
            "pagantes": len(pagantes),
            "cortesia": len(cortesia),
            "sem_acesso": len(clientes) - len(pagantes) - len(cortesia),
            "por_plano": por_plano,
            "mrr": mrr,
            "videos_gerados_mes": videos_mes,
            "midias": db.scalar(select(func.count(Media.id))) or 0,
            "videos_guardados": db.scalar(select(func.count(GeneratedVideo.id))) or 0,
            "contas_instagram": db.scalar(select(func.count(Account.id))) or 0,
        },
    }
