"""Ciclo de execução de uma Publication (Seção 12):
PENDING -> UPLOADING -> PROCESSING -> PUBLISHED (ou FAILED/RETRYING).

Iniciar o upload nunca é tratado como "publicado" — só confirma quando o
adapter confirma de verdade (Seção 12). Erros ficam isolados na conta/
publicação atual e nunca derrubam as demais (Seção 20 — retry controlado,
nunca loop infinito).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ... import security
from ...config import settings
from ..models import Account, AudioAsset, Content, Proxy, Publication
from ..platforms.base import PlatformAdapter, PublishContext, SessionExpiredError
from ..platforms.instagram import InstagramAdapter
from .audio import provider_for_mode
from .captions import pick_caption_for_account
from .logging import log_event
from .proxies import check_proxy

MAX_TENTATIVAS = 3
RETRY_BACKOFF = timedelta(minutes=5)
STALE_TIMEOUT = timedelta(minutes=15)  # UPLOADING/PROCESSING presos além disso = inconclusivo

ADAPTERS: dict[str, type[PlatformAdapter]] = {
    "instagram": InstagramAdapter,
}


def adapter_for_platform(platform: str, proxy: dict | None = None) -> PlatformAdapter:
    """Instancia o adapter da plataforma com o proxy DESTA conta — o contexto de
    execução é por conta e nunca é compartilhado entre contas."""
    cls = ADAPTERS.get(platform)
    if cls is None:
        raise ValueError(f"nenhum PlatformAdapter registrado para '{platform}'")
    return cls(proxy=proxy)


def _proxy_dict(proxy: Proxy | None) -> dict | None:
    if proxy is None:
        return None
    return {
        "protocol": proxy.protocolo,
        "host": proxy.host,
        "port": proxy.porta,
        "username": proxy.usuario,
        "password": proxy.senha,
    }


def _build_context(db: Session, content: Content, account: Account) -> PublishContext:
    caption = content.legenda
    if not caption and account.caption_mode == "automatica":
        caption = pick_caption_for_account(db, account)

    # áudio: o conteúdo pode indicar um áudio específico (manual); senão o provider
    # do modo da conta resolve (ex.: tendências) — nunca mais 'audio_reference=None' fixo.
    audio_reference: str | None = None
    if account.audio_mode != "nenhum":
        audio: AudioAsset | None = None
        if content.audio_id:
            audio = db.get(AudioAsset, content.audio_id)
        else:
            provider = provider_for_mode(account.audio_mode)
            if provider is not None:
                audio = provider.pick(db, account)
        if audio is not None:
            audio_reference = audio.referencia or audio.external_id or audio.nome

    # mídias extras do content (story com várias imagens) — a ordem importa
    media_paths = [str(settings.storage_path / m.caminho) for m in content.media]

    return PublishContext(
        account_username=account.username,
        account_password=security.decrypt_secret(account.senha_enc) if account.senha_enc else None,
        session_data=account.session_data,
        proxy=_proxy_dict(account.proxy),
        media_path=str(settings.storage_path / content.caminho),
        caption=caption,
        audio_reference=audio_reference,
        kind=content.kind,
        story_text=content.legenda if content.kind == "story" else None,
        story_link=content.link,
        story_link_posicao=content.link_posicao,
        story_text_extra=content.texto_extra,
        story_text_extra_x=content.texto_extra_x,
        story_text_extra_y=content.texto_extra_y,
        media_paths=media_paths,
        fingerprint=account.fingerprint,
    )


def execute_publication(db: Session, publication: Publication) -> None:
    """Executa 1 publicação. Erros ficam isolados nesta conta — nunca propagam para as outras."""
    content = publication.content
    account = publication.account

    if not account.ativa:
        raise ValueError(f"Conta @{account.username} está desativada — publicação não será executada.")

    publication.tentativas += 1
    publication.status = "UPLOADING"
    publication.iniciado_em = datetime.now(timezone.utc)
    db.commit()
    log_event(db, "Publicação iniciada", account_id=account.id, publication_id=publication.id)

    if account.proxy is not None:
        proxy = check_proxy(db, account.proxy)
        if proxy.status == "vermelho":
            # Seção 20: proxy indisponível pausa a CONTA (não só esta publicação) — nunca
            # segue publicando por uma conexão inesperada. As outras contas continuam normalmente.
            account.automation_status = "pausada"
            db.commit()
            _fail_or_retry(db, publication, account, f"Proxy indisponível: {proxy.ultimo_erro}")
            return
        publication.proxy_id_usado = proxy.id

    adapter = adapter_for_platform(account.platform, _proxy_dict(account.proxy))
    ctx = _build_context(db, content, account)
    try:
        adapter.open()
        if not adapter.check_session(ctx):
            account.session_data = adapter.login(ctx)
            account.ultimo_acesso_em = datetime.now(timezone.utc)
            db.commit()
            ctx.session_data = account.session_data

        if content.kind == "story":
            adapter.create_story(ctx)
            if ctx.story_link:
                adapter.attach_link(ctx)
        else:
            adapter.create_reel(ctx)
            if ctx.caption:
                adapter.set_caption(ctx)
            if account.audio_mode != "nenhum":
                adapter.select_audio(ctx)

        publication.upload_concluido_em = datetime.now(timezone.utc)
        publication.status = "PROCESSING"
        db.commit()

        result = adapter.publish(ctx)
        confirmed = adapter.confirm_publication(ctx, result)
        if not confirmed:
            _fail_or_retry(db, publication, account, "Publicação não confirmada pela plataforma")
            return

        publication.status = "PUBLISHED"
        publication.confirmado_em = datetime.now(timezone.utc)
        account.ultimo_post_em = publication.confirmado_em
        account.ultimo_erro = None
        db.commit()
        log_event(db, "Publicação confirmada", account_id=account.id, publication_id=publication.id)

    except SessionExpiredError as exc:
        account.status = "erro"
        account.automation_status = "pausada"
        account.ultimo_erro = f"Sessão expirada: {exc}"
        account.ultimo_erro_em = datetime.now(timezone.utc)
        db.commit()
        _fail_or_retry(db, publication, account, f"Sessão expirada: {exc}")
    except Exception as exc:  # noqa: BLE001 — isola a falha nesta conta/publicação
        _fail_or_retry(db, publication, account, str(exc))
    finally:
        adapter.close()


def _fail_or_retry(db: Session, publication: Publication, account: Account, motivo: str) -> None:
    account.ultimo_erro = motivo
    account.ultimo_erro_em = datetime.now(timezone.utc)
    if publication.tentativas >= MAX_TENTATIVAS:
        publication.status = "FAILED"
        publication.falhou_em = datetime.now(timezone.utc)
        publication.erro = motivo
        db.commit()
        log_event(
            db,
            f"Publicação falhou definitivamente após {publication.tentativas}/{MAX_TENTATIVAS} tentativas: {motivo}",
            account_id=account.id,
            publication_id=publication.id,
            nivel="erro",
        )
    else:
        publication.status = "RETRYING"
        publication.scheduled_at = datetime.now(timezone.utc) + RETRY_BACKOFF * publication.tentativas
        publication.erro = motivo
        db.commit()
        log_event(
            db,
            f"Tentativa {publication.tentativas}/{MAX_TENTATIVAS} falhou, nova tentativa agendada para "
            f"{publication.scheduled_at.isoformat()}: {motivo}",
            account_id=account.id,
            publication_id=publication.id,
            nivel="aviso",
        )


def reconcile_stale_publications(db: Session) -> int:
    """Se o processo foi encerrado no meio de uma publicação (UPLOADING/PROCESSING presos
    além do timeout), trata como inconclusiva com segurança em vez de assumir sucesso (Seção 12).
    """
    limite = datetime.now(timezone.utc) - STALE_TIMEOUT
    presas = list(
        db.scalars(
            select(Publication).where(
                Publication.status.in_(("UPLOADING", "PROCESSING")),
                Publication.iniciado_em < limite,
            )
        )
    )
    for pub in presas:
        _fail_or_retry(db, pub, pub.account, "Processo encerrado antes da confirmação (estado inconclusivo)")
    return len(presas)
