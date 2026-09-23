"""Contas/perfis, proxies, configuração global, legendas, áudios e stories (Seções 2-3, 13-16)."""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_current_user
from ..models import User
from .. import security
from ..publishing.core.proxies import check_proxy
from ..publishing.core.publications import _proxy_dict, adapter_for_platform, execute_publication
from ..publishing.core.stories import _frames_of_plan
from ..publishing.core.fingerprint import gerar_fingerprint
from ..publishing.models import (
    Account,
    AudioAsset,
    CaptionTemplate,
    Content,
    ContentMedia,
    Proxy,
    Publication,
    PublishingDefaults,
    StoryConfig,
    StoryFrame,
    StoryPlan,
)
from ..publishing.platforms.base import AdapterError, PublishContext, SessionExpiredError, ThrottledError
from ..publishing.schemas import (
    AccountCreate,
    AccountOut,
    AccountUpdate,
    AudioCreate,
    AudioOut,
    CaptionCreate,
    CaptionOut,
    CaptionUpdate,
    ConnectRequest,
    ProxyCreate,
    ProxyOut,
    ProxyUpdate,
    PublishingDefaultsOut,
    PublishingDefaultsUpdate,
    StoryHistoryOut,
    StoryConfigOut,
    StoryConfigUpdate,
    StoryPlanOut,
)

router = APIRouter(prefix="/api/v1/publishing", tags=["publishing"])


