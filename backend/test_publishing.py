"""Teste do módulo de Publicação Automatizada Multicontas (SQLite temporário).

Cobre: contas/proxies, importação do Sistema A, distribuição uniforme,
aprovação, agendamento, execução (adapter falso injetado) com confirmação real,
isolamento de falha por conta/proxy, retries controlados, stories multi-plano,
tendências, calendário, dashboard e logs.

O adapter real (InstagramAdapter/instagrapi) NÃO roda aqui — o transporte é
substituído por um fake registrado no registro de adapters, sem tocar na rede.
"""
import io
import os
import uuid

os.environ["DATABASE_URL"] = "sqlite:///./_smoke_pub.db"
os.environ["STORAGE_DIR"] = "./_smoke_pub_storage"

from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image  # noqa: E402
from sqlalchemy import select  # noqa: E402

from app.database import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402
from app.models import GeneratedVideo  # noqa: E402
from app.publishing.core import publications  # noqa: E402
from app.publishing.core.publications import execute_publication  # noqa: E402
from app.publishing.core.scheduling import build_schedule_for_account  # noqa: E402
from app.publishing.core.stories import ensure_daily_stories  # noqa: E402
from app.publishing.core.workers import run_cycle  # noqa: E402
from app.publishing.models import Account, ContentMedia, Publication  # noqa: E402
from app.publishing.platforms.base import PlatformAdapter, PublishContext, PublishResult  # noqa: E402


class FakeInstagramAdapter(PlatformAdapter):
    """Substituto do transporte real para testes offline — mesmo contrato do InstagramAdapter."""

    name = "instagram"

    def __init__(self, *, proxy=None, **kwargs):
        super().__init__(proxy=proxy)

    def open(self) -> None:
        return None

    def login(self, ctx: PublishContext) -> str | None:
        if not ctx.account_username:
            raise ValueError("username ausente")
        return ctx.session_data or f"fake-session:{ctx.account_username}:{uuid.uuid4().hex[:8]}"

    def check_session(self, ctx: PublishContext) -> bool:
        return bool(ctx.session_data)

    def create_reel(self, ctx: PublishContext) -> None:
        return None

    def set_caption(self, ctx: PublishContext) -> None:
        return None

    def select_audio(self, ctx: PublishContext) -> None:
        return None

    def publish(self, ctx: PublishContext) -> PublishResult:
        return PublishResult(external_id=f"fake-{uuid.uuid4().hex[:12]}", confirmed=False)

    def create_story(self, ctx: PublishContext) -> None:
        return None

    def attach_link(self, ctx: PublishContext) -> None:
        return None

    def confirm_publication(self, ctx: PublishContext, result: PublishResult) -> bool:
        return result.external_id is not None

    def close(self) -> None:
        return None


# o núcleo consulta o registro de adapters em tempo de execução — troca o transporte
publications.ADAPTERS["instagram"] = FakeInstagramAdapter

client = TestClient(app)
_tok = client.post("/api/v1/auth/register", json={"email": "pub@t.com", "senha": "segredo1"}).json()["access_token"]
client.headers.update({"Authorization": f"Bearer {_tok}"})
USER_ID = client.get("/api/v1/auth/me").json()["id"]

WIDE_WINDOW = {"janela_inicio": "00:00", "janela_fim": "23:59"}

# ---------- setup: 5 "vídeos gerados" (Sistema A), sem depender do ffmpeg ----------
db = SessionLocal()
gen_ids = []
for i in range(5):
    gv = GeneratedVideo(user_id=USER_ID, caminho=f"generated/fake_{i}.mp4", duracao=8.0, legenda=None)
    db.add(gv)
    db.flush()
    gen_ids.append(gv.id)
db.commit()
db.close()
print("vídeos de teste criados:", gen_ids)

# ---------- proxies ----------
proxy_ok = client.post(
    "/api/v1/publishing/proxies", json={"nome": "proxy-b", "host": "203.0.113.10", "porta": 1080}
).json()
proxy_bad = client.post(
    "/api/v1/publishing/proxies", json={"nome": "proxy-quebrado", "host": "203.0.113.254", "porta": 1}
).json()
assert proxy_ok["status"] == "cinza" and proxy_bad["status"] == "cinza"
print("proxies criados sem check automático ok")

