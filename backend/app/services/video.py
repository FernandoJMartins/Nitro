"""Motor de vídeo (Fase 3) + tipos de vídeo (pause / imagem estática / clipe final).

Monta um vídeo curto (formato vertical 1080x1920) a partir de:
- uma mídia base (foto vira vídeo estático; vídeo é repetido/cortado na duração),
- um texto opcional desenhado DENTRO do vídeo (a frase),
- uma música opcional (repetida/cortada na duração),
- e UM tipo de vídeo (opcional), que muda o formato:
    * pause  -> FLASH HOT: um bloco curto de frames da imagem hot no meio (subliminar);
    * imagem -> IMAGEM ESTÁTICA sobreposta no topo/embaixo, acima do texto (a duração toda);
    * final  -> CLIPE FINAL: um vídeo/foto extra concatenado no fim (com o mesmo texto).

Tudo via ffmpeg. Cada vídeo do lote usa só UM tipo (sorteado), então as opções
não se combinam — o código tolera, mas na prática só uma via é usada por vez.

A fonte do texto é escolhível: há um conjunto curado (mapeado para fontes do
sistema) e qualquer .ttf/.otf solto em ``STORAGE_DIR/fonts`` também vira opção.
"""
from __future__ import annotations

import re
import shutil
import subprocess
import textwrap
import uuid
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from ..config import settings

FFMPEG = shutil.which("ffmpeg") or "ffmpeg"
FFPROBE = shutil.which("ffprobe") or "ffprobe"

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".avi"}

# Duração padrão do flash hot: a menor duração de foto do CapCut é ~0,1s.
# A 30fps isso dá 3 frames (0,1 * 30). Antes era 1 frame só (curto demais).
FLASH_FRAMES_DEFAULT = 3

# Duração padrão do clipe final quando ele é uma FOTO (vídeos usam a própria duração).
FINAL_PHOTO_SECONDS = 3.0

# Fator de ampliação da imagem estática: prints pequenos ficam pequenos demais,
# então damos um leve "boost" (ainda limitado pela caixa 0.85 x 0.45). O preview usa o mesmo.
OVERLAY_SCALE = 1.75

# Fonte padrão (fallback) usada quando nada foi escolhido / nada existe no sistema.
_FONT_CANDIDATES = [
    Path("C:/Windows/Fonts/arialbd.ttf"),
    Path("C:/Windows/Fonts/arial.ttf"),
    Path("/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"),
    Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
    Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
]

# Fonte de emoji COLORIDO (para o texto renderizado no vídeo não sair como quadrado).
# Prioridade: emoji da Apple (iPhone) que o usuário soltar em storage/fonts — a fonte
# da Apple é proprietária e NÃO pode ser empacotada, então precisa ser fornecida.
# Depois cai no Noto Color Emoji (Linux/Docker) ou Segoe UI Emoji (Windows).
# Nomes aceitos para o arquivo da Apple em storage/fonts (qualquer um serve):
_APPLE_EMOJI_NAMES = [
    "Apple Color Emoji.ttc",
    "AppleColorEmoji.ttc",
    "Apple Color Emoji.ttf",
    "AppleColorEmoji.ttf",
    "apple-emoji.ttf",
    "apple-emoji.ttc",
]
_EMOJI_FONT_CANDIDATES = [
    Path("/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf"),
    Path("C:/Windows/Fonts/seguiemj.ttf"),
]

