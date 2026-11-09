"""Saúde do servidor para o painel admin: disco, memória, CPU e uptime.

Lê /proc (Linux). Dentro do Docker, /proc/meminfo e o loadavg são os do HOST e
o disco é o do volume de mídias — exatamente o que interessa monitorar.
"""
from __future__ import annotations

import os
import shutil
import time
from pathlib import Path

_INICIO = time.time()


def _meminfo() -> dict[str, int]:
    out: dict[str, int] = {}
    try:
        for linha in Path("/proc/meminfo").read_text().splitlines():
            k, v = linha.split(":", 1)
            out[k] = int(v.strip().split()[0]) * 1024
    except OSError:
        pass
    return out


def _uptime_host() -> float | None:
    try:
        return float(Path("/proc/uptime").read_text().split()[0])
    except (OSError, ValueError, IndexError):
        return None


def snapshot(storage: Path) -> dict:
    du = shutil.disk_usage(storage)
    mem = _meminfo()
    total = mem.get("MemTotal", 0)
    disponivel = mem.get("MemAvailable", 0)
    swap_total = mem.get("SwapTotal", 0)
    swap_livre = mem.get("SwapFree", 0)
    try:
        load1, load5, load15 = os.getloadavg()
    except OSError:
        load1 = load5 = load15 = 0.0
    return {
        "disco": {"total": du.total, "usado": du.used, "livre": du.free},
        "memoria": {"total": total, "usado": max(0, total - disponivel)},
        "swap": {"total": swap_total, "usado": max(0, swap_total - swap_livre)},
        "cpu": {"nucleos": os.cpu_count() or 1, "load1": load1, "load5": load5, "load15": load15},
        "uptime_servidor_s": _uptime_host(),
        "uptime_app_s": time.time() - _INICIO,
    }