# ---------- contas ----------
acc_a = client.post(
    "/api/v1/publishing/accounts", json={"nome_interno": "Perfil A", "username": "perfil01", **WIDE_WINDOW}
).json()
acc_b = client.post(
    "/api/v1/publishing/accounts", json={"nome_interno": "Perfil B", "username": "perfil02", **WIDE_WINDOW}
).json()
acc_c = client.post(
    "/api/v1/publishing/accounts",
    json={
        "nome_interno": "Perfil C",
        "username": "perfil03",
        "proxy_id": proxy_bad["id"],
        **WIDE_WINDOW,
    },
).json()
for acc in (acc_a, acc_b, acc_c):
    r = client.post(f"/api/v1/publishing/accounts/{acc['id']}/ready")
    assert r.status_code == 200 and r.json()["status"] == "pronta"
print("3 contas criadas e prontas (perfil03 com proxy inválido)")

# rejeita proxy de outro usuário / inexistente
r = client.post("/api/v1/publishing/accounts", json={"nome_interno": "x", "username": "y", "proxy_id": 9999})
assert r.status_code == 404
print("validação de proxy inexistente ok")

# ---------- senha criptografada: nunca volta em texto puro pela API ----------
r = client.patch(f"/api/v1/publishing/accounts/{acc_a['id']}", json={"senha": "senha-super-secreta"})
assert r.status_code == 200
assert r.json()["senha_configurada"] is True
assert "senha" not in r.json() and "senha_enc" not in r.json()
db = SessionLocal()
from app.security import decrypt_secret  # noqa: E402

conta_a_db = db.get(Account, acc_a["id"])
assert conta_a_db.senha_enc is not None and conta_a_db.senha_enc != "senha-super-secreta"
assert decrypt_secret(conta_a_db.senha_enc) == "senha-super-secreta"
db.close()
print("senha criptografada em repouso, nunca exposta pela API ok")

# ---------- legenda global ----------
client.post("/api/v1/publishing/captions", json={"titulo": "Padrão", "texto": "Confere aí {{random_emoji}}"})

# ---------- importação + distribuição uniforme ----------
importaveis = client.get("/api/v1/publishing/content/importable").json()
assert len(importaveis) == 5, importaveis
r = client.post("/api/v1/publishing/content", json={"generated_video_ids": gen_ids, "auto_distribute": True})
assert r.status_code == 200, r.text
contents = r.json()
assert len(contents) == 5
assert client.get("/api/v1/publishing/content/importable").json() == []

counts: dict[int, int] = {}
for c in contents:
    counts[c["account_id"]] = counts.get(c["account_id"], 0) + 1
assert sum(counts.values()) == 5
assert max(counts.values()) - min(counts.values()) <= 1, counts
print("distribuição uniforme ok ->", counts)

# ---------- aprovação (todas as 5, para manter a distribuição uniforme determinística) ----------
pendentes = client.get("/api/v1/publishing/content?approval_status=pendente").json()
assert len(pendentes) == 5
ids = [c["id"] for c in pendentes]
r = client.post("/api/v1/publishing/content/approve", json={"ids": ids})
assert r.status_code == 200 and len(r.json()) == 5
aprovados = client.get("/api/v1/publishing/content?approval_status=aprovado").json()
assert len(aprovados) == 5
print("aprovação (selecionados) ok ->", len(aprovados), "aprovados")

# ---------- item à parte: testa importação manual, redistribute, reject único e reject-all ----------
db = SessionLocal()
gv_extra = GeneratedVideo(user_id=USER_ID, caminho="generated/fake_extra.mp4", duracao=6.0)
db.add(gv_extra)
db.commit()
db.refresh(gv_extra)
db.close()

r = client.post("/api/v1/publishing/content", json={"generated_video_ids": [gv_extra.id], "auto_distribute": False})
extra = r.json()[0]
assert extra["account_id"] is None, "sem auto_distribute não deveria ter conta atribuída"

r = client.post(f"/api/v1/publishing/content/{extra['id']}/redistribute")
assert r.status_code == 200 and r.json()["account_id"] is not None
print("redistribute manual ok")

r = client.post("/api/v1/publishing/content/reject", json={"ids": [extra["id"]]})
assert r.status_code == 200
assert client.get("/api/v1/publishing/content?approval_status=rejeitado").json()[0]["id"] == extra["id"]
print("rejeição individual ok")

r = client.post("/api/v1/publishing/content/reject-all")
assert r.json() == {"rejeitados": 0}, "não deveria sobrar nada pendente para rejeitar"
print("reject-all (idempotente, nada pendente) ok")

# edição não é mais permitida após aprovação
r = client.patch(f"/api/v1/publishing/content/{aprovados[0]['id']}", json={"legenda": "novo texto"})
assert r.status_code == 409
print("bloqueio de edição pós-aprovação ok")

