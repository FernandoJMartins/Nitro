"""Teste da Fase 5: geração em massa (SQLite temporário, sem OpenAI)."""
import io
import os
import subprocess
from pathlib import Path

os.environ["DATABASE_URL"] = "sqlite:///./_smoke_bulk.db"
os.environ["STORAGE_DIR"] = "./_smoke_bulk_storage"

from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image  # noqa: E402

from app.main import app  # noqa: E402
from app.services.video import FFMPEG  # noqa: E402

client = TestClient(app)
_tok = client.post("/api/v1/auth/register", json={"email": "bulk@t.com", "senha": "segredo1"}).json()["access_token"]
client.headers.update({"Authorization": f"Bearer {_tok}"})
tmp = Path("_smoke_bulk_tmp")
tmp.mkdir(exist_ok=True)


def png(color):
    buf = io.BytesIO()
    Image.new("RGB", (720, 1280), color).save(buf, format="PNG")
    buf.seek(0)
    return buf


def up_photo(color, name, endpoint="photo"):
    return client.post(f"/api/v1/media/{endpoint}", files={"file": (name, png(color), "image/png")}).json()["id"]


base_ids = [up_photo((30, 60, 200), "b1.png"), up_photo((60, 200, 60), "b2.png")]
hot_ids = [up_photo((220, 20, 20), "h1.png", "photo_hot"), up_photo((230, 120, 10), "h2.png", "photo_hot")]

mp3 = tmp / "m.mp3"
subprocess.run([FFMPEG, "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=8", str(mp3)], capture_output=True)
with mp3.open("rb") as f:
    music_id = client.post("/api/v1/media/music", files={"file": ("m.mp3", f, "audio/mpeg")}).json()["id"]

tid = client.post("/api/v1/phrase-types", json={"nome": "FLIRT"}).json()["id"]
frases = ["Vem cá", "Tá afim?", "Só hoje viu"]
for fr in frases:
    client.post("/api/v1/phrases", json={"phrase_type_id": tid, "texto": fr})

# ---- validações ----
assert client.post("/api/v1/videos/bulk", json={"quantidade": 2, "base_media_ids": []}).status_code == 400
assert client.post("/api/v1/videos/bulk", json={
    "quantidade": 2, "base_media_ids": base_ids, "use_flash": True, "hot_media_ids": []
}).status_code == 400
print("validações ok")

# ---- lote de 4 vídeos com flash ----
N = 4
r = client.post("/api/v1/videos/bulk", json={
    "quantidade": N,
    "base_media_ids": base_ids,
    "music_media_ids": [music_id],
    "hot_media_ids": hot_ids,
    "phrase_type_id": tid,
    "use_ia_texto": False,
    "gerar_legenda_ia": False,
    "duration_min": 3.0,
    "duration_max": 5.0,
    "use_flash": True,
})
assert r.status_code == 200, r.text
job_id = r.json()["id"]

# TestClient roda o background de forma síncrona -> já terminou
job = client.get(f"/api/v1/videos/jobs/{job_id}").json()
print("job:", job)
assert job["status"] == "concluido", job
assert job["concluidos"] == N, job

hist = client.get("/api/v1/videos/history").json()
assert len(hist) == N, len(hist)
assert all(v["usou_flash"] for v in hist), "algum vídeo não usou flash"
assert all(v["texto"] in frases for v in hist), [v["texto"] for v in hist]
assert all(3.0 <= v["duracao"] <= 5.0 for v in hist), [v["duracao"] for v in hist]
print("histórico:", [(v["texto"], v["usou_flash"], v["duracao"]) for v in hist])

# baixar 1
r = client.get(f"/api/v1/videos/{hist[0]['id']}/download")
assert r.status_code == 200 and r.headers["content-type"] == "video/mp4"
print("download do histórico ok ->", len(r.content) // 1024, "KB")

print(">>> FASE 5 (geração em massa) OK")
