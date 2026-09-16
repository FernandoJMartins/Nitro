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
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

os.environ["DATABASE_URL"] = "sqlite:///./_smoke_pub.db"
os.environ["STORAGE_DIR"] = "./_smoke_pub_storage"

from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image  # noqa: E402
from sqlalchemy import select  # noqa: E402

from app.database import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402
from app.models import GeneratedVideo  # noqa: E402
from app.publishing.core import publications  # noqa: E402
from app.publishing.core.distribution import eligible_accounts  # noqa: E402
from app.publishing.core.publications import execute_publication  # noqa: E402
from app.publishing.core.scheduling import _aware, build_schedule_for_account  # noqa: E402
from app.publishing.core.stories import ensure_daily_stories  # noqa: E402
from app.publishing.core.workers import run_cycle  # noqa: E402
from app.publishing.models import Account, Content, ContentMedia, Publication, Proxy, StoryPlan  # noqa: E402
from app.publishing.platforms.base import PlatformAdapter, PublishContext, PublishResult, ThrottledError  # noqa: E402


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

    def login_with_sessionid(self, ctx: PublishContext) -> str | None:
        if not (ctx.sessionid or "").strip()[:1].isdigit():
            raise ValueError("sessionid inválido")
        return f"fake-sessionid:{ctx.account_username}:{uuid.uuid4().hex[:8]}"

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


class FakeThrottledAdapter(FakeInstagramAdapter):
    """Caso real de login limitado pelo Instagram (429): o adapter levanta ThrottledError."""

    def login(self, ctx: PublishContext) -> str | None:
        raise ThrottledError(
            "login: Instagram limitou as tentativas desta conta/IP (429 Too Many Requests)"
        )


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
    "/api/v1/publishing/proxies", json={"nome_interno": "proxy-b", "host": "203.0.113.10", "porta": 1080}
).json()
proxy_bad = client.post(
    "/api/v1/publishing/proxies", json={"nome_interno": "proxy-quebrado", "host": "203.0.113.254", "porta": 1}
).json()
assert proxy_ok["status"] == "cinza" and proxy_bad["status"] == "cinza"
print("proxies criados sem check automático ok")

# nome interno padrão (host:porta) quando não informado
proxy_default = client.post(
    "/api/v1/publishing/proxies", json={"host": "198.51.100.7", "porta": 4145}
).json()
assert proxy_default["nome_interno"] == "198.51.100.7:4145"

# edição de proxy: renomeia e altera conexão; senha em branco mantém a atual
r = client.patch(
    f"/api/v1/publishing/proxies/{proxy_ok['id']}",
    json={"nome_interno": "Proxy EUA", "usuario": "u1", "senha": "s1"},
)
assert r.status_code == 200 and r.json()["nome_interno"] == "Proxy EUA"
r = client.patch(f"/api/v1/publishing/proxies/{proxy_ok['id']}", json={"host": "203.0.113.11"})
assert r.status_code == 200 and r.json()["host"] == "203.0.113.11" and r.json()["nome_interno"] == "Proxy EUA"
db = SessionLocal()
assert db.get(Proxy, proxy_ok["id"]).senha == "s1"  # não sobrescrita pela edição sem senha
db.close()
print("edição de proxy (nome interno, campos e senha preservada) ok")

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
            {
                "horario": "00:00",
                "texto": "Título do story",
                "link": "https://exemplo.com/link",
                "link_posicao": "superior",
                "texto_extra": "Oferta só hoje!",
                "frames": [{"media_id": media_id_1}, {"media_id": media_id_2}],
            },
            {"horario": "00:05", "frames": [{"media_id": media_id_2, "link": "https://frame-link.com"}]},
        ],
    },
)
assert r.status_code == 200 and r.json()["enabled"] is True
assert len(r.json()["plans"]) == 2, r.json()
assert r.json()["plans"][0]["media_ids"] == [media_id_1, media_id_2]
assert r.json()["plans"][0]["texto"] == "Título do story"
assert r.json()["plans"][0]["link_posicao"] == "superior"
assert r.json()["plans"][0]["texto_extra"] == "Oferta só hoje!"
print("story-config com 2 plans (sequência de imagens + campos novos) ok")

