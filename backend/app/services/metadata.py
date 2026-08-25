"""Remoção de metadados das mídias enviadas.

- Vídeos e áudios: ffmpeg com `-map_metadata -1` (stream copy, sem perda,
  remove metadados do container: GPS, dispositivo, data, tags ID3, etc.).
- Imagens: Pillow re-salva sem o bloco EXIF (que contém GPS, câmera, data...).
  Para JPEG usamos quality="keep" para não recomprimir/perder qualidade.

Não depende de exiftool — usa só ffmpeg e Pillow.
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

from PIL import Image

FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = shutil.which("ffprobe") or "ffprobe"

JPEG_EXTS = {".jpg", ".jpeg"}


def _run(cmd: list[str]) -> None:
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"Comando falhou ({' '.join(cmd[:2])}...):\n{result.stderr.strip()}")


def strip_av_metadata(src: Path, dst: Path) -> None:
    """Remove metadados de vídeo ou áudio sem re-encodar (rápido e sem perda)."""
    _run([
        FFMPEG, "-y",
        "-i", str(src),
        "-map_metadata", "-1",
        "-map_chapters", "-1",
        "-c", "copy",
        str(dst),
    ])


def strip_image_metadata(src: Path, dst: Path) -> None:
    """Remove EXIF/metadados de imagem reconstruindo os pixels sem os tags.

    Reconstruir a imagem (putdata) garante que nada de EXIF/ICC/GPS sobrevive.
    JPEG é salvo em qualidade alta (95) por ser um recorte quase imperceptível.
    """
    with Image.open(src) as img:
        clean = Image.new(img.mode, img.size)
        clean.putdata(list(img.getdata()))
        if dst.suffix.lower() in JPEG_EXTS:
            clean.save(dst, format="JPEG", quality=95, subsampling=0)  # 4:4:4, sem perda de croma
        else:
            clean.save(dst)


def probe_duration(path: Path) -> float | None:
    """Retorna a duração em segundos (para áudio/vídeo), ou None se não aplicável."""
    result = subprocess.run(
        [
            FFPROBE, "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        capture_output=True, text=True,
    )
    raw = result.stdout.strip()
    try:
        return round(float(raw), 3)
    except (ValueError, TypeError):
        return None