# ---------- Proxies ----------
@router.get("/proxies", response_model=list[ProxyOut])
def list_proxies(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return list(db.scalars(select(Proxy).where(Proxy.user_id == user.id).order_by(Proxy.criado_em.desc())))


@router.post("/proxies", response_model=ProxyOut)
def create_proxy(body: ProxyCreate, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    data = body.model_dump()
    nome_interno = (data.pop("nome_interno") or "").strip()
    proxy = Proxy(user_id=user.id, nome_interno=nome_interno or f"{body.host}:{body.porta}", **data)
    db.add(proxy)
    db.commit()
    db.refresh(proxy)
    return proxy


@router.patch("/proxies/{proxy_id}", response_model=ProxyOut)
def update_proxy(proxy_id: int, body: ProxyUpdate, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    proxy = db.get(Proxy, proxy_id)
    if proxy is None or proxy.user_id != user.id:
        raise HTTPException(404, "Proxy não encontrado.")
    data = body.model_dump(exclude_unset=True)
    senha = data.pop("senha", None)
    if senha:
        proxy.senha = senha
    nome_interno = data.pop("nome_interno", None)
    for k, v in data.items():
        setattr(proxy, k, v)
    if nome_interno is not None:
        # nome interno vazio volta ao padrão (host:porta — já com host/porta novos, se mudaram)
        proxy.nome_interno = nome_interno.strip() or f"{proxy.host}:{proxy.porta}"
    db.commit()
    db.refresh(proxy)
    return proxy


@router.delete("/proxies/{proxy_id}", status_code=204)
def delete_proxy(proxy_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    proxy = db.get(Proxy, proxy_id)
    if proxy is None or proxy.user_id != user.id:
        raise HTTPException(404, "Proxy não encontrado.")
    db.delete(proxy)
    db.commit()


@router.post("/proxies/{proxy_id}/check", response_model=ProxyOut)
def check_proxy_endpoint(proxy_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    proxy = db.get(Proxy, proxy_id)
    if proxy is None or proxy.user_id != user.id:
        raise HTTPException(404, "Proxy não encontrado.")
    return check_proxy(db, proxy)


# ---------- Configuração global (defaults, com override por conta) ----------
@router.get("/defaults", response_model=PublishingDefaultsOut)
def get_defaults(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    defaults = db.scalar(select(PublishingDefaults).where(PublishingDefaults.user_id == user.id))
    if defaults is None:
        defaults = PublishingDefaults(user_id=user.id)
        db.add(defaults)
        db.commit()
        db.refresh(defaults)
    return defaults


@router.put("/defaults", response_model=PublishingDefaultsOut)
def update_defaults(
    body: PublishingDefaultsUpdate, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    defaults = db.scalar(select(PublishingDefaults).where(PublishingDefaults.user_id == user.id))
    if defaults is None:
        defaults = PublishingDefaults(user_id=user.id)
        db.add(defaults)
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(defaults, k, v)
    db.commit()
    db.refresh(defaults)
    return defaults


# ---------- Contas ----------
def _get_account(db: Session, user: User, account_id: int) -> Account:
    account = db.get(Account, account_id)
    if account is None or account.user_id != user.id:
        raise HTTPException(404, "Conta não encontrada.")
    return account


def _require_own_proxy(db: Session, user: User, proxy_id: int) -> None:
    proxy = db.get(Proxy, proxy_id)
    if proxy is None or proxy.user_id != user.id:
        raise HTTPException(404, "Proxy não encontrado.")


@router.get("/accounts", response_model=list[AccountOut])
def list_accounts(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return list(db.scalars(select(Account).where(Account.user_id == user.id).order_by(Account.criado_em.desc())))


@router.post("/accounts", response_model=AccountOut)
def create_account(body: AccountCreate, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if body.proxy_id is not None:
        _require_own_proxy(db, user, body.proxy_id)
    data = body.model_dump()
    senha = data.pop("senha", None)
    sessionid = data.pop("sessionid", None)
    account = Account(user_id=user.id, **data)
    if senha:
        account.senha_enc = security.encrypt_secret(senha)
    if sessionid:
        account.sessionid_enc = security.encrypt_secret(sessionid)
    db.add(account)
    db.commit()
    db.refresh(account)
    return account


@router.patch("/accounts/{account_id}", response_model=AccountOut)
def update_account(
    account_id: int, body: AccountUpdate, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    account = _get_account(db, user, account_id)
    data = body.model_dump(exclude_unset=True)
    if data.get("proxy_id") is not None:
        _require_own_proxy(db, user, data["proxy_id"])
    senha = data.pop("senha", None)
    sessionid = data.pop("sessionid", None)
    if senha:
        account.senha_enc = security.encrypt_secret(senha)
    if sessionid:
        account.sessionid_enc = security.encrypt_secret(sessionid)
    for k, v in data.items():
        setattr(account, k, v)
    db.commit()
    db.refresh(account)
    return account


@router.delete("/accounts/{account_id}", status_code=204)
def delete_account(account_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    account = _get_account(db, user, account_id)
    db.delete(account)
    db.commit()


@router.post("/accounts/{account_id}/ready", response_model=AccountOut)
def mark_account_ready(account_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Marca a conta como pronta para automação, sem executar login (uso manual do operador)."""
    account = _get_account(db, user, account_id)
    account.status = "pronta"
    account.automation_status = "ociosa"
    account.ultimo_erro = None
    db.commit()
    db.refresh(account)
    return account


@router.post("/accounts/{account_id}/fingerprint", response_model=AccountOut)
def regenerate_fingerprint(account_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Gera uma NOVA fingerprint de dispositivo para a conta (modelo/hardware,
    uuids, user-agent, locale e timezone) — a conta passa a logar como "outro
    aparelho". Anti-cruzamento de dados entre contas (estilo multi-login).
    """
    account = _get_account(db, user, account_id)
    try:
        account.fingerprint = gerar_fingerprint(account.idioma, account.timezone)
    except RuntimeError as exc:
        raise HTTPException(400, str(exc)) from exc
    db.commit()
    db.refresh(account)
    return account


def _fail_connect(account: Account, db: Session, exc: Exception, status_code: int) -> HTTPException:
    """Marca a conta com o erro de conexão e devolve a resposta HTTP correspondente."""
    account.status = "erro"
    account.automation_status = "pausada"
    account.ultimo_erro = f"Falha ao conectar: {exc}"
    account.ultimo_erro_em = datetime.now(timezone.utc)
    db.commit()
    return HTTPException(status_code, str(exc))


def _connect_ctx(account: Account, verification_code: str | None = None) -> PublishContext:
    return PublishContext(
        account_username=account.username,
        account_password=security.decrypt_secret(account.senha_enc) if account.senha_enc else None,
        sessionid=security.decrypt_secret(account.sessionid_enc) if account.sessionid_enc else None,
        session_data=account.session_data,
        proxy=_proxy_dict(account.proxy),
        media_path="",
        caption=None,
        audio_reference=None,
        kind="reel",
        verification_code=verification_code,
        pending_login_data=account.pending_login_data,
        fingerprint=account.fingerprint,
    )


@router.post("/accounts/{account_id}/connect", response_model=AccountOut)
def connect_account(
    account_id: int,
    body: ConnectRequest | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Autenticação REAL da conta: valida o proxy (se houver), reaproveita a sessão
    persistida quando ainda válida, senão faz login com usuário/senha (e código de
    verificação, se informado — 2FA/desafio) e persiste a sessão nova. Em falha,
    marca a conta com erro — sem afetar as demais contas."""
    account = _get_account(db, user, account_id)
    verification_code = body.verification_code if body else None
    if not account.senha_enc and not account.sessionid_enc and not account.session_data:
        raise HTTPException(409, "Configure a senha (ou o cookie sessionid) da conta antes de conectar.")

    if account.proxy is not None:
        proxy = check_proxy(db, account.proxy)
        if proxy.status == "vermelho":
            account.status = "erro"
            account.ultimo_erro = f"Proxy indisponível: {proxy.ultimo_erro}"
            account.ultimo_erro_em = datetime.now(timezone.utc)
            db.commit()
            raise HTTPException(400, f"Proxy indisponível para esta conta: {proxy.ultimo_erro}")

    account.status = "conectando"
    db.commit()

    adapter = adapter_for_platform(account.platform, _proxy_dict(account.proxy))
    ctx = _connect_ctx(account, verification_code)
    try:
        adapter.open()
        login_via_sessionid = getattr(adapter, "login_with_sessionid", None)
        if ctx.sessionid and login_via_sessionid is not None:
            # cookie de sessão colado pelo operador: ignora o fluxo de login
            # (senha/CAA) que o Instagram costuma responder com 429.
            account.session_data = login_via_sessionid(ctx)
        elif adapter.check_session(ctx):
            # sessão persistida continua válida — reutiliza
            account.session_data = ctx.session_data
        else:
            account.session_data = adapter.login(ctx)
        account.status = "pronta"
        account.automation_status = "ociosa"
        account.ultimo_erro = None
        account.ultimo_erro_em = None
        account.ultimo_acesso_em = datetime.now(timezone.utc)
        account.pending_login_data = None  # login concluído — descarta o estado do desafio
        db.commit()
    except ThrottledError as exc:
        # 429 do Instagram: conta/IP limitada no momento — 429 para o front
        # distinguir de erro genérico (re-tentar na hora só piora o bloqueio).
        raise _fail_connect(account, db, exc, 429) from exc
    except (SessionExpiredError, AdapterError) as exc:
        # desafio de código (CAA): guarda o estado do cliente para o retry
        # reusar os MESMOS device ids — sem isso o código digitado não vale.
        pending = getattr(exc, "pending_login_data", None)
        if pending:
            account.pending_login_data = pending
        raise _fail_connect(account, db, exc, 400) from exc
    finally:
        adapter.close()
    db.refresh(account)
    return account


@router.post("/accounts/{account_id}/verify-session")
def verify_account_session(account_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Verificação REAL de que a sessão persistida ainda é válida, com chamada de rede."""
    account = _get_account(db, user, account_id)
    if not account.session_data:
        return {"valida": False, "motivo": "sem sessão persistida"}
    adapter = adapter_for_platform(account.platform, _proxy_dict(account.proxy))
    ctx = _connect_ctx(account)
    try:
        adapter.open()
        valida = adapter.check_session(ctx)
    finally:
        adapter.close()
    if valida:
        account.status = "pronta"
        account.ultimo_acesso_em = datetime.now(timezone.utc)
        db.commit()
        return {"valida": True, "motivo": None}
    account.status = "erro"
    account.ultimo_erro = "Sessão expirada — reconecte a conta"
    account.ultimo_erro_em = datetime.now(timezone.utc)
    db.commit()
    return {"valida": False, "motivo": "sessão expirada ou inválida"}


@router.post("/accounts/{account_id}/pause", response_model=AccountOut)
def pause_account(account_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    account = _get_account(db, user, account_id)
    account.automation_status = "pausada"
    db.commit()
    db.refresh(account)
    return account


@router.post("/accounts/{account_id}/resume", response_model=AccountOut)
def resume_account(account_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    account = _get_account(db, user, account_id)
    account.automation_status = "ociosa"
    db.commit()
    db.refresh(account)
    return account


# ---------- Legendas ----------
@router.get("/captions", response_model=list[CaptionOut])
def list_captions(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return list(
        db.scalars(select(CaptionTemplate).where(CaptionTemplate.user_id == user.id).order_by(CaptionTemplate.criado_em.desc()))
    )


@router.post("/captions", response_model=CaptionOut)
def create_caption(body: CaptionCreate, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    if body.account_id is not None:
        _get_account(db, user, body.account_id)
    caption = CaptionTemplate(user_id=user.id, **body.model_dump())
    db.add(caption)
    db.commit()
    db.refresh(caption)
    return caption


@router.patch("/captions/{caption_id}", response_model=CaptionOut)
def update_caption(
    caption_id: int, body: CaptionUpdate, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    caption = db.get(CaptionTemplate, caption_id)
    if caption is None or caption.user_id != user.id:
        raise HTTPException(404, "Legenda não encontrada.")
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(caption, k, v)
    db.commit()
    db.refresh(caption)
    return caption


@router.delete("/captions/{caption_id}", status_code=204)
def delete_caption(caption_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    caption = db.get(CaptionTemplate, caption_id)
    if caption is None or caption.user_id != user.id:
        raise HTTPException(404, "Legenda não encontrada.")
    db.delete(caption)
    db.commit()


# ---------- Áudios ----------
@router.get("/audio", response_model=list[AudioOut])
def list_audio(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    return list(db.scalars(select(AudioAsset).where(AudioAsset.user_id == user.id).order_by(AudioAsset.coletado_em.desc())))


@router.post("/audio", response_model=AudioOut)
def create_audio(body: AudioCreate, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    audio = AudioAsset(user_id=user.id, **body.model_dump())
    db.add(audio)
    db.commit()
    db.refresh(audio)
    return audio


@router.delete("/audio/{audio_id}", status_code=204)
def delete_audio(audio_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    audio = db.get(AudioAsset, audio_id)
    if audio is None or audio.user_id != user.id:
        raise HTTPException(404, "Áudio não encontrado.")
    db.delete(audio)
    db.commit()


# ---------- Stories (configuração por conta) ----------
def _plans_out(db: Session, cfg: StoryConfig) -> list[StoryPlanOut]:
    plans = list(
        db.scalars(select(StoryPlan).where(StoryPlan.story_config_id == cfg.id).order_by(StoryPlan.ordem))
    )
    resultado = []
    for plan in plans:
        frames = list(
            db.scalars(select(StoryFrame).where(StoryFrame.story_plan_id == plan.id).order_by(StoryFrame.ordem))
        )
        resultado.append(
            StoryPlanOut(
                id=plan.id,
                horario=plan.horario,
                ordem=plan.ordem,
                media_ids=[f.media_id for f in frames],
                # valores do plano; bancos antigos gravavam texto/link nos frames — usa como fallback
                texto=plan.texto or next((f.texto for f in frames if f.texto), None),
                link=plan.link or next((f.link for f in frames if f.link), None),
                link_posicao=plan.link_posicao,
                texto_extra=plan.texto_extra,
                texto_extra_x=plan.texto_extra_x,
                texto_extra_y=plan.texto_extra_y,
                ultima_geracao_em=plan.ultima_geracao_em,
            )
        )
    return resultado


@router.get("/accounts/{account_id}/story-config", response_model=StoryConfigOut)
def get_story_config(account_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    account = _get_account(db, user, account_id)
    cfg = db.scalar(select(StoryConfig).where(StoryConfig.account_id == account.id))
    if cfg is None:
        cfg = StoryConfig(account_id=account.id)
        db.add(cfg)
        db.commit()
        db.refresh(cfg)
    out = StoryConfigOut.model_validate(cfg)
    out.plans = _plans_out(db, cfg)
    return out


@router.put("/accounts/{account_id}/story-config", response_model=StoryConfigOut)
def update_story_config(
    account_id: int, body: StoryConfigUpdate, user: User = Depends(get_current_user), db: Session = Depends(get_db)
):
    account = _get_account(db, user, account_id)
    cfg = db.scalar(select(StoryConfig).where(StoryConfig.account_id == account.id))
    if cfg is None:
        cfg = StoryConfig(account_id=account.id)
        db.add(cfg)
        db.flush()
    cfg.enabled = body.enabled
    account.stories_enabled = body.enabled

    # Campos legados (1 imagem / 1 horário): só sobrescreve o que VEIO na requisição.
    # O check "Stories automáticos" em Contas envia só {enabled} — não pode apagar
    # texto/link/imagens de uma configuração já salva.
    enviado = body.model_dump(exclude_unset=True)
    if "imagem_media_id" in enviado:
        cfg.imagem_media_id = body.imagem_media_id
    if "texto" in enviado:
        cfg.texto = body.texto
    if "link" in enviado:
        cfg.link = body.link
    if "horario" in enviado:
        cfg.horario = body.horario

    if body.plans is not None:
        # reconcilia os plans NO LUGAR (por posição): preserva o id e o
        # ultima_geracao_em de cada plan — recriar do zero zerava o marcador e o
        # scheduler regenerava os stories do dia a cada save (duplicados).
        existing = list(db.scalars(select(StoryPlan).where(StoryPlan.story_config_id == cfg.id).order_by(StoryPlan.ordem)))

        def _substitui_frames(plan: StoryPlan, plano) -> None:
            for frame in list(db.scalars(select(StoryFrame).where(StoryFrame.story_plan_id == plan.id))):
                db.delete(frame)
            db.flush()
            for f_ordem, frame in enumerate(plano.frames):
                db.add(
                    StoryFrame(
                        story_plan_id=plan.id,
                        media_id=frame.media_id,
                        ordem=f_ordem,
                        texto=frame.texto,
                        link=frame.link,
                    )
                )

        for ordem, plano in enumerate(body.plans):
            if ordem < len(existing):
                plan = existing[ordem]
                plan.horario = plano.horario
                plan.texto = plano.texto
                plan.link = plano.link
                plan.link_posicao = plano.link_posicao
                plan.texto_extra = plano.texto_extra
                plan.texto_extra_x = plano.texto_extra_x
                plan.texto_extra_y = plano.texto_extra_y
                _substitui_frames(plan, plano)
            else:
                plan = StoryPlan(
                    story_config_id=cfg.id,
                    horario=plano.horario,
                    ordem=ordem,
                    texto=plano.texto,
                    link=plano.link,
                    link_posicao=plano.link_posicao,
                    texto_extra=plano.texto_extra,
                    texto_extra_x=plano.texto_extra_x,
                    texto_extra_y=plano.texto_extra_y,
                )
                db.add(plan)
                db.flush()
                _substitui_frames(plan, plano)
        # sobras (o usuário removeu models): apaga plan e frames
        for plan in existing[len(body.plans):]:
            for frame in list(db.scalars(select(StoryFrame).where(StoryFrame.story_plan_id == plan.id))):
                db.delete(frame)
            db.delete(plan)

    db.commit()
    db.refresh(cfg)
    out = StoryConfigOut.model_validate(cfg)
    out.plans = _plans_out(db, cfg)
    return out


@router.get("/accounts/{account_id}/stories", response_model=list[StoryHistoryOut])
def list_story_history(
    account_id: int,
    limit: int = 50,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Histórico de stories da conta: uma linha por publicação (status, horário,
    legenda, link, erro), mais recente primeiro."""
    account = _get_account(db, user, account_id)
    pubs = list(
        db.scalars(
            select(Publication)
            .join(Content, Publication.content_id == Content.id)
            .where(Publication.account_id == account.id, Content.kind == "story")
            .order_by(Publication.scheduled_at.desc())
            .limit(max(1, min(limit, 200)))
        )
    )
    return [
        StoryHistoryOut(
            id=p.id,
            content_id=p.content.id,
            status=p.status,
            scheduled_at=p.scheduled_at,
            confirmado_em=p.confirmado_em,
            erro=p.erro,
            legenda=p.content.legenda,
            link=p.content.link,
        )
        for p in pubs
    ]


@router.post("/accounts/{account_id}/stories/{plan_id}/post-now", response_model=StoryHistoryOut)
def post_story_now(account_id: int, plan_id: int, user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """Publica AGORA o story do modelo (botão "Postar agora" da lista de stories).

    Cria o conteúdo + a publicação e executa o upload na hora (sincrono). Se o
    processo cair entre a criação e a execução, a publicação fica PENDING e o
    scheduler assume no ciclo seguinte. Se der certo, o plano conta como "já
    gerado hoje" — o horário normal do dia não repete o story."""
    account = _get_account(db, user, account_id)
    if not account.ativa:
        raise HTTPException(409, "Conta desativada — reative-a em Contas para publicar stories.")
    if account.status != "pronta":
        raise HTTPException(409, "Conta não está pronta para publicação — confira sessão/proxy em Contas.")

    plan = db.scalar(
        select(StoryPlan)
        .join(StoryConfig, StoryConfig.id == StoryPlan.story_config_id)
        .where(StoryPlan.id == plan_id, StoryConfig.account_id == account.id)
    )
    if plan is None:
        raise HTTPException(404, "Modelo de story não encontrado.")
    cfg = db.get(StoryConfig, plan.story_config_id)

    frames = _frames_of_plan(db, plan)
    if not frames:
        raise HTTPException(400, "Modelo sem imagens — adicione imagens e salve antes de postar.")
    paths = [caminho for caminho, _, _ in frames]
    texto = plan.texto or " / ".join(t for _, t, _ in frames if t) or cfg.texto
    link = plan.link or next((lnk for _, _, lnk in frames if lnk), None) or cfg.link

    agora = datetime.now(timezone.utc)
    content = Content(
        user_id=account.user_id,
        kind="story",
        origem="manual",
        caminho=paths[0],
        legenda=texto,
        link=link,
        link_posicao=plan.link_posicao,
        texto_extra=plan.texto_extra,
        texto_extra_x=plan.texto_extra_x,
        texto_extra_y=plan.texto_extra_y,
        account_id=account.id,
        approval_status="aprovado",
        schedule_mode="especifico",
        scheduled_at=agora,
    )
    db.add(content)
    db.flush()
    for ordem, caminho in enumerate(paths):
        db.add(ContentMedia(content_id=content.id, caminho=caminho, ordem=ordem))
    pub = Publication(content_id=content.id, account_id=account.id, status="PENDING", scheduled_at=agora)
    db.add(pub)
    db.commit()
    db.refresh(pub)

    # executa na hora. Se o scheduler já tiver pego esta publicação no meio-tempo
    # (status ≠ PENDING), não executa de novo.
    if pub.status == "PENDING":
        execute_publication(db, pub)
        db.refresh(pub)

    if pub.status == "PUBLISHED":
        plan.ultima_geracao_em = datetime.now(timezone.utc)
        db.commit()

    return StoryHistoryOut(
        id=pub.id,
        content_id=pub.content.id,
        status=pub.status,
        scheduled_at=pub.scheduled_at,
        confirmado_em=pub.confirmado_em,
        erro=pub.erro,
        legenda=pub.content.legenda,
        link=pub.content.link,
    )