db = SessionLocal()
account_a = db.get(Account, acc_a["id"])
stories = ensure_daily_stories(db, account_a)
assert len(stories) == 2, f"esperava 2 stories (1 por plan), veio {len(stories)}"
assert all(s.kind == "story" for s in stories)
story1 = next(s for s in stories if s.legenda == "Título do story")
assert story1.link == "https://exemplo.com/link"
assert story1.link_posicao == "superior"
assert story1.texto_extra == "Oferta só hoje!"
story2 = next(s for s in stories if s.link == "https://frame-link.com")
assert story2.link_posicao is None and story2.texto_extra is None
medias_multi = list(db.scalars(select(ContentMedia).where(ContentMedia.content_id == story1.id)))
assert len(medias_multi) == 2, "story com 2 imagens deveria ter 2 ContentMedia"
again = ensure_daily_stories(db, account_a)
assert again == [], "não deve gerar os mesmos plans 2x no mesmo dia"
db.close()
print("stories: múltiplos por dia + múltiplas imagens + posição do link + texto extra ok")

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

# ---------- postar agora (botão da lista de stories) ----------
plan_id = client.get(f"/api/v1/publishing/accounts/{acc_a['id']}/story-config").json()["plans"][0]["id"]
r = client.post(f"/api/v1/publishing/accounts/{acc_a['id']}/stories/{plan_id}/post-now")
assert r.status_code == 200, r.text
dados = r.json()
assert dados["status"] == "PUBLISHED", dados
assert dados["legenda"] == "Título do story"
assert dados["link"] == "https://exemplo.com/link"
print("post-now: story do modelo publicado na hora ok")

# conta B: plano novo → marcador começa vazio e o post-now marca como gerado hoje
r = client.put(
    f"/api/v1/publishing/accounts/{acc_b['id']}/story-config",
    json={
        "enabled": True,
        "plans": [
            {"horario": "23:59", "texto": "Agora!", "link": "https://b.com", "frames": [{"media_id": media_id_1}]}
        ],
    },
)
assert r.status_code == 200, r.text
plan_b_id = r.json()["plans"][0]["id"]
db = SessionLocal()
assert db.get(StoryPlan, plan_b_id).ultima_geracao_em is None
db.close()
r = client.post(f"/api/v1/publishing/accounts/{acc_b['id']}/stories/{plan_b_id}/post-now")
assert r.status_code == 200 and r.json()["status"] == "PUBLISHED", r.text
db = SessionLocal()
assert db.get(StoryPlan, plan_b_id).ultima_geracao_em is not None, "post-now deve marcar o plano como gerado hoje"
db.close()
# modelo de outra conta / inexistente → 404
r = client.post(f"/api/v1/publishing/accounts/{acc_a['id']}/stories/{plan_b_id}/post-now")
assert r.status_code == 404
print("post-now: marca o plano como gerado hoje e valida posse do modelo ok")

# conta sem senha nem sessão não pode conectar
r = client.post("/api/v1/publishing/accounts", json={"nome_interno": "D", "username": "perfil04", **WIDE_WINDOW})
acc_d = r.json()
r = client.post(f"/api/v1/publishing/accounts/{acc_d['id']}/connect")
assert r.status_code == 409
print("connect: sem senha/sessão → 409 ok")

# login limitado pelo Instagram (429) → HTTP 429 com a mensagem real (não 400 genérico)
r = client.patch(f"/api/v1/publishing/accounts/{acc_d['id']}", json={"senha": "senha-d"})
assert r.status_code == 200, r.text
publications.ADAPTERS["instagram"] = FakeThrottledAdapter
try:
    r = client.post(f"/api/v1/publishing/accounts/{acc_d['id']}/connect")
    assert r.status_code == 429 and "429" in r.text, (r.status_code, r.text)
finally:
    publications.ADAPTERS["instagram"] = FakeInstagramAdapter
print("connect: throttle 429 com mensagem clara ok")

# cookie de sessão (sessionid) conecta sem senha — contorna o fluxo de login
r = client.post(
    "/api/v1/publishing/accounts",
    json={"nome_interno": "E", "username": "perfil05", "sessionid": "1234567890%3Aabcdef1234567890abcdef", **WIDE_WINDOW},
)
acc_e = r.json()
assert acc_e["sessionid_configurada"] is True
r = client.post(f"/api/v1/publishing/accounts/{acc_e['id']}/connect")
assert r.status_code == 200, r.text
assert r.json()["session_configurada"] is True
r = client.delete(f"/api/v1/publishing/accounts/{acc_e['id']}")
assert r.status_code == 204
print("connect: sessionid (cookie) contorna login e conecta ok")

