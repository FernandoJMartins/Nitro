"""Teste manual: confirma que a remoção de metadados funciona de verdade."""
import subprocess
from pathlib import Path

from PIL import Image

from app.services.metadata import FFMPEG, FFPROBE, strip_av_metadata, strip_image_metadata

tmp = Path("_test_tmp")
tmp.mkdir(exist_ok=True)

# ---------- VÍDEO ----------
dirty_vid = tmp / "dirty.mp4"
clean_vid = tmp / "clean.mp4"
subprocess.run([
    FFMPEG, "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=30",
    "-metadata", "title=SEGREDO", "-metadata", "comment=GPS 12.34,56.78",
    "-metadata", "make=iPhone", str(dirty_vid),
], capture_output=True)


def tags(path):
    r = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries", "format_tags", "-of", "default=nk=1", str(path)],
        capture_output=True, text=True,
    )
    return r.stdout.strip()


print("VÍDEO antes :", repr(tags(dirty_vid)))
strip_av_metadata(dirty_vid, clean_vid)
print("VÍDEO depois:", repr(tags(clean_vid)))
assert "SEGREDO" not in tags(clean_vid), "FALHOU: metadado de vídeo sobreviveu!"
print("  -> OK: metadados de vídeo removidos\n")

# ---------- IMAGEM ----------
dirty_img = tmp / "dirty.jpg"
clean_img = tmp / "clean.jpg"
img = Image.new("RGB", (200, 200), (120, 60, 200))
exif = img.getexif()
exif[0x010E] = "DESCRICAO SECRETA"   # ImageDescription
exif[0x0110] = "iPhone 15 Pro"       # Model
img.save(dirty_img, exif=exif.tobytes())

before = dict(Image.open(dirty_img).getexif())
strip_image_metadata(dirty_img, clean_img)
after = dict(Image.open(clean_img).getexif())
print("IMAGEM antes :", before)
print("IMAGEM depois:", after)
assert not after, "FALHOU: EXIF da imagem sobreviveu!"
print("  -> OK: EXIF da imagem removido\n")

print(">>> TODOS OS TESTES PASSARAM")
