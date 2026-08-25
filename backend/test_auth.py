"""Fase 7: auth + API key + isolamento entre usuários (SQLite temporário)."""
import io
import os

os.environ["DATABASE_URL"] = "sqlite:///./_smoke_auth.db"
os.environ["STORAGE_DIR"] = "./_smoke_auth_storage"

from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image  # noqa: E402

from app.main import app  # noqa: E402

client = TestClient(app)


def png():
    buf = io.BytesIO()
    Image.new("RGB", (64, 64), (10, 20, 30)).save(buf, format="PNG")
    buf.seek(0)
    return buf


def auth(token):
    return {"Authorization": f"Bearer {token}"}


# ---- sem token, tudo bloqueado ----
assert client.get("/api/v1/media").status_code == 401
assert client.get("/api/v1/phrase-types").status_code == 401
print("sem token -> 401 ok")

# ---- registro + validações ----
assert client.post("/api/v1/auth/register", json={"email": "x", "senha": "123456"}).status_code == 400  # email inválido
assert client.post("/api/v1/auth/register", json={"email": "a@a.com", "senha": "123"}).status_code == 400  # senha curta

tokA = client.post("/api/v1/auth/register", json={"email": "a@a.com", "senha": "segredo1"}).json()["access_token"]
tokB = client.post("/api/v1/auth/register", json={"email": "b@b.com", "senha": "segredo2"}).json()["access_token"]
print("registro A e B ok")

# email duplicado -> 409
assert client.post("/api/v1/auth/register", json={"email": "a@a.com", "senha": "segredo1"}).status_code == 409

# login errado / certo
assert client.post("/api/v1/auth/login", json={"email": "a@a.com", "senha": "errada"}).status_code == 401
assert client.post("/api/v1/auth/login", json={"email": "a@a.com", "senha": "segredo1"}).status_code == 200
print("login ok")

# /me
me = client.get("/api/v1/auth/me", headers=auth(tokA)).json()
assert me["email"] == "a@a.com"
print("me ok ->", me["email"])

# ---- A cria mídia e frase ----
mediaA = client.post("/api/v1/media/photo", files={"file": ("a.png", png(), "image/png")}, headers=auth(tokA)).json()
tA = client.post("/api/v1/phrase-types", json={"nome": "FLIRT"}, headers=auth(tokA)).json()["id"]
client.post("/api/v1/phrases", json={"phrase_type_id": tA, "texto": "oi A"}, headers=auth(tokA))
print("A criou mídia", mediaA["id"], "e tipo", tA)

# ---- ISOLAMENTO: B não vê nada de A ----
assert client.get("/api/v1/media", headers=auth(tokB)).json() == []
assert client.get("/api/v1/phrase-types", headers=auth(tokB)).json() == []
# B não pode baixar a mídia de A (via header)
assert client.get(f"/api/v1/media/{mediaA['id']}/download", headers=auth(tokB)).status_code == 404
# B não pode apagar a mídia de A
assert client.delete(f"/api/v1/media/{mediaA['id']}", headers=auth(tokB)).status_code == 404
print("isolamento entre usuários ok")

# A vê o seu
assert len(client.get("/api/v1/media", headers=auth(tokA)).json()) == 1
# nomes iguais de tipo para usuários diferentes são permitidos
assert client.post("/api/v1/phrase-types", json={"nome": "FLIRT"}, headers=auth(tokB)).status_code == 200
print("mesmo nome de tipo p/ usuários diferentes ok")

# ---- API key: cria, usa como Bearer, funciona igual ----
created = client.post("/api/v1/keys", json={"nome": "integração"}, headers=auth(tokA)).json()
raw = created["chave"]
assert raw.startswith("nitro_")
# usando a API key no lugar do JWT
via_key = client.get("/api/v1/media", headers=auth(raw)).json()
assert len(via_key) == 1, via_key
print("API key funciona como Bearer ok ->", created["prefixo"])

# lista de chaves não expõe a chave crua
keys = client.get("/api/v1/keys", headers=auth(tokA)).json()
assert "chave" not in keys[0]
# revogar a chave
client.delete(f"/api/v1/keys/{created['id']}", headers=auth(tokA))
assert client.get("/api/v1/media", headers=auth(raw)).status_code == 401
print("revogação de API key ok")

# ---- download via ?token= (para tags <video>/<a>) ----
r = client.get(f"/api/v1/media/{mediaA['id']}/download?token={tokA}")
assert r.status_code == 200
r = client.get(f"/api/v1/media/{mediaA['id']}/download?token={tokB}")
assert r.status_code == 404  # token de B não acessa mídia de A
print("download via ?token= ok")

print(">>> FASE 7 (auth + API) OK")