r = client.post(f"/api/v1/publishing/accounts/{acc_a['id']}/verify-session")
assert r.status_code == 200 and r.json()["valida"] is True
print("verify-session ok")

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
assert dash["proxies_total"] == 3
assert dash["proxies_inativos"] == 3  # nenhum proxy respondeu de verdade aqui
assert dash["sessoes_validas"] >= 2
assert dash["sessoes_expiradas"] >= 1
assert isinstance(dash["retries"], int) and isinstance(dash["em_execucao"], int)
assert isinstance(dash["ultimos_erros"], list) and any("proxy" in e["erro"].lower() for e in dash["ultimos_erros"])
print("dashboard expandido (sessões/execução/retries/erros por conta) ok")

logs = client.get("/api/v1/publishing/logs").json()
assert len(logs) > 0
assert any("confirmada" in log_["mensagem"].lower() for log_ in logs)
print("logs de auditoria ok ->", len(logs), "entradas")

# ---------- ativar/desativar conta: bloqueia distribuição, agendamento, stories e execução ----------
r = client.post(
    "/api/v1/publishing/accounts", json={"nome_interno": "Perfil F", "username": "perfil06", **WIDE_WINDOW}
)
acc_f = r.json()
assert r.status_code == 200 and acc_f["ativa"] is True, "conta nova nasce ativa"
r = client.post(f"/api/v1/publishing/accounts/{acc_f['id']}/ready")
assert r.status_code == 200

# story-config da conta F (1 plan) para validar o bloqueio de stories
r = client.put(
    f"/api/v1/publishing/accounts/{acc_f['id']}/story-config",
    json={"enabled": True, "plans": [{"horario": "00:00", "texto": "Story da F", "frames": [{"media_id": media_id_1}]}]},
)
assert r.status_code == 200, r.text
plan_f_id = r.json()["plans"][0]["id"]

# desativa a conta via PATCH (mesmo caminho do botão na UI)
r = client.patch(f"/api/v1/publishing/accounts/{acc_f['id']}", json={"ativa": False})
assert r.status_code == 200 and r.json()["ativa"] is False
print("conta desativada via API ok")

db = SessionLocal()
conta_f = db.get(Account, acc_f["id"])
assert conta_f.ativa is False

# distribuição ignora conta desativada
assert acc_f["id"] not in {a.id for a in eligible_accounts(db, USER_ID)}

# conteúdo aprovado atribuído à conta desativada não é agendado nem gera stories
gv_f = GeneratedVideo(user_id=USER_ID, caminho="generated/fake_f.mp4", duracao=8.0)
db.add(gv_f)
db.flush()
content_f = Content(
    user_id=USER_ID,
    kind="reel",
    origem="gerador",
    generated_video_id=gv_f.id,
    caminho=gv_f.caminho,
    duracao=8.0,
    account_id=acc_f["id"],
    approval_status="aprovado",
)
db.add(content_f)
db.commit()
db.refresh(content_f)
assert build_schedule_for_account(db, conta_f) == [], "conta desativada não deveria criar agendamento"
assert ensure_daily_stories(db, conta_f) == [], "conta desativada não deveria gerar stories"

# execução direta recusa a conta desativada (garantia dura do núcleo)
pub_f = Publication(
    content_id=content_f.id, account_id=acc_f["id"], status="PENDING", scheduled_at=datetime.now(timezone.utc)
)
db.add(pub_f)
db.commit()
db.refresh(pub_f)
try:
    execute_publication(db, pub_f)
    raise AssertionError("conta desativada não deveria executar publicação")
except ValueError as exc:
    assert "desativada" in str(exc)
db.close()
print("conta desativada: sem distribuição, sem agendamento, sem stories e sem execução ok")

