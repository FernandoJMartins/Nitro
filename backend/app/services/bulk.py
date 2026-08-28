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
from . import ai, metadata, video


@dataclass
class BulkConfig:
    user_id: int
    quantidade: int
    base_media_ids: list[int]
    music_media_ids: list[int]
    # tipo de frase por tipo de vídeo (ex.: {"pause": 3, "imagem": 5}). Cada tipo tem
    # seus próprios textos. `phrase_type_id` é um fallback global (vídeo simples / compat).
    phrase_type_id: int | None
    text_types: dict[str, int | None]
    use_ia_texto: bool
    gerar_legenda_ia: bool
    duration_min: float
    duration_max: float
    # tipos de vídeo habilitados (sorteados por vídeo). Vazio = vídeo simples.
    video_types: list[str]
    hot_media_ids: list[int]
    overlay_media_ids: list[int]
    final_media_ids: list[int]
    font_id: str | None
    text_x: float
    text_y: float
    overlay_x: float
    overlay_y: float
    overlay_scale: float = 1.0


def _eff_phrase_type(cfg: BulkConfig, modo: str | None) -> int | None:
    """Tipo de frase efetivo para o modo sorteado (o do tipo de vídeo, ou o global)."""
    if modo is not None:
        pt = cfg.text_types.get(modo)
        if pt:
            return pt
    return cfg.phrase_type_id


def _build_pools(db, cfg: BulkConfig) -> tuple[dict[int, list[str]], dict[int, str]]:
    """Pré-monta o pool de textos de CADA tipo de frase usado (por vídeo-tipo + global)."""
    ids: set[int] = set()
    if cfg.phrase_type_id:
        ids.add(cfg.phrase_type_id)
    for v in cfg.text_types.values():
        if v:
            ids.add(v)

    pools: dict[int, list[str]] = {}
    names: dict[int, str] = {}
    for pid in ids:
        tipo = db.get(PhraseType, pid)
        if tipo is None:
            continue
        names[pid] = tipo.nome
        if cfg.use_ia_texto:
            exemplos = [
                p.texto
                for p in db.scalars(select(Phrase).where(Phrase.phrase_type_id == pid).limit(15))
            ]
            gerados = ai.generate_phrases(tipo.nome, exemplos, max(cfg.quantidade, 1))
            pools[pid] = gerados or exemplos
        else:
            pools[pid] = [p.texto for p in db.scalars(select(Phrase).where(Phrase.phrase_type_id == pid))]
    return pools, names


def run_bulk_job(job_id: int, cfg: BulkConfig) -> None:
    """Executa o lote inteiro. Cada vídeo é isolado: erro em um não derruba os outros."""
    db = SessionLocal()
    try:
        job = db.get(Job, job_id)
        if job is None:
            return
        job.status = "processando"
        db.commit()

        try:
            pools, names = _build_pools(db, cfg)
        except Exception as exc:  # falha da IA de texto derruba o lote todo
            job.status = "erro"
            job.erro = f"Falha ao preparar textos: {exc}"
            db.commit()
            return

        storage = settings.storage_path
        gen_dir = storage / "generated"
        gen_dir.mkdir(parents=True, exist_ok=True)

        font_path = video.font_path_for(cfg.font_id)

        def _rand_path(ids: list[int]) -> Path | None:
            """Sorteia uma mídia do pool e devolve o caminho absoluto (ou None)."""
            if not ids:
                return None
            m = db.get(Media, random.choice(ids))
            return storage / m.caminho if m else None

        for _ in range(cfg.quantidade):
            try:
                base = db.get(Media, random.choice(cfg.base_media_ids))
                if base is None:
                    raise RuntimeError("mídia base do pool não existe mais")

                music_path = _rand_path(cfg.music_media_ids)

                # sorteia UM tipo de vídeo entre os habilitados (ou nenhum = simples)
                modo = random.choice(cfg.video_types) if cfg.video_types else None

                # texto vem do tipo de frase DAQUELE tipo de vídeo (ou do fallback global)
                eff_pt = _eff_phrase_type(cfg, modo)
                textos = pools.get(eff_pt, []) if eff_pt else []
                texto = random.choice(textos) if textos else None

                kwargs: dict = {}
                if modo == "pause":
                    kwargs["hot_path"] = _rand_path(cfg.hot_media_ids)
                elif modo == "imagem":
                    kwargs["overlay_path"] = _rand_path(cfg.overlay_media_ids)
                    kwargs["overlay_x"] = cfg.overlay_x
                    kwargs["overlay_y"] = cfg.overlay_y
                    kwargs["overlay_scale"] = cfg.overlay_scale
                elif modo == "final":
                    fp = _rand_path(cfg.final_media_ids)
                    kwargs["final_path"] = fp
                    # foto no fim: duração fixa; vídeo no fim: usa a própria duração (limitada)
                    if fp is not None:
                        if video.is_image(fp):
                            kwargs["final_duration"] = video.FINAL_PHOTO_SECONDS
                        else:
                            natural = metadata.probe_duration(fp) or video.FINAL_PHOTO_SECONDS
                            kwargs["final_duration"] = max(1.0, min(natural, 8.0))

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
                    font_path=font_path,
                    text_x=cfg.text_x,
                    text_y=cfg.text_y,
                    **kwargs,
                )

                legenda = None
                if cfg.gerar_legenda_ia:
                    try:
                        legenda = ai.generate_caption(texto, names.get(eff_pt) if eff_pt else None)
                    except Exception:  # legenda é opcional: falha não derruba o vídeo
                        legenda = None

                db.add(GeneratedVideo(
                    user_id=cfg.user_id,
                    job_id=job_id,
                    caminho=f"generated/{token}.mp4",
                    duracao=dur,
                    texto=texto,
                    legenda=legenda,
                    usou_flash=(modo == "pause"),
                    tipo_video=modo,
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