# ---------- agendamento automático (scheduler por janela, não sleep+post) ----------
db = SessionLocal()
for acc_id in (acc_a["id"], acc_b["id"], acc_c["id"]):
    account = db.get(Account, acc_id)
    build_schedule_for_account(db, account)
pubs = list(db.scalars(select(Publication)))
assert len(pubs) == 5, len(pubs)
print("agendamento automático criou", len(pubs), "publicações")

# ---------- execução: conta com proxy quebrado fica isolada, as outras publicam ----------
for pub in pubs:
    db.refresh(pub)
    execute_publication(db, pub)

db.expire_all()
pubs = list(db.scalars(select(Publication)))
by_account: dict[int, list[str]] = {}
for p in pubs:
    by_account.setdefault(p.account_id, []).append(p.status)

assert all(s == "PUBLISHED" for s in by_account.get(acc_a["id"], [])), by_account
assert all(s == "PUBLISHED" for s in by_account.get(acc_b["id"], [])), by_account
assert all(s == "RETRYING" for s in by_account.get(acc_c["id"], [])), by_account
print("isolamento por conta ok -> A/B publicaram, C (proxy quebrado) ficou em retry:", by_account)

conta_c = db.get(Account, acc_c["id"])
assert conta_c.ultimo_erro and "Proxy indisponível" in conta_c.ultimo_erro
print("erro do proxy registrado na conta ->", conta_c.ultimo_erro)

# ---------- retry controlado nunca vira loop infinito ----------
pub_c = next(p for p in pubs if p.account_id == acc_c["id"])
for _ in range(2):  # já tentou 1x acima; mais 2x bate o limite de 3
    execute_publication(db, pub_c)
db.refresh(pub_c)
assert pub_c.status == "FAILED", pub_c.status
assert pub_c.tentativas == 3
print("retry controlado ok -> FAILED após 3 tentativas, sem loop infinito")
db.close()

# ---------- run_cycle não quebra mesmo com uma conta em erro ----------
run_cycle()
print("run_cycle (ciclo completo do scheduler) executou sem exceção")

# ---------- stories: múltiplos por dia, cada um com várias imagens ----------
buf = io.BytesIO()
Image.new("RGB", (200, 200), (10, 10, 10)).save(buf, format="PNG")
buf.seek(0)
media_id_1 = client.post("/api/v1/media/photo", files={"file": ("story1.png", buf, "image/png")}).json()["id"]
buf2 = io.BytesIO()
Image.new("RGB", (200, 200), (20, 20, 20)).save(buf2, format="PNG")
buf2.seek(0)
media_id_2 = client.post("/api/v1/media/photo", files={"file": ("story2.png", buf2, "image/png")}).json()["id"]

r = client.put(
    f"/api/v1/publishing/accounts/{acc_a['id']}/story-config",
    json={
        "enabled": True,
        "horario": "00:00",
        "plans": [
            {"horario": "00:00", "frames": [{"media_id": media_id_1}, {"media_id": media_id_2, "texto": "Parte 2"}]},
            {"horario": "00:05", "frames": [{"media_id": media_id_2, "link": "https://exemplo.com"}]},
        ],
    },
)
assert r.status_code == 200 and r.json()["enabled"] is True
assert len(r.json()["plans"]) == 2, r.json()
assert r.json()["plans"][0]["media_ids"] == [media_id_1, media_id_2]
print("story-config com 2 plans (sequência de imagens) ok")

db = SessionLocal()
account_a = db.get(Account, acc_a["id"])
stories = ensure_daily_stories(db, account_a)
assert len(stories) == 2, f"esperava 2 stories (1 por plan), veio {len(stories)}"
assert all(s.kind == "story" for s in stories)
multi = next(s for s in stories if s.legenda and "Parte 2" in s.legenda)
medias_multi = list(db.scalars(select(ContentMedia).where(ContentMedia.content_id == multi.id)))
assert len(medias_multi) == 2, "story com 2 imagens deveria ter 2 ContentMedia"
again = ensure_daily_stories(db, account_a)
assert again == [], "não deve gerar os mesmos plans 2x no mesmo dia"
db.close()
print("stories: múltiplos por dia + múltiplas imagens por story ok")

# modo legado (1 imagem / 1 horário) continua funcionando
r = client.put(
    f"/api/v1/publishing/accounts/{acc_b['id']}/story-config",
    json={"enabled": True, "imagem_media_id": media_id_1, "texto": "Legado", "horario": "00:00"},
)
assert r.status_code == 200
db = SessionLocal()
account_b = db.get(Account, acc_b["id"])
legado = ensure_daily_stories(db, account_b)
assert len(legado) == 1 and legado[0].kind == "story"
db.close()
print("story-config legado (1 imagem/1 horário) compatível ok")