# endpoints de postar agora / agendar manual recusam conta desativada (409)
r = client.post(f"/api/v1/publishing/accounts/{acc_f['id']}/stories/{plan_f_id}/post-now")
assert r.status_code == 409 and "desativada" in r.text, (r.status_code, r.text)
r = client.post(f"/api/v1/publishing/content/{content_f.id}/schedule", json={"scheduled_at": "2099-01-02T12:00:00"})
assert r.status_code == 409 and "desativada" in r.text, (r.status_code, r.text)
print("postar agora / agendar manual recusam conta desativada (409) ok")

# dashboard não conta a conta desativada como ativa
dash = client.get("/api/v1/publishing/dashboard").json()
assert dash["contas_total"] == 5, dash
assert dash["contas_ativas"] == 2, dash  # A e B apenas (C pausada, D em erro, F desativada)
print("dashboard não conta a conta desativada como ativa ok")

# reativa a conta e tudo volta a funcionar
r = client.patch(f"/api/v1/publishing/accounts/{acc_f['id']}", json={"ativa": True})
assert r.status_code == 200 and r.json()["ativa"] is True
db = SessionLocal()
conta_f = db.get(Account, acc_f["id"])
gv_f2 = GeneratedVideo(user_id=USER_ID, caminho="generated/fake_f2.mp4", duracao=8.0)
db.add(gv_f2)
db.flush()
content_f2 = Content(
    user_id=USER_ID,
    kind="reel",
    origem="gerador",
    generated_video_id=gv_f2.id,
    caminho=gv_f2.caminho,
    duracao=8.0,
    account_id=acc_f["id"],
    approval_status="aprovado",
)
db.add(content_f2)
db.commit()
db.refresh(content_f2)
criadas = build_schedule_for_account(db, conta_f)
existentes_f2 = list(
    db.scalars(
        select(Publication).where(Publication.content_id == content_f2.id, Publication.account_id == acc_f["id"])
    )
)
assert any(p.content_id == content_f2.id for p in criadas) or existentes_f2, "conta reativada deve agendar conteúdo novo"
# stories voltam a ser gerados (ou o worker já gerou em segundo plano)
if ensure_daily_stories(db, conta_f) == []:
    plan_f = db.get(StoryPlan, plan_f_id)
    assert plan_f.ultima_geracao_em is not None, "story do plano deveria ter sido gerado após reativar"
db.close()
dash = client.get("/api/v1/publishing/dashboard").json()
assert dash["contas_ativas"] == 3, dash
print("conta reativada: agendamento, stories e dashboard voltam a funcionar ok")

# ---------- agendamento manual (aprovação): reagenda a mesma publicação, nunca duplica ----------
db = SessionLocal()
gv_m = GeneratedVideo(user_id=USER_ID, caminho="generated/fake_manual.mp4", duracao=7.0)
db.add(gv_m)
db.flush()
content_m = Content(
    user_id=USER_ID,
    kind="reel",
    origem="gerador",
    generated_video_id=gv_m.id,
    caminho=gv_m.caminho,
    duracao=7.0,
    account_id=acc_b["id"],
    approval_status="aprovado",
)
db.add(content_m)
db.commit()
db.refresh(content_m)
db.close()

# 1º agendamento cria a publicação
r = client.post(f"/api/v1/publishing/content/{content_m.id}/schedule", json={"scheduled_at": "2099-03-01T10:00:00"})
assert r.status_code == 200, r.text
pub1 = r.json()
assert pub1["status"] == "PENDING" and pub1["scheduled_at"].startswith("2099-03-01T10:00")
db = SessionLocal()
assert db.get(Content, content_m.id).schedule_mode == "especifico"
db.close()

# 2º agendamento reagenda a MESMA publicação (nunca cria uma segunda)
r = client.post(f"/api/v1/publishing/content/{content_m.id}/schedule", json={"scheduled_at": "2099-03-02T15:30:00"})
assert r.status_code == 200, r.text
pub2 = r.json()
assert pub2["id"] == pub1["id"], "reagendar deve reusar a publicação existente"
assert pub2["scheduled_at"].startswith("2099-03-02T15:30")
db = SessionLocal()
assert len(list(db.scalars(select(Publication).where(Publication.content_id == content_m.id)))) == 1, "nunca duplicar"
db.close()
print("agendamento manual: reagenda a mesma publicação sem duplicar ok")

