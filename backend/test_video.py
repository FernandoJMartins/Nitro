"""Teste do motor de vídeo (Fase 3) + flash de 1 frame (Fase 4)."""
import subprocess
from pathlib import Path

from PIL import Image

from app.services.video import FFMPEG, build_video

tmp = Path("_test_video")
tmp.mkdir(exist_ok=True)

W, H, FPS = 1080, 1920, 30
base = tmp / "base.png"
hot = tmp / "hot.png"
music = tmp / "music.mp3"
out = tmp / "out.mp4"

Image.new("RGB", (W, H), (20, 40, 220)).save(base)   # azul
Image.new("RGB", (W, H), (220, 30, 30)).save(hot)     # vermelho (hot)
subprocess.run(
    [FFMPEG, "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=12", str(music)],
    capture_output=True,
)

DURATION = 6.0
FLASH_AT = 3.0
FLASH_FRAME = int(round(FLASH_AT * FPS))  # 90

build_video(
    base, out,
    duration=DURATION,
    text="Vem ver você 😏",
    music_path=music,
    hot_path=hot,
    flash_at=FLASH_AT,
    fps=FPS, width=W, height=H,
)
assert out.exists() and out.stat().st_size > 0
print("vídeo gerado:", out.stat().st_size // 1024, "KB")


def probe(entries, stream=""):
    r = subprocess.run(
        ["ffprobe", "-v", "error", *(["-select_streams", stream] if stream else []),
         "-show_entries", entries, "-of", "default=nk=1:nw=1", str(out)],
        capture_output=True, text=True,
    )
    return r.stdout.strip().splitlines()


dur = float(probe("format=duration")[0])
print(f"duração: {dur:.2f}s (esperado ~{DURATION})")
assert abs(dur - DURATION) < 0.4, dur

codecs = probe("stream=codec_type")
assert "video" in codecs and "audio" in codecs, codecs
print("streams:", codecs)


def frame_color(n: int):
    """Extrai o frame n e retorna a cor média (R,G,B)."""
    fp = tmp / f"f{n}.png"
    subprocess.run(
        [FFMPEG, "-y", "-i", str(out), "-vf", f"select=eq(n\\,{n})", "-vframes", "1", str(fp)],
        capture_output=True,
    )
    img = Image.open(fp).resize((10, 10))
    px = list(img.getdata())
    r = sum(p[0] for p in px) / len(px)
    g = sum(p[1] for p in px) / len(px)
    b = sum(p[2] for p in px) / len(px)
    return r, g, b


r0, g0, b0 = frame_color(FLASH_FRAME - 1)   # antes do flash → azul
rf, gf, bf = frame_color(FLASH_FRAME)       # o flash → vermelho
r1, g1, b1 = frame_color(FLASH_FRAME + 1)   # depois do flash → azul

print(f"frame {FLASH_FRAME-1} (antes) : R={r0:.0f} G={g0:.0f} B={b0:.0f}")
print(f"frame {FLASH_FRAME}   (FLASH) : R={rf:.0f} G={gf:.0f} B={bf:.0f}")
print(f"frame {FLASH_FRAME+1} (depois): R={r1:.0f} G={g1:.0f} B={b1:.0f}")

assert b0 > r0, "frame antes deveria ser AZUL"
assert rf > bf, "o frame do FLASH deveria ser VERMELHO (hot)"
assert b1 > r1, "frame depois deveria ser AZUL"
print(">>> FLASH caiu em EXATAMENTE 1 frame. MOTOR DE VÍDEO OK")
