"""Classifica um IP como residencial, móvel ou data center.

O Instagram bloqueia (429) login por senha vindo de IP de data center
(DigitalOcean, Latitude.sh, Hostzone...). Saber o tipo do IP de saída de um
proxy evita horas de diagnóstico: a UI avisa na hora do cadastro.

Fonte: ip-api.com (gratuito, sem chave; campos `hosting` e `mobile`).
Tudo best-effort: sem resposta, o tipo fica "desconhecido".
"""
from __future__ import annotations

import logging
import threading

import requests

logger = logging.getLogger("nitro.ip_tipo")

_cache: dict[str, dict] = {}
_lock = threading.Lock()

ROTULO = {
    "residencial": "Residencial",
    "movel": "Móvel (4G/5G)",
    "datacenter": "Data center",
    "desconhecido": "Desconhecido",
}


def ip_de_saida(proxy_url: str | None, timeout: float = 15) -> str | None:
    """IP público visto pelos sites ao sair por este proxy (ou direto, se None)."""
    proxies = {"http": proxy_url, "https": proxy_url} if proxy_url else None
    for alvo in ("https://api.ipify.org", "https://ident.me", "https://icanhazip.com"):
        try:
            r = requests.get(alvo, proxies=proxies, timeout=timeout, headers={"User-Agent": "curl/8"})
            ip = r.text.strip()
            if r.ok and ip and len(ip) <= 45 and " " not in ip:
                return ip
        except Exception:  # noqa: BLE001 — tenta o próximo
            continue
    return None


# nomes de empresas de hospedagem/nuvem (ASN) — o ip-api às vezes classifica
# faixas revendidas (ex.: Latitude.sh) como residenciais
HOSPEDAGEM = (
    "latitude.sh", "hostzone", "digitalocean", "amazon", "aws", "google cloud", "google llc", "microsoft",
    "azure", "oracle", "ovh", "hetzner", "linode", "akamai", "vultr", "choopa", "contabo", "leaseweb",
    "m247", "datacamp", "cdn77", "hostinger", "locaweb", "kinghost", "hostgator", "godaddy", "ionos",
    "scaleway", "alibaba", "tencent", "cloudflare", "fastly", "hosting", "data center", "datacenter",
    "servers", "server ", "cloud", "colocation", "vps",
)


def _org_ipinfo(ip: str) -> str | None:
    try:
        r = requests.get(f"https://ipinfo.io/{ip}/org", timeout=8, headers={"User-Agent": "curl/8"})
        return r.text.strip()[:200] if r.ok else None
    except Exception:  # noqa: BLE001
        return None


def _parece_hospedagem(*nomes: str | None) -> bool:
    texto = " ".join(n for n in nomes if n).lower()
    return any(h in texto for h in HOSPEDAGEM)


def classificar(ip: str | None) -> dict:
    """{"tipo": residencial|movel|datacenter|desconhecido, "provedor": str|None}."""
    if not ip:
        return {"tipo": "desconhecido", "provedor": None}
    with _lock:
        if ip in _cache:
            return _cache[ip]
    resultado = {"tipo": "desconhecido", "provedor": None}
    try:
        r = requests.get(
            f"http://ip-api.com/json/{ip}",
            params={"fields": "status,isp,org,as,mobile,proxy,hosting"},
            timeout=8,
        )
        j = r.json()
        if j.get("status") == "success":
            if j.get("mobile"):
                tipo = "movel"
            elif j.get("hosting"):
                tipo = "datacenter"
            else:
                tipo = "residencial"
            resultado = {"tipo": tipo, "provedor": (j.get("isp") or j.get("org") or j.get("as") or "")[:200] or None}
            if tipo == "residencial" and _parece_hospedagem(j.get("isp"), j.get("org"), j.get("as")):
                resultado["tipo"] = "datacenter"
    except Exception as exc:  # noqa: BLE001 — classificação é só informativa
        logger.debug("classificação de IP indisponível: %s", exc)
    if resultado["tipo"] in ("residencial", "desconhecido"):
        # segunda opinião: dono do bloco segundo o ipinfo (pega revendas de data center)
        org = _org_ipinfo(ip)
        if org and _parece_hospedagem(org):
            resultado = {"tipo": "datacenter", "provedor": org}
        elif resultado["tipo"] == "desconhecido" and org:
            resultado["provedor"] = org
    if resultado["tipo"] != "desconhecido":
        with _lock:
            _cache[ip] = resultado
    return resultado