# conteúdo sem conta atribuída não pode ser agendado (409 claro)
db = SessionLocal()
gv_m2 = GeneratedVideo(user_id=USER_ID, caminho="generated/fake_manual2.mp4", duracao=7.0)
db.add(gv_m2)
db.flush()
content_sem = Content(
    user_id=USER_ID,
    kind="reel",
    origem="gerador",
    generated_video_id=gv_m2.id,
    caminho=gv_m2.caminho,
    duracao=7.0,
    account_id=None,
    approval_status="aprovado",
)
db.add(content_sem)
db.commit()
db.refresh(content_sem)
db.close()
r = client.post(f"/api/v1/publishing/content/{content_sem.id}/schedule", json={"scheduled_at": "2099-03-03T10:00:00"})
assert r.status_code == 409 and "sem conta" in r.text, (r.status_code, r.text)
print("agendamento manual sem conta destinada → 409 claro ok")

# ---------- cadência "X posts a cada Y horas" (conta e padrão global) ----------
AGORA_FIXO = datetime(2099, 5, 1, 12, 0, tzinfo=timezone.utc)

# conta G: 2 posts a cada 3 horas → espaço médio de ~1h30 entre publicações
r = client.post(
    "/api/v1/publishing/accounts",
    json={
        "nome_interno": "Perfil G",
        "username": "perfil07",
        "posts_por_ciclo": 2,
        "horas_por_ciclo": 3.0,
        **WIDE_WINDOW,
    },
)
acc_g = r.json()
assert r.status_code == 200 and acc_g["posts_por_ciclo"] == 2 and acc_g["horas_por_ciclo"] == 3.0
r = client.post(f"/api/v1/publishing/accounts/{acc_g['id']}/ready")
assert r.status_code == 200

db = SessionLocal()
conta_g = db.get(Account, acc_g["id"])
for i in range(3):
    gv_g = GeneratedVideo(user_id=USER_ID, caminho=f"generated/fake_g{i}.mp4", duracao=8.0)
    db.add(gv_g)
    db.flush()
    db.add(
        Content(
            user_id=USER_ID,
            kind="reel",
            origem="gerador",
            generated_video_id=gv_g.id,
            caminho=gv_g.caminho,
            duracao=8.0,
            account_id=acc_g["id"],
            approval_status="aprovado",
        )
    )
db.commit()
pubs_g = build_schedule_for_account(db, conta_g, now=AGORA_FIXO)
assert len(pubs_g) == 3, len(pubs_g)
tempos_g = sorted(_aware(p.scheduled_at) for p in pubs_g)
gaps_g = [(tempos_g[i + 1] - tempos_g[i]).total_seconds() for i in range(len(tempos_g) - 1)]
assert all(g >= 1.5 * 3600 - 200 for g in gaps_g), f"cadência 2 a cada 3h deveria dar ~1h30 entre posts: {gaps_g}"
db.close()
print("cadência da conta (2 a cada 3h): espaçamento ~1h30 entre posts ok ->", gaps_g)

# cadência global: conta H sem override usa o padrão do usuário (3 a cada 6h → ~2h entre posts)
r = client.put(
    "/api/v1/publishing/defaults",
    json={
        "posts_por_hora": 4,
        "janela_inicio": "00:00",
        "janela_fim": "23:59",
        "timezone": "America/Sao_Paulo",
        "posts_por_ciclo": 3,
        "horas_por_ciclo": 6.0,
    },
)
assert r.status_code == 200 and r.json()["posts_por_ciclo"] == 3
r = client.post("/api/v1/publishing/accounts", json={"nome_interno": "Perfil H", "username": "perfil08", **WIDE_WINDOW})
acc_h = r.json()
r = client.post(f"/api/v1/publishing/accounts/{acc_h['id']}/ready")
assert r.status_code == 200
db = SessionLocal()
conta_h = db.get(Account, acc_h["id"])
for i in range(3):
    gv_h = GeneratedVideo(user_id=USER_ID, caminho=f"generated/fake_h{i}.mp4", duracao=8.0)
    db.add(gv_h)
    db.flush()
    db.add(
        Content(
            user_id=USER_ID,
            kind="reel",
            origem="gerador",
            generated_video_id=gv_h.id,
            caminho=gv_h.caminho,
            duracao=8.0,
            account_id=acc_h["id"],
            approval_status="aprovado",
        )
    )
