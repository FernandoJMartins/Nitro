"""Motor de vídeo (Fase 3) + flash hot de 1 frame (Fase 4).

Monta um vídeo curto (formato vertical 1080x1920) a partir de:
- uma mídia base (foto vira vídeo estático; vídeo é repetido/cortado na duração),
- um texto opcional desenhado DENTRO do vídeo (a frase),
- uma música opcional (repetida/cortada na duração),
- opcionalmente, o FLASH HOT: 1 único frame de uma imagem hot inserido no meio.

Tudo via ffmpeg. Sobre o "1ms": o menor tempo possível é 1 frame (~33ms a 30fps),
por isso o flash é medido em FRAMES, não em milissegundos (ver README).
"""
from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

FFMPEG = shutil.which("ffmpeg") or "ffmpeg"

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".avi"}

# Fonte usada para desenhar o texto (Windows local OU Linux/container).
_FONT_CANDIDATES = [
    Path("C:/Windows/Fonts/arialbd.ttf"),
    Path("C:/Windows/Fonts/arial.ttf"),
    Path("/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"),
    Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
    Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
]


def _font_path() -> str:
    for p in _FONT_CANDIDATES:
        if p.exists():
            return p.as_posix()
    return "arial.ttf"


def _esc_filter_path(p: str) -> str:
    """Escapa o ':' de caminhos do Windows dentro da sintaxe de filtro do ffmpeg."""
    return p.replace("\\", "/").replace(":", "\\:")


def is_image(path: Path) -> bool:
    return path.suffix.lower() in IMAGE_EXTS


def build_video(
    base_path: Path,
    out_path: Path,
    *,
    duration: float,
    text: str | None = None,
    music_path: Path | None = None,
    hot_path: Path | None = None,
    flash_at: float | None = None,
    fps: int = 30,
    width: int = 1080,
    height: int = 1920,
    text_file: Path | None = None,
) -> None:
    """Gera um .mp4. Se hot_path for dado, insere 1 frame do hot em flash_at (seg)."""
    base_is_image = is_image(base_path)

    # ---- entradas (a ordem define os índices [0], [1], ...) ----
    cmd: list[str] = [FFMPEG, "-y"]
    if base_is_image:
        cmd += ["-loop", "1", "-i", str(base_path)]
    else:
        cmd += ["-stream_loop", "-1", "-i", str(base_path)]

    idx = 1
    music_idx = None
    if music_path is not None:
        cmd += ["-stream_loop", "-1", "-i", str(music_path)]
        music_idx = idx
        idx += 1

    hot_idx = None
    if hot_path is not None:
        cmd += ["-loop", "1", "-i", str(hot_path)]
        hot_idx = idx
        idx += 1

    # ---- grafo de filtros ----
    scale_crop = (
        f"scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"crop={width}:{height},setsar=1"
    )
    parts = [f"[0:v]{scale_crop},fps={fps}[base]"]
    cur = "base"

    if text or text_file:
        font = _esc_filter_path(_font_path())
        if text_file is not None:
            src = f"textfile='{_esc_filter_path(text_file.as_posix())}'"
        else:
            safe = (text or "").replace("\\", "\\\\").replace(":", "\\:").replace("'", "\u2019")
            src = f"text='{safe}'"
        drawtext = (
            f"[{cur}]drawtext=fontfile='{font}':{src}:"
            f"fontcolor=white:fontsize=64:borderw=3:bordercolor=black@0.9:"
            f"x=(w-text_w)/2:y=h*0.72:line_spacing=8[txt]"
        )
        parts.append(drawtext)
        cur = "txt"

    if hot_idx is not None:
        frame_num = int(round((flash_at if flash_at is not None else duration / 2) * fps))
        parts.append(f"[{hot_idx}:v]{scale_crop}[hotv]")
        parts.append(f"[{cur}][hotv]overlay=enable='eq(n\\,{frame_num})'[v]")
        cur = "v"

    filter_complex = ";".join(parts)

    cmd += ["-filter_complex", filter_complex, "-map", f"[{cur}]"]
    if music_idx is not None:
        cmd += ["-map", f"{music_idx}:a"]

    cmd += [
        "-t", f"{duration:.3f}",
        "-r", str(fps),
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-pix_fmt", "yuv420p",
    ]
    if music_idx is not None:
        cmd += ["-c:a", "aac", "-b:a", "128k"]
    cmd += ["-movflags", "+faststart", str(out_path)]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg falhou:\n{result.stderr[-1500:]}")
