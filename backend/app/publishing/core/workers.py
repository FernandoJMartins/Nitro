"""Global Queue -> Account Queue -> AccountWorker (Seção 19), sem Celery/Redis por
enquanto (mesmo padrão de app/services/bulk.py — para escalar de verdade, trocar por
uma fila durável). Cada ciclo é isolado por conta: uma conta com proxy/sessão
quebrada nunca impede as outras de continuar (Seção 4 e 20).

Concorrência: as contas com publicações devidas executam EM PARALELO (um slot por
conta, limitado por settings.publishing_concurrency); dentro de cada conta as
publicações seguem em sequência (fila própria) — nunca há duas publicações da
mesma conta ao mesmo tempo.
"""
from __future__ import annotations

import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from sqlalchemy import select

from ...config import settings
from ...database import SessionLocal
from ..models import Account, Publication
from .publications import execute_publication, reconcile_stale_publications
from .scheduling import build_schedule_for_account
from .stories import ensure_daily_stories

logger = logging.getLogger("nitro.publishing")

CYCLE_SECONDS = 20
_stop_event = threading.Event()


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def _run_account_queue(account_id: int, pub_ids: list[int]) -> None:
    """Executa a fila devida DE UMA conta, em sessão própria (isolamento total).
    Roda numa thread separada — uma conta lenta não segura as demais."""
    db = SessionLocal()
    try:
        account = db.get(Account, account_id)
        if account is None or not account.ativa or account.automation_status == "pausada":
            return
        for pub_id in pub_ids:
            if account.status != "pronta" or not account.ativa or account.automation_status == "pausada":
                # sessão/proxy quebrou no meio da fila desta conta — as demais publicações
                # dela ficam para depois da reautenticação; outras contas seguem normalmente.
                break
            pub = db.get(Publication, pub_id)
            if pub is None or pub.status not in ("PENDING", "RETRYING"):
                continue
            try:
                execute_publication(db, pub)
            except Exception:  # noqa: BLE001 — isolamento por publicação
                logger.exception("Falha ao executar publicação %s (conta %s)", pub.id, account_id)
    finally:
        db.close()


def run_cycle() -> None:
    """1 ciclo do scheduler: reconcilia publicações presas, refaz o calendário de cada
    conta pronta, gera os stories do dia quando configurados, e executa o que estiver devido.
    """
    db = SessionLocal()
    try:
        reconcile_stale_publications(db)

        accounts = list(db.scalars(select(Account).where(Account.status == "pronta")))
        for account in accounts:
            if not account.ativa or account.automation_status == "pausada":
                continue
            try:
                if account.stories_enabled:
                    ensure_daily_stories(db, account)
                build_schedule_for_account(db, account)
            except Exception:  # noqa: BLE001 — isolamento por conta
                logger.exception("Falha ao agendar conta %s", account.id)

        now = datetime.now(timezone.utc)
        # execute() (não scalars!): duas colunas — scalars devolveria só a primeira
        due = db.execute(
            select(Publication.id, Publication.account_id).where(
                Publication.status.in_(("PENDING", "RETRYING")),
                Publication.scheduled_at <= now,
            )
        ).all()
        # fila própria por conta: agrupa as publicações devidas e executa cada conta
        # numa thread (no máximo settings.publishing_concurrency contas em paralelo).
        grupos: dict[int, list[int]] = {}
        for pub_id, account_id in due:
            grupos.setdefault(account_id, []).append(pub_id)
        db.expire_all()
        if grupos:
            max_workers = max(1, min(settings.publishing_concurrency, len(grupos)))
            with ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="pub-account") as pool:
                list(pool.map(lambda item: _run_account_queue(item[0], item[1]), grupos.items()))
    finally:
        db.close()


def _loop() -> None:
    while not _stop_event.is_set():
        try:
            run_cycle()
        except Exception:  # noqa: BLE001 — o loop nunca pode morrer
            logger.exception("Falha no ciclo do scheduler de publicação")
        _stop_event.wait(CYCLE_SECONDS)


def start_background_scheduler() -> None:
    thread = threading.Thread(target=_loop, name="publishing-scheduler", daemon=True)
    thread.start()