db.commit()
pubs_h = build_schedule_for_account(db, conta_h, now=AGORA_FIXO)
assert len(pubs_h) == 3, len(pubs_h)
tempos_h = sorted(_aware(p.scheduled_at) for p in pubs_h)
gaps_h = [(tempos_h[i + 1] - tempos_h[i]).total_seconds() for i in range(len(tempos_h) - 1)]
assert all(g >= 2 * 3600 - 200 for g in gaps_h), f"cadência global 3 a cada 6h deveria dar ~2h entre posts: {gaps_h}"
# devolve o padrão global para não afetar nada depois
r = client.put(
    "/api/v1/publishing/defaults",
    json={
        "posts_por_hora": 4,
        "janela_inicio": "00:00",
        "janela_fim": "23:59",
        "timezone": "America/Sao_Paulo",
        "posts_por_ciclo": 0,
        "horas_por_ciclo": 0.0,
    },
)
assert r.status_code == 200
db.close()
print("cadência global (padrão do usuário) respeitada pela conta sem override ok")

# ---------- horários selecionados: agendar só nos horários escolhidos, com offset ----------
# conta I: 3 horários fixos + cadência apertada de propósito (1 a cada 6h) — os horários
# selecionados devem ter PRIORIDADE sobre a cadência (3 posts no mesmo dia)
r = client.post(
    "/api/v1/publishing/accounts",
    json={
        "nome_interno": "Perfil I",
        "username": "perfil09",
        "horarios_selecionados": ["10:00", "11:00", "12:00"],
        "posts_por_ciclo": 1,
        "horas_por_ciclo": 6.0,
        **WIDE_WINDOW,
    },
)
acc_i = r.json()
assert r.status_code == 200 and acc_i["horarios_selecionados"] == ["10:00", "11:00", "12:00"], r.text
r = client.post(f"/api/v1/publishing/accounts/{acc_i['id']}/ready")
assert r.status_code == 200

db = SessionLocal()
conta_i = db.get(Account, acc_i["id"])
for i in range(4):
    gv_i = GeneratedVideo(user_id=USER_ID, caminho=f"generated/fake_i{i}.mp4", duracao=8.0)
    db.add(gv_i)
    db.flush()
    db.add(
        Content(
            user_id=USER_ID,
            kind="reel",
            origem="gerador",
            generated_video_id=gv_i.id,
            caminho=gv_i.caminho,
            duracao=8.0,
            account_id=acc_i["id"],
            approval_status="aprovado",
        )
    )
db.commit()
pubs_i = build_schedule_for_account(db, conta_i, now=AGORA_FIXO)
assert len(pubs_i) == 4, len(pubs_i)

tz_sp = ZoneInfo("America/Sao_Paulo")
locais_i = sorted(_aware(p.scheduled_at).astimezone(tz_sp) for p in pubs_i)
db.close()
# AGORA_FIXO = 12:00 UTC = 09:00 em SP: os 3 primeiros caem hoje em 10/11/12h (±15min de offset)
# e o 4º transborda para amanhã às 10h
minutos = lambda d: d.hour * 60 + d.minute  # noqa: E731
esperado_hoje = [(585, 615), (645, 675), (705, 735)]  # 10:00, 11:00, 12:00 ±15min
for local, (lo, hi) in zip(locais_i[:3], esperado_hoje):
    assert local.date().isoformat() == "2099-05-01" and lo <= minutos(local) <= hi, local
quarto = locais_i[3]
assert quarto.date().isoformat() == "2099-05-02" and 585 <= minutos(quarto) <= 615, quarto
print(
    "horários selecionados: 3 hoje + transbordo amanhã, com offset ±15min e prioridade sobre cadência ok ->",
    [l.strftime("%d %H:%M") for l in locais_i],
)

