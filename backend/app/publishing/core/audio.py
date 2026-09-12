"""Fonte de áudio para uma publicação — manual x tendências (Seção 14), desacoplada da plataforma.

- ManualAudioProvider: o usuário já escolheu o áudio no Content (audio_id) — resolvido em publications.
- TrendingAudioProvider: sorteia entre os áudios em alta catalogados (provider='trending').
- TrendingSource + collect_trending_audio: buscam sugestões reais de uma FONTE EXTERNA
  (padrão: Apple Music RSS "most-played" — público, estável, sem chave de API) e
  popularizam `pub_audios`. Nada de mock devolvendo lista vazia: a coleta consulta
  a fonte configurada de verdade quando habilitada.
"""
from __future__ import annotations

import logging
import random
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone

import requests
from sqlalchemy import select
from sqlalchemy.orm import Session

from ...config import settings
from ..models import Account, AudioAsset

logger = logging.getLogger("nitro.publishing.audio")


class AudioProvider(ABC):
    @abstractmethod
    def pick(self, db: Session, account: Account) -> AudioAsset | None: ...


class ManualAudioProvider(AudioProvider):
    """Áudio escolhido diretamente no Content (audio_id setado) — resolvido em publications."""

    def pick(self, db: Session, account: Account) -> AudioAsset | None:
        return None


class TrendingAudioProvider(AudioProvider):
    """Escolhe entre os áudios em alta catalogados para a plataforma da conta
    (populados por collect_trending_audio), com viés pela popularidade."""

    def pick(self, db: Session, account: Account) -> AudioAsset | None:
        candidatos = list(
            db.scalars(
                select(AudioAsset).where(
                    AudioAsset.user_id == account.user_id,
                    AudioAsset.provider == "trending",
                    AudioAsset.status == "ativo",
                    AudioAsset.platform == account.platform,
                )
            )
        )
        if not candidatos:
            return None
        pesos = [max(a.popularidade or 1, 1) for a in candidatos]
        return random.choices(candidatos, weights=pesos, k=1)[0]


def provider_for_mode(mode: str) -> AudioProvider | None:
    if mode == "automatica":
        return TrendingAudioProvider()
    if mode == "manual":
        return ManualAudioProvider()
    return None


# ---------- fonte externa real de tendências ----------
@dataclass
class TrendingTrack:
    nome: str
    artista: str | None
    external_id: str
    referencia: str | None
    popularidade: int  # 1 = top 1
    generos: list[str] = field(default_factory=list)


class TrendingSource(ABC):
    """Uma fonte externa de áudios/tendências. Implementações concretas buscam os dados de verdade."""

    name: str

    @abstractmethod
    def fetch(self, *, platform: str, limit: int) -> list[TrendingTrack]: ...


class AppleMusicTrendingSource(TrendingSource):
    """Apple Music RSS 'most-played' — feed público por país, sem chave de API.

    Com o país 'br', retorna o chart das mais tocadas no Brasil (máx. 100 faixas).
    Quando `trending_brasileiras_only` está ativo, filtra pelas faixas cujo gênero
    indica música brasileira (sertanejo, funk, pagode, MPB, samba, forró, piseiro,
    etc.); se o filtro sobrar menos que `trending_min_brasileiras`, usa o chart
    completo — a lista nunca fica vazia por causa do filtro.
    """

    name = "apple_music"
    URL = "https://rss.applemarketingtools.com/api/v2/{country}/music/most-played/{limit}/songs.json"

    # heurística de gêneros brasileiros (o feed não informa nacionalidade do artista)
    BR_GENEROS = (
        "sertanejo", "sertaneja", "brasil", "brazil", "pagode", "funk", "mpb",
        "forró", "forro", "samba", "axé", "axe", "piseiro", "arrocha", "gospel",
    )

    def _generos(self, item: dict) -> list[str]:
        return [str(g.get("name") or "").lower() for g in (item.get("genres") or [])]

    def _eh_brasileira(self, track: TrendingTrack) -> bool:
        return any(any(kw in g for kw in self.BR_GENEROS) for g in track.generos)

    def fetch(self, *, platform: str, limit: int) -> list[TrendingTrack]:
        country = (settings.trending_country or "br").lower()
        # o feed do Apple RSS aceita no máximo 100 por requisição (200 -> HTTP 500)
        limit = max(1, min(limit or settings.trending_limit or 100, 100))
        url = self.URL.format(country=country, limit=limit)
        # o feed da Apple é intermitente (504/500) — retry com backoff antes de desistir
        resp = None
        last_exc: Exception | None = None
        for tentativa in range(3):
            try:
                resp = requests.get(url, timeout=60)
                resp.raise_for_status()
                break
            except Exception as exc:  # noqa: BLE001 — fonte externa instável
                last_exc = exc
                time.sleep(2 * (tentativa + 1))
        if resp is None or not resp.ok:
            raise (last_exc or RuntimeError("fonte de tendências não respondeu"))
        data = resp.json()
        results = (data.get("feed") or {}).get("results") or []
        tracks: list[TrendingTrack] = []
        for idx, item in enumerate(results, start=1):
            external_id = str(item.get("id") or "")
            nome = str(item.get("name") or "").strip()
            if not nome or not external_id:
                continue
            artista = item.get("artistName")
            tracks.append(
                TrendingTrack(
                    nome=nome,
                    artista=artista,
                    external_id=external_id,
                    referencia=item.get("url"),
                    popularidade=idx,
                    generos=self._generos(item),
                )
            )

        if settings.trending_brasileiras_only:
            brasileiras = [t for t in tracks if self._eh_brasileira(t)]
            if len(brasileiras) >= settings.trending_min_brasileiras:
                tracks = brasileiras
            else:
                logger.warning(
                    "Filtro de música brasileira sobrou só %d faixas (< %d) — usando o chart completo (%d)",
                    len(brasileiras),
                    settings.trending_min_brasileiras,
                    len(tracks),
                )
        return tracks


TRENDING_SOURCES: dict[str, type[TrendingSource]] = {
    AppleMusicTrendingSource.name: AppleMusicTrendingSource,
}


def source_for(name: str | None = None) -> TrendingSource:
    cls = TRENDING_SOURCES.get(name or settings.trending_source or "apple_music")
    if cls is None:
        cls = AppleMusicTrendingSource
    return cls()


def collect_trending_audio(
    db: Session, user_id: int, *, platform: str = "instagram", limit: int | None = None
) -> list[AudioAsset]:
    """Consulta a fonte externa configurada e faz upsert dos resultados em pub_audios
    (provider='trending'). Devolve os áudios criados/atualizados, na ordem de popularidade."""
    source = source_for()
    tracks = source.fetch(platform=platform, limit=limit or settings.trending_limit)
    if not tracks:
        return []

    atualizados: list[AudioAsset] = []
    for track in tracks:
        asset = db.scalar(
            select(AudioAsset).where(
                AudioAsset.user_id == user_id,
                AudioAsset.provider == "trending",
                AudioAsset.external_id == track.external_id,
            )
        )
        if asset is None:
            asset = AudioAsset(user_id=user_id, provider="trending", external_id=track.external_id)
            db.add(asset)
        nome = track.nome if not track.artista else f"{track.nome} — {track.artista}"
        asset.nome = nome[:255]
        asset.platform = platform
        asset.referencia = track.referencia or track.nome
        asset.popularidade = track.popularidade
        asset.status = "ativo"
        asset.coletado_em = datetime.now(timezone.utc)
        atualizados.append(asset)

    db.commit()
    for asset in atualizados:
        db.refresh(asset)
    return atualizados
