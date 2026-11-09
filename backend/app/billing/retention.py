"""Retenção: vídeos gerados são apagados (arquivo + registro) após
settings.video_retention_days (padrão 30 dias) — para todos, inclusive admins
(desligável com VIDEO_RETENTION_INCLUDE_ADMINS=false).

Nunca apaga o arquivo de um vídeo que ainda está na fila de publicação (Content
importado do gerador sem publicação concluída) — senão o post agendado quebraria.
Esse vídeo é apagado num ciclo seguinte, depois de publicado/cancelado.
"""
from __future__ import annotations

import logging
import threading
from datetime import datetime, timedelta, timezone

from sqlalchemy import exists, select
from sqlalchemy.orm import Session

from ..config import settings
from ..database import SessionLocal
from ..models import GeneratedVideo, User

logger = logging.getLogger("nitro.retention")

INTERVALO_SEGUNDOS = 6 * 3600  # roda a cada 6h
_stop = threading.Event()
HEARTBEAT: dict = {"ultima_execucao_em": None, "removidos": 0}


def purge_expired_videos(db: Session, *, now: datetime | None = None) -> int:
    from ..publishing.models import Content, Publication

    now = now or datetime.now(timezone.utc)
    limite = now - timedelta(days=settings.video_retention_days)

    pendente = exists().where(
        Publication.content_id == Content.id,
        Publication.status.in_(("PENDING", "RETRYING", "UPLOADING", "PROCESSING")),
    )
    # conteúdo ainda sem nenhuma publicação (aguardando aprovação/agendamento) também segura o arquivo
    sem_pub = ~exists().where(Publication.content_id == Content.id)
    em_uso = select(Content.caminho).where(
        Content.approval_status != "rejeitado", (pendente | sem_pub)
    )
    caminhos_em_uso = set(db.scalars(em_uso))

    admins = settings.admin_emails_set
    candidatos = list(db.scalars(select(GeneratedVideo).where(GeneratedVideo.criado_em < limite)))
    removidos = 0
    donos: dict[int | None, bool] = {}
    for gv in candidatos:
        if gv.user_id not in donos:
            u = db.get(User, gv.user_id) if gv.user_id is not None else None
            donos[gv.user_id] = bool(u and u.email.lower() in admins)
        if donos[gv.user_id] and not settings.video_retention_include_admins:
            continue
        if gv.caminho in caminhos_em_uso:
            continue
        (settings.storage_path / gv.caminho).unlink(missing_ok=True)
        db.delete(gv)
        removidos += 1
    db.commit()
    if removidos:
        logger.info("Retenção: %s vídeos gerados com mais de %s dias apagados", removidos, settings.video_retention_days)
    return removidos


def _loop() -> None:
    while not _stop.is_set():
        db = SessionLocal()
        try:
            n = purge_expired_videos(db)
            HEARTBEAT["ultima_execucao_em"] = datetime.now(timezone.utc)
            HEARTBEAT["removidos"] = n
        except Exception:  # noqa: BLE001 — o loop nunca pode morrer
            logger.exception("Falha na retenção de vídeos")
        finally:
            db.close()
        _stop.wait(INTERVALO_SEGUNDOS)


def start_retention_worker() -> None:
    threading.Thread(target=_loop, name="video-retention", daemon=True).start()
