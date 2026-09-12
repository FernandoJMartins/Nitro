"""Verificação de proxy (SOCKS5) antes de usá-lo numa publicação (Seção 3 da spec).

Se o proxy estiver indisponível, quem chama deve interromper a tarefa daquela
conta em vez de deixá-la seguir por uma conexão inesperada (ver core/publications.py).
"""
from __future__ import annotations

import time
from datetime import datetime, timezone

import requests
from sqlalchemy.orm import Session

from ..models import Proxy

IP_CHECK_URL = "https://api.ipify.org?format=json"
TIMEOUT_SECONDS = 8
LATENCIA_AMARELA_MS = 1500  # acima disso, o proxy funciona mas está lento


def _proxy_url(proxy: Proxy) -> str:
    auth = f"{proxy.usuario}:{proxy.senha}@" if proxy.usuario else ""
    return f"{proxy.protocolo}://{auth}{proxy.host}:{proxy.porta}"


def check_proxy(db: Session, proxy: Proxy) -> Proxy:
    """Testa se o proxy responde, mede latência e IP público. Atualiza e persiste o status."""
    url = _proxy_url(proxy)
    inicio = time.monotonic()
    try:
        resp = requests.get(IP_CHECK_URL, proxies={"http": url, "https": url}, timeout=TIMEOUT_SECONDS)
        resp.raise_for_status()
        latencia_ms = (time.monotonic() - inicio) * 1000

        proxy.status = "amarelo" if latencia_ms > LATENCIA_AMARELA_MS else "verde"
        proxy.latencia_ms = round(latencia_ms, 1)
        proxy.ip_publico = resp.json().get("ip")
        proxy.ultimo_erro = None
    except Exception as exc:  # noqa: BLE001 — qualquer falha marca o proxy como indisponível
        proxy.status = "vermelho"
        proxy.latencia_ms = None
        proxy.ip_publico = None
        proxy.ultimo_erro = str(exc)

    proxy.ultimo_check_em = datetime.now(timezone.utc)
    db.commit()
    db.refresh(proxy)
    return proxy
