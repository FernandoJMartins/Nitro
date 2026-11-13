"""Avisos no Telegram quando o painel Admin → Sistema ganha (ou perde) um alerta.

Configuração (.env): TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID (passo a passo no
README). Sem elas, nada é enviado e o painel mostra "Telegram não configurado".

Regras para não virar spam:
- alerta NOVO -> avisa na hora;
- alerta que continua ativo -> lembra a cada 12h (crítico) ou 24h (atenção);
- alerta que sumiu -> avisa "resolvido".
O estado fica em STORAGE_DIR/_alertas_enviados.json (sobrevive a reinícios).
"""
from __future__ import annotations

import json
import logging
import re
import threading
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

import requests

from ..config import settings
from ..database import SessionLocal

logger = logging.getLogger("nitro.notifier")

INTERVALO_SEGUNDOS = 10 * 60
LEMBRETE = {"critico": timedelta(hours=12), "atencao": timedelta(hours=24)}
_stop = threading.Event()
STATUS: dict = {"ultimo_envio_em": None, "ultimo_erro": None, "verificado_em": None}


def configurado() -> bool:
    return bool(settings.telegram_bot_token and settings.telegram_chat_id)


def nome_instancia() -> str:
    if settings.instance_name:
        return settings.instance_name
    host = urlparse(settings.app_url or "").hostname if getattr(settings, "app_url", "") else None
    return host or "Nitro"


def enviar(texto: str) -> bool:
    """Envia uma mensagem. Nunca levanta exceção (retorna False em falha)."""
    if not configurado():
        return False
    try:
        r = requests.post(
            f"https://api.telegram.org/bot{settings.telegram_bot_token}/sendMessage",
            json={"chat_id": settings.telegram_chat_id, "text": texto[:4000], "disable_web_page_preview": True},
            timeout=10,
        )
        if not r.ok:
            STATUS["ultimo_erro"] = f"Telegram respondeu {r.status_code}: {r.text[:160]}"
            return False
        STATUS["ultimo_envio_em"] = datetime.now(timezone.utc)
        STATUS["ultimo_erro"] = None
        return True
    except Exception as exc:  # noqa: BLE001
        STATUS["ultimo_erro"] = f"falha ao enviar: {type(exc).__name__}"
        return False


def _chave(msg: str) -> str:
    # números mudam (disco 76% -> 77%); a identidade do alerta é o texto sem eles
    return re.sub(r"\d+([.,]\d+)?", "#", msg)[:90]


def _path():
    return settings.storage_path / "_alertas_enviados.json"


def _carregar() -> dict:
    try:
        return json.loads(_path().read_text())
    except Exception:  # noqa: BLE001
        return {}


def _salvar(estado: dict) -> None:
    try:
        _path().write_text(json.dumps(estado))
    except Exception:  # noqa: BLE001
        pass


ICONE = {"critico": "🔴", "atencao": "🟡"}


def processar(alertas: list[dict], agora: datetime | None = None) -> list[str]:
    """Decide e envia os avisos para a lista atual de alertas. Retorna os textos enviados."""
    agora = agora or datetime.now(timezone.utc)
    estado = _carregar()
    enviados: list[str] = []
    atuais = {}
    for a in alertas:
        k = _chave(a["mensagem"])
        atuais[k] = a
        anterior = estado.get(k)
        if anterior is None:
            texto = f"{ICONE.get(a['nivel'], '⚠️')} {nome_instancia()} — {a['mensagem']}"
        else:
            ultimo = datetime.fromisoformat(anterior["enviado_em"])
            subiu = anterior.get("nivel") != "critico" and a["nivel"] == "critico"
            if not subiu and agora - ultimo < LEMBRETE.get(a["nivel"], timedelta(hours=24)):
                continue
            texto = f"{ICONE.get(a['nivel'], '⚠️')} {nome_instancia()} — continua: {a['mensagem']}"
        if enviar(texto) or not configurado():
            # sem Telegram configurado também marca, para não disparar tudo de uma vez ao configurar
            estado[k] = {"nivel": a["nivel"], "enviado_em": agora.isoformat(), "mensagem": a["mensagem"]}
            if configurado():
                enviados.append(texto)
    for k in [k for k in estado if k not in atuais]:
        texto = f"✅ {nome_instancia()} — resolvido: {estado[k].get('mensagem', '')}"
        if not configurado() or enviar(texto):
            if configurado():
                enviados.append(texto)
            estado.pop(k)
    _salvar(estado)
    return enviados


def alertas_atuais() -> list[dict]:
    """Os mesmos alertas do painel Admin → Sistema."""
    from ..routers.admin import system_status

    db = SessionLocal()
    try:
        return system_status(None, db)["alertas"]
    finally:
        db.close()


def _loop() -> None:
    _stop.wait(120)  # deixa o agendador fazer o 1º ciclo (senão "agendador parado" falso)
    while not _stop.is_set():
        try:
            processar(alertas_atuais())
            STATUS["verificado_em"] = datetime.now(timezone.utc)
        except Exception:  # noqa: BLE001 — o vigia nunca pode morrer
            logger.exception("falha ao verificar/enviar alertas")
        _stop.wait(INTERVALO_SEGUNDOS)


def start_alert_watcher() -> None:
    threading.Thread(target=_loop, name="alert-watcher", daemon=True).start()
