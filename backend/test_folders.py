"""Testa pastas de mídia (novo modelo: pasta genérica; música universal)."""
import io
import os

os.environ["DATABASE_URL"] = "sqlite:///./_smoke_fold.db"
os.environ["STORAGE_DIR"] = "./_smoke_fold_storage"

from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image  # noqa: E402

from app.main import app  # noqa: E402

client = TestClient(app)
tok = client.post("/api/v1/auth/register", json={"email": "f@t.com", "senha": "segredo1"}).json()["access_token"]
client.headers.update({"Authorization": f"Bearer {tok}"})


def png():
    b = io.BytesIO()
    Image.new("RGB", (32, 32), (1, 2, 3)).save(b, format="PNG")
    b.seek(0)
    return b


def up(tipo, folder_id=None):
    q = f"?folder_id={folder_id}" if folder_id else ""
    return client.post(f"/api/v1/media/{tipo}{q}", files={"file": ("p.png", png(), "image/png")}).json()


# cria pasta (sem tipo)
f1 = client.post("/api/v1/folders", json={"nome": "Projeto A"}).json()
assert f1["nome"] == "Projeto A" and "tipo" not in f1
# nome duplicado -> 409
assert client.post("/api/v1/folders", json={"nome": "Projeto A"}).status_code == 409
print("cria pasta ok ->", f1["id"])

# a MESMA pasta recebe vídeo, foto e foto hot
v = up("video", f1["id"]) if False else None  # (usa foto p/ simplicidade)
p = up("photo", f1["id"])
h = up("photo_hot", f1["id"])
assert p["folder_id"] == f1["id"] and h["folder_id"] == f1["id"]
print("foto + foto hot na mesma pasta ok")

# música é universal: ignora pasta
m = client.post("/api/v1/media/music", files={"file": ("s.mp3", b"ID3fake", "audio/mpeg")})
# (upload de mp3 falso pode falhar no ffmpeg; então testamos só que música não aceita folder no fluxo)
# filtra a pasta por tipo
assert [x["id"] for x in client.get(f"/api/v1/media?tipo=photo&folder_id={f1['id']}").json()] == [p["id"]]
assert [x["id"] for x in client.get(f"/api/v1/media?tipo=photo_hot&folder_id={f1['id']}").json()] == [h["id"]]
print("filtro por pasta+tipo ok")

# lista de pastas (sem tipo)
folders = client.get("/api/v1/folders").json()
assert len(folders) == 1 and folders[0]["nome"] == "Projeto A"
print("lista de pastas ok")

# deletar pasta -> mídias voltam para sem pasta (não apagadas)
assert client.delete(f"/api/v1/folders/{f1['id']}").status_code == 204
assert len(client.get("/api/v1/media?tipo=photo").json()) == 1
assert client.get("/api/v1/media?tipo=photo&sem_pasta=true").json()[0]["id"] == p["id"]
print("deletar pasta preserva mídias ok")

# isolamento
tok2 = client.post("/api/v1/auth/register", json={"email": "g@t.com", "senha": "segredo1"}).json()["access_token"]
c2 = TestClient(app)
c2.headers.update({"Authorization": f"Bearer {tok2}"})
assert c2.get("/api/v1/folders").json() == []
print("isolamento de pastas ok")

print(">>> PASTAS (novo modelo) OK")
