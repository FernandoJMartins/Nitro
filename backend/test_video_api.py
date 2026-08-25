"""Integração Fase 3+4 pela API: upload -> gerar com flash -> baixar -> verificar."""
import io
import os
import subprocess
from pathlib import Path

os.environ["DATABASE_URL"] = "sqlite:///./_smoke_vid.db"
os.environ["STORAGE_DIR"] = "./_smoke_vid_storage"

from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image  # noqa: E402

from app.main import app  # noqa: E402
from app.services.video import FFMPEG  # noqa: E402

client = TestClient(app)
tmp = Path("_smoke_vid_tmp")
tmp.mkdir(exist_ok=True)


def png(color):
    buf = io.BytesIO()
    Image.new("RGB", (1080, 1920), color).save(buf, format="PNG")
    buf.seek(0)
    return buf


# base azul (photo), hot vermelho (photo)
base_id = client.post("/api/v1/media/photo", files={"file": ("base.png", png((20, 40, 220)), "image/png")}).json()["id"]
hot_id = client.post("/api/v1/media/photo_hot", files={"file": ("hot.png", png((220, 30, 30)), "image/png")}).json()["id"]

# musica
mp3 = tmp / "m.mp3"
subprocess.run([FFMPEG, "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=12", str(mp3)], capture_output=True)
with mp3.open("rb") as f:
    music_id = client.post("/api/v1/media/music", files={"file": ("m.mp3", f, "audio/mpeg")}).json()["id"]

# frase
tid = client.post("/api/v1/phrase-types", json={"nome": "FLIRT"}).json()["id"]
phrase_id = client.post("/api/v1/phrases", json={"phrase_type_id": tid, "texto": "Vem ver você"}).json()["id"]
print("mídias:", base_id, hot_id, music_id, "| frase:", phrase_id)

# gerar com flash
r = client.post("/api/v1/videos/generate", json={
    "base_media_id": base_id, "phrase_id": phrase_id, "music_media_id": music_id,
    "duration": 6.0, "use_flash": True, "hot_media_id": hot_id, "flash_at": 3.0,
})
assert r.status_code == 200, r.text
gen = r.json()
print("gerado:", gen)

# baixar
r = client.get(gen["url"])
assert r.status_code == 200 and r.headers["content-type"] == "video/mp4"
out = tmp / "out.mp4"
out.write_bytes(r.content)
print("baixado:", len(r.content) // 1024, "KB")


def probe(entries):
    return subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", entries, "-of", "default=nk=1:nw=1", str(out)],
        capture_output=True, text=True,
    ).stdout.strip().splitlines()


dur = float(probe("format=duration")[0])
assert abs(dur - 6.0) < 0.4, dur
assert "audio" in probe("stream=codec_type"), "sem áudio"
print(f"duração {dur:.2f}s + áudio ok")


def frame_color(n):
    fp = tmp / f"f{n}.png"
    subprocess.run([FFMPEG, "-y", "-i", str(out), "-vf", f"select=eq(n\\,{n})", "-vframes", "1", str(fp)], capture_output=True)
    px = list(Image.open(fp).resize((8, 8)).getdata())
    return (sum(p[0] for p in px) / len(px), sum(p[2] for p in px) / len(px))  # (R, B)

r89, b89 = frame_color(89)
r90, b90 = frame_color(90)
r91, b91 = frame_color(91)
assert b89 > r89 and r90 > b90 and b91 > r91, (r89, b89, r90, b90, r91, b91)
print(f"flash no frame 90 confirmado (R90={r90:.0f} vs B90={b90:.0f})")

# validação: use_flash sem hot_media_id -> 400
r = client.post("/api/v1/videos/generate", json={"base_media_id": base_id, "use_flash": True})
assert r.status_code == 400
print("validação use_flash sem hot -> 400 ok")

print(">>> FASE 3+4 (API) OK")