# horário selecionado FORA da janela configurada não gera agendamento
r = client.post(
    "/api/v1/publishing/accounts",
    json={
        "nome_interno": "Perfil J",
        "username": "perfil10",
        "horarios_selecionados": ["03:00"],
        "janela_inicio": "08:00",
        "janela_fim": "23:59",
    },
)
acc_j = r.json()
assert r.status_code == 200
r = client.post(f"/api/v1/publishing/accounts/{acc_j['id']}/ready")
assert r.status_code == 200
db = SessionLocal()
conta_j = db.get(Account, acc_j["id"])
gv_j = GeneratedVideo(user_id=USER_ID, caminho="generated/fake_j.mp4", duracao=8.0)
db.add(gv_j)
db.flush()
db.add(
    Content(
        user_id=USER_ID,
        kind="reel",
        origem="gerador",
        generated_video_id=gv_j.id,
        caminho=gv_j.caminho,
        duracao=8.0,
        account_id=acc_j["id"],
        approval_status="aprovado",
    )
)
db.commit()
assert build_schedule_for_account(db, conta_j, now=AGORA_FIXO) == [], "03:00 fora da janela 08–23:59 não deveria agendar"
db.close()
print("horário selecionado fora da janela: sem agendamento ok")

# padrão global de horários selecionados vale para contas sem override
r = client.put(
    "/api/v1/publishing/defaults",
    json={
        "posts_por_hora": 4,
        "janela_inicio": "00:00",
        "janela_fim": "23:59",
        "timezone": "America/Sao_Paulo",
        "posts_por_ciclo": 0,
        "horas_por_ciclo": 0.0,
        "horarios_selecionados": ["15:00", "16:00"],
    },
)
assert r.status_code == 200 and r.json()["horarios_selecionados"] == ["15:00", "16:00"]
r = client.post("/api/v1/publishing/accounts", json={"nome_interno": "Perfil K", "username": "perfil11", **WIDE_WINDOW})
acc_k = r.json()
r = client.post(f"/api/v1/publishing/accounts/{acc_k['id']}/ready")
assert r.status_code == 200
db = SessionLocal()
conta_k = db.get(Account, acc_k["id"])
for i in range(2):
    gv_k = GeneratedVideo(user_id=USER_ID, caminho=f"generated/fake_k{i}.mp4", duracao=8.0)
    db.add(gv_k)
    db.flush()
    db.add(
        Content(
            user_id=USER_ID,
            kind="reel",
            origem="gerador",
            generated_video_id=gv_k.id,
            caminho=gv_k.caminho,
            duracao=8.0,
            account_id=acc_k["id"],
            approval_status="aprovado",
        )
    )
db.commit()
pubs_k = build_schedule_for_account(db, conta_k, now=AGORA_FIXO)
assert len(pubs_k) == 2, len(pubs_k)
locais_k = sorted(_aware(p.scheduled_at).astimezone(tz_sp) for p in pubs_k)
esperado_k = [(885, 915), (945, 975)]  # 15:00 e 16:00 ±15min
for local, (lo, hi) in zip(locais_k, esperado_k):
    assert local.date().isoformat() == "2099-05-01" and lo <= minutos(local) <= hi, local
# devolve o padrão global para não afetar nada depois
r = client.put(
    "/api/v1/publishing/defaults",
    json={
        "posts_por_hora": 4,
        "janela_inicio": "00:00",
        "janela_fim": "23:59",
        "timezone": "America/Sao_Paulo",
        "posts_por_ciclo": 0,
        "horas_por_ciclo": 0.0,
        "horarios_selecionados": None,
    },
)
assert r.status_code == 200
db.close()
print("horários selecionados do padrão global respeitados pela conta sem override ok")

# ---------- importação com seleção manual de perfis (default: todos) ----------
acc_s1 = client.post(
    "/api/v1/publishing/accounts", json={"nome_interno": "Perfil Sel 1", "username": "perfil_sel1", **WIDE_WINDOW}
).json()
acc_s2 = client.post(
    "/api/v1/publishing/accounts", json={"nome_interno": "Perfil Sel 2", "username": "perfil_sel2", **WIDE_WINDOW}
).json()

db = SessionLocal()
gv_s = []
for i in range(3):
    g = GeneratedVideo(user_id=USER_ID, caminho=f"generated/fake_sel{i}.mp4", duracao=8.0)
    db.add(g)
    db.flush()
    gv_s.append(g.id)
db.commit()
db.close()

