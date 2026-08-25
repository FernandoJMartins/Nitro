"""Geração EM MASSA (Fase 5).

Para cada vídeo do lote, escolhe ALEATORIAMENTE:
- uma mídia base do pool,
- um texto do pool (lista de frases do usuário OU gerados por IA, se ativado),
- uma música do pool,
- uma foto hot do pool (se o flash estiver ligado).

Legenda da postagem por IA é OPCIONAL (só se gerar_legenda_ia=True).

Roda em background (FastAPI BackgroundTasks) e atualiza o progresso no Job.
Para escala real, trocar por Celery/RQ + Redis (ver README).
"""
from __future__ import annotations

import random
import uuid
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import select

from ..config import settings
from ..database import SessionLocal
from ..models import GeneratedVideo, Job, Media, Phrase, PhraseType
from . import ai, video


@dataclass
class BulkConfig:
    quantidade: int
    base_media_ids: list[int]
    music_media_ids: list[int]
    hot_media_ids: list[int]
    phrase_type_id: int | None
    use_ia_texto: bool
    gerar_legenda_ia: bool
    duration_min: float
    duration_max: float
    use_flash: bool


def _texto_pool(db, cfg: BulkConfig, tipo: PhraseType | None) -> list[str]:
    """Monta o pool de textos que vão DENTRO do vídeo."""
    if cfg.use_ia_texto and tipo is not None:
        exemplos = [
            p.texto
            for p in db.scalars(
                select(Phrase).where(Phrase.phrase_type_id == tipo.id).limit(15)
            )
        ]
        # gera um pool do tamanho do lote (uma chamada só de IA)
        gerados = ai.generate_phrases(tipo.nome, exemplos, max(cfg.quantidade, 1))
        return gerados or exemplos
    if tipo is not None:
        return [p.texto for p in db.scalars(select(Phrase).where(Phrase.phrase_type_id == tipo.id))]
    return []


def run_bulk_job(job_id: int, cfg: BulkConfig) -> None:
    """Executa o lote inteiro. Cada vídeo é isolado: erro em um não derruba os outros."""
    db = SessionLocal()
    try:
        job = db.get(Job, job_id)
        if job is None:
            return
        job.status = "processando"
        db.commit()

        tipo = db.get(PhraseType, cfg.phrase_type_id) if cfg.phrase_type_id else None

        try:
            textos = _texto_pool(db, cfg, tipo)
        except Exception as exc:  # falha da IA de texto derruba o lote todo
            job.status = "erro"
            job.erro = f"Falha ao preparar textos: {exc}"
            db.commit()
            return

        storage = settings.storage_path
        gen_dir = storage / "generated"
        gen_dir.mkdir(parents=True, exist_ok=True)

        tipo_nome = tipo.nome if tipo else None

        for _ in range(cfg.quantidade):
            try:
                base = db.get(Media, random.choice(cfg.base_media_ids))
                if base is None:
                    raise RuntimeError("mídia base do pool não existe mais")

                texto = random.choice(textos) if textos else None
                music_path = None
                if cfg.music_media_ids:
                    m = db.get(Media, random.choice(cfg.music_media_ids))
                    music_path = storage / m.caminho if m else None

                hot_path = None
                if cfg.use_flash and cfg.hot_media_ids:
                    h = db.get(Media, random.choice(cfg.hot_media_ids))
                    hot_path = storage / h.caminho if h else None

                # duração sorteada dentro do range escolhido (foto estática ou vídeo).
                lo, hi = sorted((cfg.duration_min, cfg.duration_max))
                dur = round(random.uniform(lo, hi), 2)

                token = uuid.uuid4().hex
                out_path = gen_dir / f"{token}.mp4"
                video.build_video(
                    storage / base.caminho, out_path,
                    duration=dur,
                    text=texto,
                    music_path=music_path,
                    hot_path=hot_path,
                )

                legenda = None
                if cfg.gerar_legenda_ia:
                    try:
                        legenda = ai.generate_caption(texto, tipo_nome)
                    except Exception:  # legenda é opcional: falha não derruba o vídeo
                        legenda = None

                db.add(GeneratedVideo(
                    job_id=job_id,
                    caminho=f"generated/{token}.mp4",
                    duracao=dur,
                    texto=texto,
                    legenda=legenda,
                    usou_flash=bool(hot_path),
                ))
                job.concluidos += 1
                db.commit()
            except Exception as exc:  # noqa: BLE001 — registra e segue
                job.erro = (job.erro or "") + f"[vídeo falhou: {exc}] "
                db.commit()

        job.status = "concluido"
        db.commit()
    finally:
        db.close()