# ---------- conectar conta (autenticação real, com transporte fake injetado) ----------
# conta A já tem sessão persistida da execução acima → connect reaproveita a sessão
r = client.post(f"/api/v1/publishing/accounts/{acc_a['id']}/connect")
assert r.status_code == 200, r.text
assert r.json()["status"] == "pronta" and r.json()["session_configurada"] is True
print("connect: sessão reaproveitada ok")

# conta com proxy quebrado não pode conectar — erro isolado, sem afetar as outras
r = client.patch(f"/api/v1/publishing/accounts/{acc_c['id']}", json={"senha": "senha-c"})
assert r.status_code == 200
r = client.post(f"/api/v1/publishing/accounts/{acc_c['id']}/connect")
assert r.status_code == 400 and "Proxy indisponível" in r.text, (r.status_code, r.text)
print("connect: conta com proxy offline bloqueada com erro claro ok")

# conta sem senha nem sessão não pode conectar
r = client.post("/api/v1/publishing/accounts", json={"nome_interno": "D", "username": "perfil04", **WIDE_WINDOW})
acc_d = r.json()
r = client.post(f"/api/v1/publishing/accounts/{acc_d['id']}/connect")
assert r.status_code == 409
print("connect: sem senha/sessão → 409 ok")

r = client.post(f"/api/v1/publishing/accounts/{acc_a['id']}/verify-session")
assert r.status_code == 200 and r.json()["valida"] is True
print("verify-session ok")

# ---------- tendências: coleta de fonte externa (fonte fake injetada) ----------
class FakeTrendingSource:
    name = "fake"

    def fetch(self, *, platform: str, limit: int):
        from app.publishing.core.audio import TrendingTrack

        return [TrendingTrack(nome="Som do Momento", artista="Artista", external_id="ext-1", referencia="ref-1", popularidade=1)]


import app.publishing.core.audio as audio_mod  # noqa: E402

original_source_for = audio_mod.source_for
audio_mod.source_for = lambda name=None: FakeTrendingSource()
try:
    r = client.post("/api/v1/publishing/audio/collect")
    assert r.status_code == 200, r.text
    coletados = r.json()
    assert len(coletados) == 1 and coletados[0]["provider"] == "trending"
    assert coletados[0]["external_id"] == "ext-1"
    print("coleta de áudios em alta (fonte externa) ok")
finally:
    audio_mod.source_for = original_source_for

# ---------- calendário: reagendar publicação (persiste e vira horário real) ----------
pubs_pending = client.get("/api/v1/publishing/publications", params={"status": "PENDING"}).json()
assert pubs_pending, "deveria haver publicações pendentes (stories do dia)"
alvo = "2099-01-01T12:00:00"
r = client.patch(
    f"/api/v1/publishing/publications/{pubs_pending[0]['id']}/reschedule", json={"scheduled_at": alvo}
)
assert r.status_code == 200 and r.json()["scheduled_at"].startswith("2099-01-01T12:00")
calendario = client.get(
    "/api/v1/publishing/calendar", params={"start": "2099-01-01T00:00:00", "end": "2099-01-02T00:00:00"}
).json()
assert any(i["publication_id"] == pubs_pending[0]["id"] for i in calendario), "item reagendado deve aparecer no calendário"
print("calendário: reagendamento persistido e visível ok")

# ---------- dashboard e logs ----------
dash = client.get("/api/v1/publishing/dashboard").json()
print("dashboard ->", dash)
assert dash["publicados_hoje"] >= 3
assert dash["contas_total"] == 4  # A, B, C, D
assert dash["proxies_total"] == 2
assert dash["proxies_inativos"] == 2  # nenhum proxy respondeu de verdade aqui
assert dash["sessoes_validas"] >= 2
assert dash["sessoes_expiradas"] >= 1
assert isinstance(dash["retries"], int) and isinstance(dash["em_execucao"], int)
assert isinstance(dash["ultimos_erros"], list) and any("proxy" in e["erro"].lower() for e in dash["ultimos_erros"])
print("dashboard expandido (sessões/execução/retries/erros por conta) ok")

logs = client.get("/api/v1/publishing/logs").json()
assert len(logs) > 0
assert any("confirmada" in log_["mensagem"].lower() for log_ in logs)
print("logs de auditoria ok ->", len(logs), "entradas")

print(">>> PUBLICAÇÃO (multicontas) OK")
