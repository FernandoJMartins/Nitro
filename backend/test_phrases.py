"""Testes da Fase 2: frases + IA (SQLite temporário, sem precisar de Postgres/OpenAI)."""
import os

os.environ["DATABASE_URL"] = "sqlite:///./_smoke_phrases.db"
os.environ["STORAGE_DIR"] = "./_smoke_storage"

from fastapi.testclient import TestClient  # noqa: E402

from app.services import ai  # noqa: E402

# ---------- funções puras ----------
msgs = ai.build_messages("FLIRT", ["Vem cá", "Que calor"], 3, "seja ousado")
assert msgs[0]["role"] == "system"
assert "FLIRT" in msgs[1]["content"] and "Vem cá" in msgs[1]["content"]
assert "seja ousado" in msgs[1]["content"]
print("build_messages ok")

parsed = ai.parse_phrases('1. "Vem ver meu portfólio"\n2) Tá afim de um café?\n- Só isso mesmo\n\n', limit=2)
assert parsed == ["Vem ver meu portfólio", "Tá afim de um café?"], parsed
print("parse_phrases ok ->", parsed)

# ---------- API ----------
from app.main import app  # noqa: E402

client = TestClient(app)

# cria tipo
r = client.post("/api/v1/phrase-types", json={"nome": "FLIRT", "descricao": "provocante"})
assert r.status_code == 200, r.text
tid = r.json()["id"]
print("cria tipo ok -> id", tid)

# duplicado -> 409
assert client.post("/api/v1/phrase-types", json={"nome": "FLIRT"}).status_code == 409
print("tipo duplicado rejeitado ok")

# adiciona frases manuais
for txt in ["Vem cá que eu te explico", "Tá com fome de quê?"]:
    r = client.post("/api/v1/phrases", json={"phrase_type_id": tid, "texto": txt})
    assert r.status_code == 200, r.text
assert len(client.get(f"/api/v1/phrases?tipo_id={tid}").json()) == 2
print("frases manuais ok")

# IA sem chave -> 400 com mensagem clara
r = client.post("/api/v1/phrases/ai", json={"phrase_type_id": tid, "quantidade": 3})
assert r.status_code == 400 and "OPENAI_API_KEY" in r.json()["detail"], r.text
print("IA sem chave -> 400 ok")

# IA com a chamada de rede mockada
ai.generate_phrases = lambda *a, **k: ["Sugestão A", "Sugestão B", "Sugestão C"]  # type: ignore
r = client.post("/api/v1/phrases/ai", json={"phrase_type_id": tid, "quantidade": 3})
assert r.status_code == 200, r.text
data = r.json()
assert data["frases"] == ["Sugestão A", "Sugestão B", "Sugestão C"]
assert data["baseado_em"] == 2  # usou as 2 frases manuais como exemplo
print("IA (mock) ok ->", data["frases"], "| baseado_em:", data["baseado_em"])

# salva as sugestões escolhidas
r = client.post(
    "/api/v1/phrases/bulk-save",
    json={"phrase_type_id": tid, "textos": ["Sugestão A", "Sugestão B"], "origem": "ia"},
)
assert r.status_code == 200 and all(p["origem"] == "ia" for p in r.json())
assert len(client.get(f"/api/v1/phrases?tipo_id={tid}").json()) == 4  # 2 manuais + 2 ia
print("bulk-save de sugestões ok")

# deletar tipo remove as frases (cascade)
assert client.delete(f"/api/v1/phrase-types/{tid}").status_code == 204
assert client.get(f"/api/v1/phrases?tipo_id={tid}").json() == []
print("delete tipo (cascade) ok")

print(">>> FASE 2 OK")
