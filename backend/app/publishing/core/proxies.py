"""Verificação de proxy (SOCKS5/HTTP) antes de usá-lo numa publicação (Seção 3 da spec).

Se o proxy estiver indisponível, quem chama deve interromper a tarefa daquela
conta em vez de deixá-la seguir por uma conexão inesperada (ver core/publications.py).

Proxies rotativos (ex.: sixproxy) trocam o IP de saída a cada conexão — a
checagem tenta mais de uma vez contra serviços de IP diferentes antes de marcar
vermelho, porque uma tentativa isolada pode pegar um IP de saída bloqueado em um
serviço específico (erro clássico: SSL EOF no handshake TLS).
"""
from __future__ import annotations

import time
from datetime import datetime, timezone

import requests
from sqlalchemy.orm import Session

from ..models import Proxy

# múltiplos alvos: um IP de saída pode estar bloqueado num serviço e livre em outro
CHECK_URLS = (
    ("https://api.ipify.org?format=json", "json"),
    ("https://api64.ipify.org?format=json", "json"),
    ("https://icanhazip.com", "text"),
)
CHECK_ATTEMPTS = 3  # proxies rotativos: cada nova conexão = novo IP de saída
TIMEOUT_SECONDS = 8
LATENCIA_AMARELA_MS = 1500  # acima disso, o proxy funciona mas está lento


def _proxy_url(proxy: Proxy) -> str:
    auth = f"{proxy.usuario}:{proxy.senha}@" if proxy.usuario else ""
    return f"{proxy.protocolo}://{auth}{proxy.host}:{proxy.porta}"


def _extract_ip(kind: str, resp) -> str | None:
    if kind == "json":
        try:
            return resp.json().get("ip")
        except Exception:  # noqa: BLE001 — resposta inesperada conta como falha
            return None
    texto = (resp.text or "").strip()
    return texto or None


def check_proxy(db: Session, proxy: Proxy) -> Proxy:
    """Testa se o proxy responde (HTTPS de verdade), mede latência e IP público.

    Atualiza e persiste o status: verde/amarelo quando funciona, vermelho quando
    todas as tentativas falham. Em proxies rotativos, cada tentativa abre uma
    conexão nova — logo, um IP de saída diferente.
    """
    url = _proxy_url(proxy)
    erros: list[str] = []
    for tentativa in range(CHECK_ATTEMPTS):
        alvo, kind = CHECK_URLS[tentativa % len(CHECK_URLS)]
        inicio = time.monotonic()
        try:
            resp = requests.get(alvo, proxies={"http": url, "https": url}, timeout=TIMEOUT_SECONDS)
            resp.raise_for_status()
            ip = _extract_ip(kind, resp)
            if not ip:
                erros.append(f"tentativa {tentativa + 1} ({alvo}): resposta sem IP")
                continue
            latencia_ms = (time.monotonic() - inicio) * 1000
            proxy.status = "amarelo" if latencia_ms > LATENCIA_AMARELA_MS else "verde"
            proxy.latencia_ms = round(latencia_ms, 1)
            proxy.ip_publico = ip
            proxy.ultimo_erro = None
            proxy.ultimo_check_em = datetime.now(timezone.utc)
            db.commit()
            db.refresh(proxy)
            return proxy
        except Exception as exc:  # noqa: BLE001 — qualquer falha entra no erro desta tentativa
            erros.append(f"tentativa {tentativa + 1} ({alvo}): {type(exc).__name__} — {str(exc)[:140]}")

    proxy.status = "vermelho"
    proxy.latencia_ms = None
    proxy.ip_publico = None
    detalhe = "; ".join(erros[:3])
    if "SSL" in detalhe or "EOF" in detalhe:
        proxy.ultimo_erro = (
            "HTTPS através do proxy falhou (o túnel conecta, mas o TLS é encerrado) — costuma ser o IP de saída "
            f"bloqueado no serviço testado; como é proxy rotativo, cada tentativa usa um IP novo. Detalhes: {detalhe}"
        )
    else:
        proxy.ultimo_erro = f"Proxy indisponível após {CHECK_ATTEMPTS} tentativas: {detalhe}"
    proxy.ultimo_check_em = datetime.now(timezone.utc)
    db.commit()
    db.refresh(proxy)
    return proxy