# ---- Fontes curadas (id -> nome + caminhos candidatos Windows/Linux) ----
# A fonte oficial do Instagram ("Instagram Sans") é proprietária e não pode ser
# empacotada. "Impacto" é o estilo mais próximo do negrito forte dos Stories.
# Para adicionar outras fontes, basta soltar o .ttf/.otf em STORAGE_DIR/fonts.
# "css" é a família aproximada para o navegador renderizar a fonte no <select>/preview.
FONTS: dict[str, dict] = {
    "classica": {
        "nome": "Clássica (Arial negrito)",
        "css": 'Arial, Helvetica, sans-serif',
        "paths": [
            "C:/Windows/Fonts/arialbd.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        ],
    },
    "impacto": {
        "nome": "Impacto (estilo Stories)",
        "css": 'Impact, Haettenschweiler, "Arial Narrow Bold", sans-serif',
        "paths": [
            "C:/Windows/Fonts/impact.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        ],
    },
    "moderna": {
        "nome": "Moderna (Verdana negrito)",
        "css": 'Verdana, Geneva, sans-serif',
        "paths": [
            "C:/Windows/Fonts/verdanab.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        ],
    },
    "elegante": {
        "nome": "Elegante (Georgia negrito)",
        "css": 'Georgia, "Times New Roman", serif',
        "paths": [
            "C:/Windows/Fonts/georgiab.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
        ],
    },
    "manuscrita": {
        "nome": "Manuscrita (Comic Sans)",
        "css": '"Comic Sans MS", "Comic Sans", cursive',
        "paths": [
            "C:/Windows/Fonts/comicbd.ttf",
            "C:/Windows/Fonts/comic.ttf",
        ],
    },
    "maquina": {
        "nome": "Máquina de escrever (mono)",
        "css": '"Courier New", Courier, monospace',
        "paths": [
            "C:/Windows/Fonts/courbd.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
        ],
    },
}


def _fonts_dir() -> Path:
    d = settings.storage_path / "fonts"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _first_existing(paths: list[str]) -> str | None:
    for p in paths:
        if Path(p).exists():
            return Path(p).as_posix()
    return None


def _font_path() -> str:
    for p in _FONT_CANDIDATES:
        if p.exists():
            return p.as_posix()
    return "arial.ttf"


def font_path_for(font_id: str | None) -> str:
    """Resolve o id da fonte para um caminho de arquivo utilizável.

    ``font_id`` pode ser um id curado (ex.: "impacto") ou "custom:<arquivo>"
    apontando para um .ttf/.otf em STORAGE_DIR/fonts. Cai no padrão se não achar.
    """
    if font_id:
        if font_id in FONTS:
            got = _first_existing(FONTS[font_id]["paths"])
            if got:
                return got
        elif font_id.startswith("custom:"):
            cand = _fonts_dir() / font_id.split(":", 1)[1]
            if cand.exists():
                return cand.as_posix()
    return _font_path()


def available_fonts() -> list[dict]:
    """Lista as fontes que dá para usar de fato (as curadas presentes + as soltas)."""
    out: list[dict] = []
    for fid, meta in FONTS.items():
        if _first_existing(meta["paths"]):
            out.append({"id": fid, "nome": meta["nome"], "origem": "sistema", "css": meta["css"]})
    for ext in ("*.ttf", "*.otf"):
        for f in sorted(_fonts_dir().glob(ext)):
            # fonte solta: sem família web garantida — usa um genérico no navegador.
            out.append({"id": f"custom:{f.name}", "nome": f"📁 {f.stem}", "origem": "arquivo", "css": "inherit"})
    return out


def _esc_filter_path(p: str) -> str:
    """Escapa o ':' de caminhos do Windows dentro da sintaxe de filtro do ffmpeg."""
    return p.replace("\\", "/").replace(":", "\\:")


def is_image(path: Path) -> bool:
    return path.suffix.lower() in IMAGE_EXTS


def _has_audio(path: Path) -> bool:
    """Diz se o arquivo tem pelo menos uma trilha de áudio (via ffprobe)."""
    if is_image(path):
        return False
    result = subprocess.run(
        [
            FFPROBE, "-v", "error",
            "-select_streams", "a",
            "-show_entries", "stream=index",
            "-of", "csv=p=0",
            str(path),
        ],
        capture_output=True, text=True,
    )
    return bool(result.stdout.strip())


def wrap_text(text: str, width: int = 25) -> str:
    """Quebra o texto em várias linhas (por palavra) para caber na tela."""
    linhas: list[str] = []
    for paragrafo in text.splitlines() or [text]:
        wrapped = textwrap.wrap(paragrafo, width=width, break_long_words=True) or [""]
        linhas.extend(wrapped)
    return "\n".join(linhas)


# ===================== Renderização do texto (com emoji colorido) =====================
# O drawtext do ffmpeg usa uma fonte só e emoji vira "quadrado" (glifo ausente).
# Então renderizamos cada linha com o Pillow, combinando a fonte do texto com uma
# fonte de emoji colorido, gerando um PNG transparente sobreposto no vídeo.

DEFAULT_FONTSIZE = 64
STROKE = 3
LINE_H = 90  # espaçamento vertical entre linhas (para o tamanho de fonte padrão)
LINE_H_RATIO = LINE_H / DEFAULT_FONTSIZE  # espaçamento escala junto com o tamanho da fonte escolhido

# Um "pedaço" de emoji: caracteres de emoji, seletores de variação, ZWJ e tons de pele
# juntos (para sequências como 👨‍👩‍👧 ou 👍🏽 ficarem no mesmo grupo).
_EMOJI_RE = re.compile(
    "(["
    "\U0001F000-\U0001FAFF"
    "\U00002600-\U000027BF"
    "\U00002B00-\U00002BFF"
    "\U0001F1E6-\U0001F1FF"
    "\U0000FE00-\U0000FE0F"
    "\U0000200D"
    "]+)"
)

_emoji_font_cache: tuple[str, int] | None = None
_emoji_font_resolved = False


def _emoji_font() -> tuple[str, int] | None:
    """Acha a fonte de emoji colorido e um tamanho de strike que o Pillow aceite.

    A fonte da Apple (iPhone) tem prioridade se o usuário soltar o arquivo em
    ``storage/fonts`` (ela é proprietária e não vem empacotada). Emoji da Apple usa
    strikes maiores (160), por isso os tamanhos testados incluem esses valores.
    """
    global _emoji_font_cache, _emoji_font_resolved
    if _emoji_font_resolved:
        return _emoji_font_cache
    _emoji_font_resolved = True
    # 1º: Apple emoji fornecido pelo usuário; 2º: fontes do sistema.
    candidates = [_fonts_dir() / name for name in _APPLE_EMOJI_NAMES] + _EMOJI_FONT_CANDIDATES
    for cand in candidates:
        if not cand.exists():
            continue
        for size in (160, 137, 128, 109, 96, 64, 20):
            try:
                ImageFont.truetype(cand.as_posix(), size)
                _emoji_font_cache = (cand.as_posix(), size)
                return _emoji_font_cache
            except OSError:
                continue
    return None


def _render_emoji_seg(seg: str, target_h: int) -> Image.Image | None:
    info = _emoji_font()
    if info is None:
        return None
    path, ns = info
    try:
        font = ImageFont.truetype(path, ns)
        canvas = Image.new("RGBA", (ns * (len(seg) + 2), int(ns * 1.6)), (0, 0, 0, 0))
        d = ImageDraw.Draw(canvas)
        d.text((0, 0), seg, font=font, embedded_color=True)
        bbox = canvas.getbbox()
        if not bbox:
            return None
        crop = canvas.crop(bbox)
        scale = target_h / crop.height
        return crop.resize((max(1, round(crop.width * scale)), target_h), Image.LANCZOS)
    except Exception:
        return None


def _render_text_seg(seg: str, font: ImageFont.FreeTypeFont) -> Image.Image:
    tmp = Image.new("RGBA", (1, 1))
    d = ImageDraw.Draw(tmp)
    x0, y0, x1, y1 = d.textbbox((0, 0), seg, font=font, stroke_width=STROKE)
    w, h = max(1, x1 - x0), max(1, y1 - y0)
    img = Image.new("RGBA", (w + 2 * STROKE, h + 2 * STROKE), (0, 0, 0, 0))
    ImageDraw.Draw(img).text(
        (STROKE - x0, STROKE - y0), seg, font=font,
        fill="white", stroke_width=STROKE, stroke_fill=(0, 0, 0, 230),
    )
    return img


def _render_line_png(
    line: str, text_font_path: str, out_dir: Path, font_size: int = DEFAULT_FONTSIZE
) -> tuple[Path, int, int] | None:
    """Renderiza uma linha (texto + emoji) num PNG transparente. Devolve (caminho, w, h)."""
    try:
        tfont = ImageFont.truetype(text_font_path, font_size)
    except OSError:
        return None
    segs: list[Image.Image] = []
    for chunk in _EMOJI_RE.split(line):
        if not chunk:
            continue
        if _EMOJI_RE.fullmatch(chunk):
            em = _render_emoji_seg(chunk, font_size)
            if em is not None:
                segs.append(em)
            else:  # sem fonte de emoji: desenha como texto normal mesmo (fallback)
                segs.append(_render_text_seg(chunk, tfont))
        else:
            segs.append(_render_text_seg(chunk, tfont))
    if not segs:
        return None
    total_w = sum(s.width for s in segs)
    max_h = max(s.height for s in segs)
    canvas = Image.new("RGBA", (total_w, max_h), (0, 0, 0, 0))
    x = 0
    for s in segs:
        canvas.alpha_composite(s, (x, (max_h - s.height) // 2))
        x += s.width
    png = out_dir / f".line_{uuid.uuid4().hex}.png"
    canvas.save(png)
    return png, total_w, max_h


def _draw_text_chain(
    parts: list[str],
    cur: str,
    text: str | None,
    *,
    font: str,
    width: int,
    height: int,
    wrap_width: int,
    out_dir: Path,
    temp_files: list[Path],
    text_x: float = 0.5,
    text_y: float = 0.72,
    font_size: int = DEFAULT_FONTSIZE,
    prefix: str = "txt",
) -> str:
    """Desenha o texto linha a linha e devolve o label final do vídeo.

    Cada linha é renderizada com Pillow (fonte do texto + fonte de emoji colorido) num
    PNG transparente, sobreposto via ``movie``. O bloco é centrado no ponto
    (text_x, text_y) — frações da tela [0..1] definidas no preview. Se o Pillow falhar
    numa linha, cai no ``drawtext`` do ffmpeg (sem emoji, mas sem quebrar).
    """
    if not text:
        return cur
    raw_font = font.replace("\\:", ":")  # o `font` chega escapado p/ o ffmpeg
    lines = [ln for ln in wrap_text(text, wrap_width).split("\n") if ln.strip()]
    line_h = round(font_size * LINE_H_RATIO)  # espaçamento acompanha o tamanho escolhido
    cx = int(text_x * width)  # centro horizontal em px
    y0 = height * text_y - (len(lines) * line_h) / 2  # bloco centrado no ponto escolhido
    for i, line in enumerate(lines):
        lbl = f"{prefix}{i}"
        rendered = _render_line_png(line, raw_font, out_dir, font_size)
        if rendered is not None:
            png, _pw, ph = rendered
            temp_files.append(png)
            y = int(y0 + i * line_h + (line_h - ph) / 2)
            parts.append(f"movie='{_esc_filter_path(png.as_posix())}'[{lbl}src]")
            parts.append(f"[{cur}][{lbl}src]overlay=x={cx}-w/2:y={y}[{lbl}]")
        else:  # fallback: drawtext (sem emoji)
            lf = out_dir / f".txt_{uuid.uuid4().hex}.txt"
            lf.write_bytes(line.encode("utf-8"))
            temp_files.append(lf)
            y = int(y0 + i * line_h)
            parts.append(
                f"[{cur}]drawtext=fontfile='{font}':textfile='{_esc_filter_path(lf.as_posix())}':"
                f"fontcolor=white:fontsize={font_size}:borderw={STROKE}:bordercolor=black@0.9:"
                f"x={cx}-text_w/2:y={y}[{lbl}]"
            )
        cur = lbl
    return cur


def _run_ffmpeg(cmd: list[str], temp_files: list[Path]) -> None:
    try:
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg falhou:\n{result.stderr[-1500:]}")
    finally:
        for lf in temp_files:
            lf.unlink(missing_ok=True)


def build_video(
    base_path: Path,
    out_path: Path,
    *,
    duration: float,
    text: str | None = None,
    music_path: Path | None = None,
    # tipo "pause" (flash hot)
    hot_path: Path | None = None,
    flash_at: float | None = None,
    flash_frames: int = FLASH_FRAMES_DEFAULT,
    # tipo "imagem" (imagem estática sobreposta) — centro em frações [0..1]
    overlay_path: Path | None = None,
    overlay_x: float = 0.5,
    overlay_y: float = 0.22,
    overlay_scale: float = 1.0,
    # tipo "final" (clipe final concatenado)
    final_path: Path | None = None,
    final_duration: float = FINAL_PHOTO_SECONDS,
    # aparência / posição do texto (centro em frações [0..1])
    font_path: str | None = None,
    font_size: int = DEFAULT_FONTSIZE,
    text_x: float = 0.5,
    text_y: float = 0.72,
    fps: int = 30,
    width: int = 1080,
    height: int = 1920,
    text_file: Path | None = None,
    wrap_width: int = 25,
) -> None:
    """Gera um .mp4 aplicando (no máximo) um tipo de vídeo especial.

    - ``hot_path``     -> flash hot subliminar no meio (tipo "pause");
    - ``overlay_path`` -> imagem estática no topo/embaixo, acima do texto (tipo "imagem");
    - ``final_path``   -> clipe (vídeo/foto) concatenado no fim (tipo "final").
    """
    if text_file is not None and not text:
        text = text_file.read_text(encoding="utf-8")

    font = _esc_filter_path(font_path or _font_path())
    scale_crop = (
        f"scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"crop={width}:{height},setsar=1"
    )
    out_dir = out_path.parent
    temp_files: list[Path] = []

    # ================= tipo "final": concatena um clipe no fim =================
    if final_path is not None:
        base_is_image = is_image(base_path)
        final_is_image = is_image(final_path)

        cmd: list[str] = [FFMPEG, "-y"]
        cmd += (["-loop", "1", "-i", str(base_path)] if base_is_image
                else ["-stream_loop", "-1", "-i", str(base_path)])
        idx = 1
        music_idx = None
        if music_path is not None:
            cmd += ["-stream_loop", "-1", "-i", str(music_path)]
            music_idx = idx
            idx += 1
        cmd += (["-loop", "1", "-i", str(final_path)] if final_is_image
                else ["-stream_loop", "-1", "-i", str(final_path)])
        final_idx = idx
        idx += 1

        # o clipe final mantém o áudio dele (se tiver) no trecho final do vídeo.
        final_has_audio = _has_audio(final_path)
        # entrada de silêncio: usada onde não há música/áudio de clipe para preencher.
        anull_idx = None
        if music_idx is None:
            cmd += ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"]
            anull_idx = idx
            idx += 1

        parts: list[str] = []
        # segmento A: a base, cortada na duração principal
        parts.append(
            f"[0:v]{scale_crop},fps={fps},trim=duration={duration:.3f},setpts=PTS-STARTPTS[a0]"
        )
        a = _draw_text_chain(parts, "a0", text, font=font, width=width, height=height,
                             wrap_width=wrap_width, out_dir=out_dir, temp_files=temp_files,
                             text_x=text_x, text_y=text_y, font_size=font_size, prefix="at")
        # segmento B: o clipe final, cortado na duração dele.
        # SEM texto: quando o clipe final começa, o texto principal some.
        parts.append(
            f"[{final_idx}:v]{scale_crop},fps={fps},trim=duration={final_duration:.3f},setpts=PTS-STARTPTS[b0]"
        )
        b = "b0"
        parts.append(f"[{a}][{b}]concat=n=2:v=1:a=0[outv]")

        # ---- áudio: a música universal (se houver) loopa o vídeo INTEIRO, inclusive
        # sobre o clipe final — o áudio do próprio clipe só entra quando NÃO há música. ----
        afmt = "aformat=sample_rates=44100:channel_layouts=stereo"
        a_src = music_idx if music_idx is not None else anull_idx
        parts.append(
            f"[{a_src}:a]atrim=duration={duration:.3f},asetpts=PTS-STARTPTS,{afmt}[aA]"
        )
        if music_idx is not None:
            b_src = music_idx
        elif final_has_audio:
            b_src = final_idx
        else:
            b_src = anull_idx
        if b_src == music_idx:
            # continua o loop DE ONDE PAROU (sem recomeçar do zero no clipe final)
            parts.append(
                f"[{music_idx}:a]atrim=start={duration:.3f}:duration={final_duration:.3f},"
                f"asetpts=PTS-STARTPTS,{afmt}[aB]"
            )
        else:
            parts.append(
                f"[{b_src}:a]atrim=duration={final_duration:.3f},asetpts=PTS-STARTPTS,{afmt}[aB]"
            )
        parts.append("[aA][aB]concat=n=2:v=0:a=1[outa]")

        total = duration + final_duration
        cmd += ["-filter_complex", ";".join(parts), "-map", "[outv]", "-map", "[outa]"]
        cmd += ["-t", f"{total:.3f}", "-r", str(fps), "-c:v", "libx264",
                "-preset", "veryfast", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "128k"]
        cmd += ["-movflags", "+faststart", str(out_path)]
        _run_ffmpeg(cmd, temp_files)
        return

    # ============ tipos "pause"/"imagem" e vídeo simples (sem concat) ============
    base_is_image = is_image(base_path)
    cmd = [FFMPEG, "-y"]
    cmd += (["-loop", "1", "-i", str(base_path)] if base_is_image
            else ["-stream_loop", "-1", "-i", str(base_path)])
    idx = 1
    music_idx = None
    if music_path is not None:
        cmd += ["-stream_loop", "-1", "-i", str(music_path)]
        music_idx = idx
        idx += 1
    ov_idx = None
    if overlay_path is not None:
        cmd += ["-loop", "1", "-i", str(overlay_path)]
        ov_idx = idx
        idx += 1
    hot_idx = None
    if hot_path is not None:
        cmd += ["-loop", "1", "-i", str(hot_path)]
        hot_idx = idx
        idx += 1

    parts = [f"[0:v]{scale_crop},fps={fps}[base]"]
    cur = "base"

    # imagem estática (a duração toda), centrada no ponto (overlay_x, overlay_y).
    # Cabe numa caixa (0.85 largura x 0.45 altura) preservando o aspecto. Amplia no
    # máximo OVERLAY_SCALE vezes o nativo (leve boost p/ prints pequenos), sem estourar a caixa.
    if ov_idx is not None:
        s = max(0.3, min(2.5, overlay_scale))  # multiplicador de tamanho escolhido pelo usuário
        ow = int(width * 0.85 * s)
        oh = int(height * 0.45 * s)
        cap = OVERLAY_SCALE * s
        parts.append(
            f"[{ov_idx}:v]scale=w='min(iw*{cap},{ow})':h='min(ih*{cap},{oh})':"
            f"force_original_aspect_ratio=decrease[ovs]"
        )
        parts.append(
            f"[{cur}][ovs]overlay=x=W*{overlay_x:.4f}-w/2:y=H*{overlay_y:.4f}-h/2[ovout]"
        )
        cur = "ovout"

    # texto (por cima da base/imagem), no ponto (text_x, text_y)
    cur = _draw_text_chain(parts, cur, text, font=font, width=width, height=height,
                           wrap_width=wrap_width, out_dir=out_dir, temp_files=temp_files,
                           text_x=text_x, text_y=text_y, font_size=font_size, prefix="txt")

    # flash hot subliminar no meio
    if hot_idx is not None:
        frame_num = int(round((flash_at if flash_at is not None else duration / 2) * fps))
        n = max(1, int(flash_frames))
        start = max(0, frame_num - n // 2)
        end = start + n - 1  # between() é inclusivo
        parts.append(f"[{hot_idx}:v]{scale_crop}[hotv]")
        parts.append(f"[{cur}][hotv]overlay=enable='between(n\\,{start}\\,{end})'[v]")
        cur = "v"

    cmd += ["-filter_complex", ";".join(parts), "-map", f"[{cur}]"]
    if music_idx is not None:
        cmd += ["-map", f"{music_idx}:a"]
    cmd += ["-t", f"{duration:.3f}", "-r", str(fps), "-c:v", "libx264",
            "-preset", "veryfast", "-pix_fmt", "yuv420p"]
    if music_idx is not None:
        cmd += ["-c:a", "aac", "-b:a", "128k"]
    cmd += ["-movflags", "+faststart", str(out_path)]
    _run_ffmpeg(cmd, temp_files)
