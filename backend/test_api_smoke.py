"""Smoke test da API completa com SQLite temporário (não precisa do Postgres)."""
import io
import os

os.environ["DATABASE_URL"] = "sqlite:///./_smoke.db"
os.environ["STORAGE_DIR"] = "./_smoke_storage"

from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image  # noqa: E402

from app.main import app  # noqa: E402

client = TestClient(app)

# health
assert client.get("/health").json() == {"status": "ok"}
print("health ok")

# monta uma foto com EXIF em memoria
buf = io.BytesIO()
img = Image.new("RGB", (100, 100), (10, 200, 90))
exif = img.getexif()
exif[0x0110] = "CameraSecreta"
img.save(buf, format="JPEG", exif=exif.tobytes())
buf.seek(0)

# upload photo
r = client.post("/api/v1/media/photo", files={"file": ("teste.jpg", buf, "image/jpeg")})
assert r.status_code == 200, r.text
media = r.json()
print("upload photo ok -> id", media["id"], "| metadados_removidos:", media["metadados_removidos"])
assert media["metadados_removidos"] is True

# list
r = client.get("/api/v1/media?tipo=photo")
assert r.status_code == 200 and len(r.json()) == 1
print("list ok ->", len(r.json()), "item(s)")

# download e conferir que o EXIF sumiu no arquivo baixado
r = client.get(f"/api/v1/media/{media['id']}/download")
assert r.status_code == 200
downloaded = Image.open(io.BytesIO(r.content))
assert not dict(downloaded.getexif()), "EXIF sobreviveu no download!"
print("download ok -> EXIF vazio no arquivo final")

# rejeita extensao invalida
r = client.post("/api/v1/media/photo", files={"file": ("x.txt", b"nope", "text/plain")})
assert r.status_code == 400
print("rejeicao de extensao invalida ok")

# delete
r = client.delete(f"/api/v1/media/{media['id']}")
assert r.status_code == 204
assert client.get("/api/v1/media?tipo=photo").json() == []
print("delete ok")

print(">>> SMOKE TEST OK")
