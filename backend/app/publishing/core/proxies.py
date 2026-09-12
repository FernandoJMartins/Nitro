"""Verificação de proxy (SOCKS5/HTTP) antes de usá-lo numa publicação (Seção 3 da spec).

Se o proxy estiver indisponível, quem chama deve interromper a tarefa daquela
conta em vez de deixá-la seguir por uma conexão inesperada (ver core/publications.py).

Proxies rotativos (ex.: sixproxy) trocam o IP de saída a cada conexão — a
checagem tenta mais de uma vez contra serviços de IP diferentes antes de marcar
vermelho, porque uma tentativa isolada pode pegar um IP de saída bloqueado.

Diagnóstico de TLS: quando SOCKS5 conecta mas o TLS é encerrado (SSL EOF) em
todos os alvos, o endpoint provavelmente não tunela HTTPS — a checagem então
tenta o MESMO host:porta via HTTP CONNECT (que também tunela HTTPS) e persiste
o protocolo que funcionou. Se nem isso, testa HTTP puro para informar se as
credenciais ao menos funcionam.
"""
from __future__ import annotations

import time
from datetime import datetime, timezone

import requests
from sqlalchemy.orm import Session

from ..models import Proxy
from ...config import settings

# múltiplos alvos: um IP de saída pode estar bloqueado num serviço e livre em outro
CHECK_URLS = (
    ("https://api.ipify.org?format=json", "json"),
    ("https://api64.ipify.org?format=json", "json"),
    ("https://icanhazip.com", "text"),
)
CHECK_ATTEMPTS = 3  # proxies rotativos: cada nova conexão = novo IP de saída
LATENCIA_AMARELA_MS = 1500  # acima disso, o proxy funciona mas está lento


def _timeout() -> int:
    return settings.proxy_check_timeout_seconds


def _proxy_url(protocolo: str, proxy: Proxy) -> str:
    auth = f"{proxy.usuario}:{proxy.senha}@" if proxy.usuario else ""
    return f"{protocolo}://{auth}{proxy.host}:{proxy.porta}"


def _extract_ip(kind: str, resp) -> str | None:
    if kind == "json":
        try:
            return resp.json().get("ip")
        except Exception:  # noqa: BLE001 — resposta inesperada conta como falha
            return None
    texto = (resp.text or "").strip()
    return texto or None


def _check_once(url: str, alvo: str, kind: str) -> tuple[float, str] | None:
    """Uma tentativa HTTPS contra um alvo. Devolve (latencia_ms, ip) ou None."""
    inicio = time.monotonic()
    resp = requests.get(alvo, proxies={"http": url, "https": url}, timeout=_timeout())
    resp.raise_for_status()
    ip = _extract_ip(kind, resp)
    if not ip:
        return None
    return ((time.monotonic() - inicio) * 1000, ip)


def _mark_ok(db: Session, proxy: Proxy, protocolo: str, latencia_ms: float, ip: str) -> Proxy:
    if protocolo != (proxy.protocolo or "socks5"):
        # fallback transparente: o protocolo que funcionou fica persistido e
        # passa a ser usado pela automação da conta (a lista da UI mostra a mudança)
        proxy.protocolo = protocolo
    proxy.status = "amarelo" if latencia_ms > LATENCIA_AMARELA_MS else "verde"
    proxy.latencia_ms = round(latencia_ms, 1)
    proxy.ip_publico = ip
    proxy.ultimo_erro = None
    proxy.ultimo_check_em = datetime.now(timezone.utc)
    db.commit()
    db.refresh(proxy)
    return proxy


def check_proxy(db: Session, proxy: Proxy) -> Proxy:
    """Testa se o proxy responde (HTTPS de verdade), mede latência e IP público.

    Fluxo: tenta o protocolo configurado (socks5) contra N alvos; se o túnel
    conectar mas o TLS for encerrado em todos, tenta HTTP CONNECT no mesmo
    endpoint; por fim, diagnóstico HTTP puro para diferenciar os motivos.
    """
    protocolos = [proxy.protocolo or "socks5"]
    if protocolos[0] == "socks5":
        protocolos.append("http")  # fallback: HTTP CONNECT também tunela HTTPS

    erros: list[str] = []
    for proto in protocolos:
        url = _proxy_url(proto, proxy)
        for tentativa in range(CHECK_ATTEMPTS):
            alvo, kind = CHECK_URLS[tentativa % len(CHECK_URLS)]
            try:
                resultado = _check_once(url, alvo, kind)
                if resultado is None:
                    erros.append(f"{proto} tentativa {tentativa + 1}: resposta sem IP")
                    continue
                latencia, ip = resultado
                return _mark_ok(db, proxy, proto, latencia, ip)
            except Exception as exc:  # noqa: BLE001 — cada falha alimenta o diagnóstico
                erros.append(f"{proto} tentativa {tentativa + 1} ({alvo}): {type(exc).__name__} — {str(exc)[:110]}")

    # tudo falhou — diagnóstico HTTP puro: as credenciais funcionam? só HTTPS que não?
    ip_http: str | None = None
    try:
        url0 = _proxy_url(protocolos[0], proxy)
        resp = requests.get("http://api.ipify.org?format=json", proxies={"http": url0}, timeout=_timeout())
        resp.raise_for_status()
        ip_http = resp.json().get("ip")
    except Exception:  # noqa: BLE001 — diagnóstico best-effort
        ip_http = None

    proxy.status = "vermelho"
    proxy.latencia_ms = None
    proxy.ip_publico = None
    detalhe = "; ".join(erros[:3])
    if ip_http:
        proxy.ultimo_erro = (
            f"As credenciais funcionam (HTTP respondeu com IP de saída {ip_http}), mas o túnel HTTPS/TLS é "
            "encerrado pelo endpoint — ele não serve para publicar no Instagram. Tente o protocolo http:// "
            "(HTTP CONNECT) explicitamente ou outro endpoint/porta do provedor. Detalhes: " + detalhe
        )
    elif any(m in detalhe for m in ("SSL", "EOF")):
        proxy.ultimo_erro = (
            "HTTPS pelo proxy falhou em todos os alvos e nem HTTP puro respondeu — endpoint/credenciais "
            "provavelmente inválidos ou serviço fora do ar. Detalhes: " + detalhe
        )
    else:
        proxy.ultimo_erro = f"Proxy indisponível após várias tentativas: {detalhe}"
    proxy.ultimo_check_em = datetime.now(timezone.utc)
    db.commit()
    db.refresh(proxy)
    return proxy
