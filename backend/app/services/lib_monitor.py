"""Monitor da biblioteca do Instagram (instagrapi) para o painel Admin → Sistema.

O Instagram muda o login com frequência e só uma versão nova da biblioteca
volta a funcionar (ex.: 3.0.1 → 3.2.11 corrigiu o 429 no envio da senha).
Este módulo responde, sem nunca quebrar o painel:

- qual versão está rodando e desde quando (detecta sozinho quando foi atualizada);
- qual é a versão mais nova publicada no GitHub (consulta pública, cache de 12h);
- se os logins estão falhando por bloqueio do Instagram (429 / "versão desatualizada").
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from importlib import metadata

import requests
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..config import settings

logger = logging.getLogger("nitro.lib_monitor")

REPO = "subzeroid/instagrapi"
CACHE_SEGUNDOS = 12 * 3600
_lock = threading.Lock()
_cache: dict = {"ultima": None, "url": None, "verificado_em": None, "erro": None, "_ts": 0.0}

# trechos de erro de login que indicam bloqueio/rejeição do Instagram (não senha errada)
SINAIS_BLOQUEIO = ("429", "too many requests", "limitou as tentativas", "versão desatualizada", "needs_upgrade")


def versao_instalada() -> str | None:
    try:
        return metadata.version("instagrapi")
    except metadata.PackageNotFoundError:
        return None


def _tupla(v: str | None) -> tuple:
    return tuple(int(x) for x in re.findall(r"\d+", v or ""))[:4]


def _historico_path():
    return settings.storage_path / "_instagrapi_versoes.json"


def registrar_versao() -> dict:
    """Guarda (em STORAGE_DIR) quando a versão em uso mudou. Chamado no startup."""
    atual = versao_instalada()
    path = _historico_path()
    try:
        dados = json.loads(path.read_text()) if path.exists() else {}
    except Exception:  # noqa: BLE001
        dados = {}
    if atual and dados.get("versao") != atual:
        anterior = dados.get("versao")
        dados = {
            "versao": atual,
            "desde": datetime.now(timezone.utc).isoformat(),
            "anterior": anterior,
        }
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(dados))
            if anterior:
                logger.info("instagrapi atualizada: %s → %s", anterior, atual)
        except Exception:  # noqa: BLE001 — histórico é só informativo
            pass
    return dados


def _buscar_ultima() -> None:
    """Consulta a última release no GitHub (sem credenciais, timeout curto)."""
    try:
        r = requests.get(
            f"https://api.github.com/repos/{REPO}/releases/latest",
            headers={"Accept": "application/vnd.github+json", "User-Agent": "nitro-lib-monitor"},
            timeout=6,
        )
        r.raise_for_status()
        j = r.json()
        _cache.update(
            ultima=str(j.get("tag_name") or "").lstrip("v") or None,
            url=j.get("html_url"),
            erro=None,
        )
    except Exception as exc:  # noqa: BLE001 — sem internet/limite do GitHub: só informa
        _cache["erro"] = f"não foi possível consultar o GitHub ({type(exc).__name__})"
    _cache["verificado_em"] = datetime.now(timezone.utc)
    _cache["_ts"] = time.time()


def _ultima_versao() -> None:
    with _lock:
        if time.time() - _cache["_ts"] > CACHE_SEGUNDOS:
            _buscar_ultima()


def falhas_de_login(db: Session, horas: int = 24) -> dict:
    """Contas cujo último erro (nas últimas `horas`) foi bloqueio do Instagram."""
    from ..publishing.models import Account

    desde = datetime.now(timezone.utc) - timedelta(hours=horas)
    filtro = or_(*[func.lower(Account.ultimo_erro).contains(s) for s in SINAIS_BLOQUEIO])
    bloqueadas = db.scalar(
        select(func.count(Account.id)).where(Account.ultimo_erro_em >= desde, filtro)
    ) or 0
    conectadas = db.scalar(select(func.count(Account.id)).where(Account.ultimo_acesso_em >= desde)) or 0
    return {"bloqueadas_24h": bloqueadas, "logins_ok_24h": conectadas}


def status(db: Session) -> dict:
    """Bloco 'instagram' do /admin/system, com os alertas já decididos."""
    _ultima_versao()
    hist = registrar_versao()
    instalada = versao_instalada()
    ultima = _cache["ultima"]
    desatualizada = bool(instalada and ultima and _tupla(ultima) > _tupla(instalada))
    falhas = falhas_de_login(db)

    alertas: list[tuple[str, str]] = []
    if desatualizada:
        alertas.append((
            "atencao",
            f"Biblioteca do Instagram desatualizada: em uso {instalada}, disponível {ultima}. "
            "Se os logins/postagens começarem a falhar, ela precisa ser atualizada.",
        ))
    if falhas["bloqueadas_24h"] >= 2 and falhas["bloqueadas_24h"] > falhas["logins_ok_24h"]:
        nivel = "critico" if desatualizada else "atencao"
        alertas.append((
            nivel,
            f"{falhas['bloqueadas_24h']} contas foram bloqueadas pelo Instagram no login nas últimas 24h "
            "(429 / \"versão desatualizada\")"
            + (" — provável causa: biblioteca desatualizada, atualize." if desatualizada
               else " — confira usuário/senha e o tipo de proxy (use residencial)."),
        ))

    return {
        "biblioteca": {
            "instalada": instalada,
            "em_uso_desde": hist.get("desde"),
            "anterior": hist.get("anterior"),
            "ultima": ultima,
            "ultima_url": _cache["url"],
            "desatualizada": desatualizada,
            "verificado_em": _cache["verificado_em"],
            "erro": _cache["erro"],
        },
        "logins": falhas,
        "_alertas": alertas,
    }
