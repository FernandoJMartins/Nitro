"""Teste diário de login no Instagram (canário).

Uma vez por dia o servidor tenta logar com um usuário INVENTADO e senha
qualquer. Não usa nenhuma conta real, então não arrisca nada. O que importa é
COMO o Instagram responde:

- resposta normal de "dados errados" (200 + "versão desatualizada" / senha
  incorreta / usuário não existe)  ->  o login da biblioteca FUNCIONA (ok)
- 429 / "aguarde alguns minutos"  ->  o Instagram está barrando o login da
  biblioteca (bloqueado): hora de atualizar a instagrapi

Rota: em IP residencial (servidor de casa) vai direto. Em IP de data center
(droplet) o Instagram dá 429 para qualquer um, então usa INSTAGRAM_CANARY_PROXY
ou um proxy residencial já cadastrado; sem nenhum, o resultado é "inconclusivo".
"""
from __future__ import annotations

import json
import logging
import random
import threading
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..database import SessionLocal

logger = logging.getLogger("nitro.canario")

INTERVALO_HORAS = 24
_lock = threading.Lock()
_stop = threading.Event()

RESULTADO_TEXTO = {
    "ok": "Login funcionando",
    "bloqueado": "Instagram barrando o login",
    "inconclusivo": "Inconclusivo",
    "erro": "Falha de rede no teste",
}


def _path():
    return settings.storage_path / "_canario_login.json"


def ultimo() -> dict | None:
    try:
        return json.loads(_path().read_text())
    except Exception:  # noqa: BLE001
        return None


def _salvar(dados: dict) -> None:
    try:
        _path().parent.mkdir(parents=True, exist_ok=True)
        _path().write_text(json.dumps(dados, default=str))
    except Exception:  # noqa: BLE001
        logger.warning("não foi possível gravar o resultado do teste de login")


def _rota(db: Session) -> tuple[str | None, str, dict | None]:
    """(proxy_url | None, descrição da rota, info do IP do servidor)."""
    from ..publishing.core.publications import _proxy_dict
    from ..publishing.models import Proxy
    from ..publishing.platforms.base import build_proxy_url
    from .ip_tipo import classificar, ip_de_saida

    if settings.instagram_canary_proxy:
        return settings.instagram_canary_proxy, "proxy do teste (INSTAGRAM_CANARY_PROXY)", None
    ip = ip_de_saida(None)
    info = {"ip": ip, **classificar(ip)}
    if info["tipo"] != "datacenter":
        return None, f"direto ({info.get('provedor') or 'IP do servidor'})", info
    proxy = db.scalars(
        select(Proxy)
        .where(Proxy.tipo_ip.in_(("residencial", "movel")), Proxy.status != "vermelho")
        .order_by(Proxy.ultimo_check_em.desc().nullslast())
    ).first()
    if proxy is None:
        return "", "nenhum proxy residencial cadastrado", info
    return build_proxy_url(_proxy_dict(proxy)), f"proxy residencial cadastrado #{proxy.id}", info


def executar(db: Session) -> dict:
    """Roda o teste agora e grava o resultado."""
    from ..publishing.platforms.instagram import _THROTTLE_NAMES, _default_client_factory
    from .lib_monitor import versao_instalada

    with _lock:
        agora = datetime.now(timezone.utc)
        dados: dict = {"em": agora.isoformat(), "biblioteca": versao_instalada()}
        try:
            proxy_url, rota, info = _rota(db)
        except Exception as exc:  # noqa: BLE001
            proxy_url, rota, info = None, f"direto (não foi possível checar o IP: {type(exc).__name__})", None
        dados["rota"] = rota
        if proxy_url == "":
            dados.update(
                resultado="inconclusivo",
                detalhe="Este servidor usa IP de data center, onde o Instagram responde 429 para qualquer login. "
                "Cadastre um proxy residencial (ou INSTAGRAM_CANARY_PROXY) para o teste valer aqui.",
            )
            _salvar(dados)
            return dados

        usuario = f"nitro_canario_{random.randint(100000, 999999)}"
        try:
            cliente = _default_client_factory(proxy_url)
            cliente.login(usuario, "SenhaQualquer-Canario-123")
            dados.update(resultado="ok", detalhe="login aceito (inesperado, mas o fluxo funciona)")
        except Exception as exc:  # noqa: BLE001 — a resposta É o resultado
            nome = type(exc).__name__
            resp = getattr(cliente, "last_response", None) if "cliente" in locals() else None
            status = getattr(resp, "status_code", None)
            texto = f"{nome}: {str(exc)[:160]}"
            if nome in _THROTTLE_NAMES or status == 429 or "429" in str(exc):
                dados.update(resultado="bloqueado", detalhe=texto)
            elif nome in ("ConnectionError", "ProxyError", "ConnectTimeout", "ReadTimeout", "SSLError") or (
                resp is None and "transport" in str(exc).lower()
            ):
                dados.update(resultado="erro", detalhe=texto)
            else:
                # 200 com erro tipado (versão desatualizada / senha / usuário) = fluxo OK
                dados.update(resultado="ok", detalhe=f"resposta normal do Instagram ({nome})")
        logger.info("teste de login: %s (%s)", dados["resultado"], dados.get("detalhe"))
        _salvar(dados)
        return dados


def _vencido() -> bool:
    u = ultimo()
    if not u or not u.get("em"):
        return True
    try:
        quando = datetime.fromisoformat(u["em"])
    except ValueError:
        return True
    return datetime.now(timezone.utc) - quando > timedelta(hours=INTERVALO_HORAS)


def _loop() -> None:
    _stop.wait(10 * 60)  # espera o servidor estabilizar (e evita rodar a cada hot-reload)
    while not _stop.is_set():
        if _vencido():
            db = SessionLocal()
            try:
                executar(db)
            except Exception:  # noqa: BLE001 — o loop nunca pode morrer
                logger.exception("falha no teste diário de login")
            finally:
                db.close()
        _stop.wait(3600)


def start_canary_worker() -> None:
    threading.Thread(target=_loop, name="login-canary", daemon=True).start()