# subconjunto escolhido manualmente: distribuição uniforme APENAS entre os escolhidos
r = client.post(
    "/api/v1/publishing/content",
    json={"generated_video_ids": gv_s, "auto_distribute": True, "account_ids": [acc_s1["id"], acc_s2["id"]]},
)
assert r.status_code == 200, r.text
sel_contents = r.json()
assert len(sel_contents) == 3
assert all(c["account_id"] in (acc_s1["id"], acc_s2["id"]) for c in sel_contents), sel_contents
assert all(c["approval_status"] == "pendente" for c in sel_contents)
counts_sel: dict[int, int] = {}
for c in sel_contents:
    counts_sel[c["account_id"]] = counts_sel.get(c["account_id"], 0) + 1
assert max(counts_sel.values()) - min(counts_sel.values()) <= 1, counts_sel
print("importação com perfis selecionados (subconjunto uniforme, default pendente) ok ->", counts_sel)

# seleção com apenas 1 perfil: tudo vai para ele
r = client.post(
    "/api/v1/publishing/content",
    json={"generated_video_ids": [gv_s[0]], "auto_distribute": True, "account_ids": [acc_s1["id"]]},
)
assert r.status_code == 404, "vídeo já importado não pode entrar duas vezes"

db = SessionLocal()
gv_solo = GeneratedVideo(user_id=USER_ID, caminho="generated/fake_solo.mp4", duracao=8.0)
db.add(gv_solo)
db.commit()
db.refresh(gv_solo)
db.close()
r = client.post(
    "/api/v1/publishing/content",
    json={"generated_video_ids": [gv_solo.id], "auto_distribute": True, "account_ids": [acc_s1["id"]]},
)
assert r.status_code == 200 and r.json()[0]["account_id"] == acc_s1["id"], r.text
print("seleção de 1 perfil único envia tudo para ele ok")

# conta inexistente é rejeitada antes de criar conteúdo
r = client.post(
    "/api/v1/publishing/content",
    json={"generated_video_ids": gv_s, "auto_distribute": True, "account_ids": [999999]},
)
assert r.status_code == 404
print("validação de conta inexistente na seleção manual ok")

# conta desativada é rejeitada
client.patch(f"/api/v1/publishing/accounts/{acc_s2['id']}", json={"ativa": False})
db = SessionLocal()
gv_off = GeneratedVideo(user_id=USER_ID, caminho="generated/fake_off.mp4", duracao=8.0)
db.add(gv_off)
db.commit()
db.refresh(gv_off)
db.close()
r = client.post(
    "/api/v1/publishing/content",
    json={"generated_video_ids": [gv_off.id], "auto_distribute": True, "account_ids": [acc_s2["id"]]},
)
assert r.status_code == 409, r.text
print("conta desativada bloqueada na seleção manual ok")

# ---------- aprovação direta (fluxo "Criar"): importa + aprova + distribui no mesmo request ----------
client.patch(f"/api/v1/publishing/accounts/{acc_s2['id']}", json={"ativa": True})
db = SessionLocal()
gv_d1 = GeneratedVideo(user_id=USER_ID, caminho="generated/fake_d1.mp4", duracao=8.0)
gv_d2 = GeneratedVideo(user_id=USER_ID, caminho="generated/fake_d2.mp4", duracao=8.0)
db.add_all([gv_d1, gv_d2])
db.commit()
db.refresh(gv_d1)
db.refresh(gv_d2)
db.close()

r = client.post(
    "/api/v1/publishing/content",
    json={
        "generated_video_ids": [gv_d1.id, gv_d2.id],
        "auto_distribute": True,
        "account_ids": [acc_s2["id"]],
        "approve": True,
    },
)
assert r.status_code == 200, r.text
direct = r.json()
assert all(c["approval_status"] == "aprovado" for c in direct), direct
assert all(c["account_id"] == acc_s2["id"] for c in direct), direct
# nada vai para a fila de aprovação — já nasce aprovado e o scheduler agenda sozinho
db = SessionLocal()
ids_direct = {c["id"] for c in direct}
conta_s2 = db.get(Account, acc_s2["id"])
existentes = {p.content_id for p in db.scalars(select(Publication).where(Publication.content_id.in_(ids_direct)))}
novos = build_schedule_for_account(db, conta_s2)
com_pub = existentes | {p.content_id for p in novos}
assert com_pub == ids_direct, com_pub
db.close()
print("aprovação direta (import + aprovar) distribui e agenda automaticamente ok ->", len(direct), "vídeos")

print(">>> PUBLICAÇÃO (multicontas) OK")
