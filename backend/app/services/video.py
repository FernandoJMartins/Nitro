"""Motor de vídeo (Fase 3) + flash hot (Fase 4).

Monta um vídeo curto (formato vertical 1080x1920) a partir de:
- uma mídia base (foto vira vídeo estático; vídeo é repetido/cortado na duração),
- um texto opcional desenhado DENTRO do vídeo (a frase),
- uma música opcional (repetida/cortada na duração),
- opcionalmente, o FLASH HOT: um bloco curto de frames da imagem hot no meio.

Tudo via ffmpeg. O flash é medido em FRAMES. O padrão (FLASH_FRAMES_DEFAULT)
é a menor duração de foto do CapCut (~0,1s = 3 frames a 30fps), não 1 frame só.
"""
from __future__ import annotations

import shutil
import subprocess
import textwrap
import uuid
from pathlib import Path

FFMPEG = shutil.which("ffmpeg") or "ffmpeg"

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".avi"}

# Duração padrão do flash hot: a menor duração de foto do CapCut é ~0,1s.
# A 30fps isso dá 3 frames (0,1 * 30). Antes era 1 frame só (curto demais).
FLASH_FRAMES_DEFAULT = 3

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


def wrap_text(text: str, width: int = 25) -> str:
    """Quebra o texto em várias linhas (por palavra) para caber na tela.

    Ex.: "poucas pessoas conseguem acertar o momento certo" ->
         "poucas pessoas conseguem\\nacertar o momento certo"
    """
    linhas: list[str] = []
    for paragrafo in text.splitlines() or [text]:
        wrapped = textwrap.wrap(paragrafo, width=width, break_long_words=True) or [""]
        linhas.extend(wrapped)
    return "\n".join(linhas)


def build_video(
    base_path: Path,
    out_path: Path,
    *,
    duration: float,
    text: str | None = None,
    music_path: Path | None = None,
    hot_path: Path | None = None,
    flash_at: float | None = None,
    flash_frames: int = FLASH_FRAMES_DEFAULT,
    fps: int = 30,
    width: int = 1080,
    height: int = 1920,
    text_file: Path | None = None,
    wrap_width: int = 25,
) -> None:
    """Gera um .mp4. Se hot_path for dado, insere o flash hot em flash_at (seg).

    O flash dura ``flash_frames`` frames (padrão: a menor duração de foto do
    CapCut, ~0,1s = 3 frames a 30fps), não 1 único frame.
    """
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

    # ---- texto: quebrado em linhas; cada linha é um drawtext próprio (centralizado) ----
    # Desenhar linha a linha evita bugs do drawtext ao interpretar '\n' de textfile.
    temp_textfiles: list[Path] = []
    if text_file is not None and not text:
        text = text_file.read_text(encoding="utf-8")
    if text:
        font = _esc_filter_path(_font_path())
        lines = [ln for ln in wrap_text(text, wrap_width).split("\n") if ln.strip()]
        line_h = 90  # altura de cada linha (fontsize 64 + espaçamento)
        y0 = height * 0.72 - (len(lines) * line_h) / 2  # bloco centrado ~72% da altura
        for i, line in enumerate(lines):
            lf = out_path.parent / f".txt_{uuid.uuid4().hex}.txt"
            lf.write_bytes(line.encode("utf-8"))
            temp_textfiles.append(lf)
            y = int(y0 + i * line_h)
            parts.append(
                f"[{cur}]drawtext=fontfile='{font}':textfile='{_esc_filter_path(lf.as_posix())}':"
                f"fontcolor=white:fontsize=64:borderw=3:bordercolor=black@0.9:"
                f"x=(w-text_w)/2:y={y}[txt{i}]"
            )
            cur = f"txt{i}"

    if hot_idx is not None:
        frame_num = int(round((flash_at if flash_at is not None else duration / 2) * fps))
        n = max(1, int(flash_frames))
        # início centrado no instante do flash, para o bloco de frames cair "no meio"
        start = max(0, frame_num - n // 2)
        end = start + n - 1  # between() é inclusivo
        parts.append(f"[{hot_idx}:v]{scale_crop}[hotv]")
        parts.append(
            f"[{cur}][hotv]overlay=enable='between(n\\,{start}\\,{end})'[v]"
        )
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

    try:
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg falhou:\n{result.stderr[-1500:]}")
    finally:
        for lf in temp_textfiles:
            lf.unlink(missing_ok=True)
