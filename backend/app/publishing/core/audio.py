"""Fonte de áudio para uma publicação — manual x catálogo (Seção 14), desacoplada da plataforma.

- ManualAudioProvider: o usuário já escolheu o áudio no Content (audio_id) — resolvido em publications.
- TrendingAudioProvider: sorteia entre os áudios catalogados com provider='trending'
  (cadastrados via a API de áudios), com viés pela popularidade.

A coleta automática de fonte externa (Apple Music) foi REMOVIDA — a biblioteca de
músicas agora tem só upload de MP3 e importação por link do Instagram.
"""
from __future__ import annotations

import random
from abc import ABC, abstractmethod

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Account, AudioAsset


class AudioProvider(ABC):
    @abstractmethod
    def pick(self, db: Session, account: Account) -> AudioAsset | None: ...


class ManualAudioProvider(AudioProvider):
    """Áudio escolhido diretamente no Content (audio_id setado) — resolvido em publications."""

    def pick(self, db: Session, account: Account) -> AudioAsset | None:
        return None


class TrendingAudioProvider(AudioProvider):
    """Escolhe entre os áudios catalogados como 'trending' para a plataforma da
    conta, com viés pela popularidade. O catálogo é cadastrado pelo operador via
    POST /api/v1/publishing/audio."""

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
