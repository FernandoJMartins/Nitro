"""Fingerprint de dispositivo por conta (anti-cruzamento de dados).

Cada conta pode ter um dispositivo persistido — modelo/hardware, resolução,
uuids, user-agent, locale e timezone — como as opções de navegadores
anti-deteção multi-login. Sem fingerprint, o fork do instagrapi inicia todo
login com o MESMO device padrão (Pixel 8 Pro) e só os uuids variam, o que
facilita o Instagram cruzar as contas entre si.

O operador pode regenerar o fingerprint a qualquer momento (a conta passa a
logar como "outro aparelho" — útil depois de um bloqueio ou para rotação de
identidade).
"""
from __future__ import annotations

import json
import random
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

# Aparelhos Android reais (mesma granularidade que um navegador anti-deteção expõe).
DEVICE_POOL: list[dict] = [
    {"android_version": 34, "android_release": "14", "dpi": "480dpi", "resolution": "1344x2992",
     "manufacturer": "Google/google", "device": "husky", "model": "Pixel 8 Pro", "cpu": "husky"},
    {"android_version": 33, "android_release": "13", "dpi": "420dpi", "resolution": "1080x2400",
     "manufacturer": "Google/google", "device": "panther", "model": "Pixel 7", "cpu": "panther"},
    {"android_version": 34, "android_release": "14", "dpi": "560dpi", "resolution": "1440x3120",
     "manufacturer": "samsung/samsung", "device": "e3q", "model": "SM-S928B", "cpu": "s5e9945"},
    {"android_version": 33, "android_release": "13", "dpi": "450dpi", "resolution": "1080x2340",
     "manufacturer": "samsung/samsung", "device": "b0q", "model": "SM-S906B", "cpu": "s5e9925"},
    {"android_version": 34, "android_release": "14", "dpi": "420dpi", "resolution": "1080x2400",
     "manufacturer": "OnePlus/OnePlus", "device": "OP5913L1", "model": "CPH2451", "cpu": "kalama"},
    {"android_version": 33, "android_release": "13", "dpi": "440dpi", "resolution": "1080x2400",
     "manufacturer": "xiaomi/xiaomi", "device": "cupid", "model": "2201123G", "cpu": "qcom"},
    {"android_version": 32, "android_release": "12", "dpi": "420dpi", "resolution": "1080x2400",
     "manufacturer": "motorola/motorola", "device": "rhode", "model": "moto g52", "cpu": "holi"},
    {"android_version": 33, "android_release": "13", "dpi": "480dpi", "resolution": "1440x3200",
     "manufacturer": "samsung/samsung", "device": "e1q", "model": "SM-S911B", "cpu": "s5e9945"},
]

LOCALES = ["pt_BR", "en_US", "es_ES", "pt_PT", "fr_FR", "it_IT", "de_DE"]


def gerar_fingerprint(idioma: str | None, timezone_nome: str | None) -> str:
    """Gera um device novo (aleatório) e devolve o JSON persistível.

    Usa o próprio fork (instagrapi) para produzir uuids/user-agent compatíveis
    com o fluxo de login — tudo offline, sem chamada de rede.
    """
    device = dict(random.choice(DEVICE_POOL))
    locale = (idioma or "pt_BR").strip() or "pt_BR"
    tz_name = (timezone_nome or "America/Sao_Paulo").strip() or "America/Sao_Paulo"
    try:
        from instagrapi import Client  # noqa: PLC0415
    except ImportError as exc:  # pragma: no cover — ambiente sem instagrapi
        raise RuntimeError("biblioteca 'instagrapi' não instalada no backend") from exc

    client = Client()
    client.set_device(device, reset=True)  # reset=True → uuids novos a cada geração
    client.set_locale(locale)
    try:
        tzinfo = ZoneInfo(tz_name)
        offset = int(tzinfo.utcoffset(datetime.now(timezone.utc)).total_seconds())
    except Exception:  # noqa: BLE001 — timezone inválido cai em UTC
        tzinfo = timezone.utc
        offset = 0
        tz_name = "UTC"
    client.set_timezone_offset(offset, timezone_name=tz_name)
    settings = client.get_settings()
    return json.dumps(
        {
            "device_settings": settings.get("device_settings") or {},
            "uuids": settings.get("uuids") or {},
            "user_agent": settings.get("user_agent") or "",
            "locale": settings.get("locale") or locale,
            "country": settings.get("country"),
            "country_code": settings.get("country_code"),
            "timezone_offset": offset,
            "timezone_name": tz_name,
            "gerada_em": datetime.now(timezone.utc).isoformat(),
        }
    )


def descrever_fingerprint(fingerprint: str | None) -> str | None:
    """Resumo legível do fingerprint (ex.: 'Pixel 8 Pro · Android 14 · pt_BR')."""
    if not fingerprint:
        return None
    try:
        dados = json.loads(fingerprint)
    except (ValueError, TypeError):
        return None
    dev = dados.get("device_settings") or {}
    modelo = str(dev.get("model") or "").strip()
    release = str(dev.get("android_release") or dev.get("android_version") or "").strip()
    locale = str(dados.get("locale") or "").strip()
    tz = str(dados.get("timezone_name") or "").strip()
    partes = [parte for parte in (modelo, f"Android {release}" if release else None, locale or None, tz or None) if parte]
    return " · ".join(partes) or None
