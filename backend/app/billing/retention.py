"""Retenção de vídeos gerados (disco):

1. Assim que uma postagem é confirmada, o vídeo gerado usado nela é apagado
   (arquivo + registro), já que ele está no Instagram (DELETE_AFTER_PUBLISH).
2. Vídeos gerados que nunca foram agendados/postados são apagados após
   settings.video_retention_days (padrão 3 dias).

Vale para todos, inclusive admins (desligável com VIDEO_RETENTION_INCLUDE_ADMINS=false).
Nunca apaga o arquivo de um vídeo que ainda está na fila de publicação (Content
sem publicação concluída) — senão o post agendado quebraria.
"""
from __future__ import annotations

import logging
import threading
from datetime import datetime, timedelta, timezone

from sqlalchemy import exists, func, select
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
        logger.info("Retenção: %s vídeos gerados não agendados com mais de %s dias apagados", removidos, settings.video_retention_days)
    return removidos


def _ativos_com_arquivo(db: Session, caminho: str) -> bool:
    """Ainda existe conteúdo pendente (sem publicação, ou com publicação em
    andamento) usando este arquivo?"""
    from ..publishing.models import Content, Publication

    pendente = exists().where(
        Publication.content_id == Content.id,
        Publication.status.in_(("PENDING", "RETRYING", "UPLOADING", "PROCESSING")),
    )
    sem_pub = ~exists().where(Publication.content_id == Content.id)
    return bool(
        db.scalar(
            select(func.count(Content.id)).where(
                Content.caminho == caminho, Content.approval_status != "rejeitado", (pendente | sem_pub)
            )
        )
    )


def delete_after_publish(db: Session, content) -> bool:
    """Chamado logo após uma postagem confirmada. Apaga o vídeo GERADO pelo
    Nitro usado nela (mídias enviadas pelo usuário nunca são tocadas).
    Retorna True se apagou."""
    if not settings.delete_after_publish or not content.generated_video_id:
        return False
    try:
        gv = db.get(GeneratedVideo, content.generated_video_id)
        if gv is None:
            return False
        if not settings.video_retention_include_admins:
            dono = db.get(User, gv.user_id) if gv.user_id is not None else None
            if dono and dono.email.lower() in settings.admin_emails_set:
                return False
        if _ativos_com_arquivo(db, gv.caminho):
            return False  # mesmo vídeo ainda agendado em outra postagem
        (settings.storage_path / gv.caminho).unlink(missing_ok=True)
        content.generated_video_id = None
        db.delete(gv)
        db.commit()
        logger.info("Vídeo gerado %s apagado após a publicação", gv.id)
        return True
    except Exception:  # noqa: BLE001 — limpar disco nunca pode quebrar a publicação
        db.rollback()
        logger.exception("Falha ao apagar vídeo publicado")
        return False


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
