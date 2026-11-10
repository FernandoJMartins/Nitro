"""Testes do SaaS: admins, acesso por assinatura, limites por plano, retenção e webhook.
SQLite temporário, sem Stripe real.  Rodar:  python test_billing.py
"""
import os
import shutil
from datetime import datetime, timedelta, timezone

os.environ["DATABASE_URL"] = "sqlite:///./_smoke_billing.db"
os.environ["STORAGE_DIR"] = "./_smoke_billing_storage"
os.environ["STRIPE_SECRET_KEY"] = ""
for p in ("_smoke_billing.db",):
    if os.path.exists(p):
        os.remove(p)
shutil.rmtree("_smoke_billing_storage", ignore_errors=True)

from fastapi import HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.billing import limits  # noqa: E402
from app.billing.retention import purge_expired_videos  # noqa: E402
from app.config import settings  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402
from app.models import GeneratedVideo, Job, User  # noqa: E402
from app.publishing.core.stories import ensure_daily_stories  # noqa: E402
from app.publishing.models import Account, Content, Publication, StoryConfig, StoryFrame, StoryPlan  # noqa: E402
from app.models import Media  # noqa: E402
from app.routers.billing import _apply_subscription  # noqa: E402

c = TestClient(app)


def reg(email):
    tok = c.post("/api/v1/auth/register", json={"email": email, "senha": "segredo1"}).json()["access_token"]
    return {"Authorization": f"Bearer {tok}"}


now = datetime.now(timezone.utc)

# ---------- admin ----------
A = reg("julio8martins@gmail.com")
me = c.get("/api/v1/auth/me", headers=A).json()
assert me["is_admin"] and me["tem_acesso"], me
assert c.get("/api/v1/media?tipo=photo", headers=A).status_code == 200
assert c.get("/api/v1/admin/users", headers=A).status_code == 200
print("admin: acesso total ok")

# ---------- usuário comum sem plano ----------
U = reg("cliente@t.com")
me = c.get("/api/v1/auth/me", headers=U).json()
assert not me["is_admin"] and not me["tem_acesso"]
assert c.get("/api/v1/media?tipo=photo", headers=U).status_code == 402
assert c.get("/api/v1/billing/plans", headers=U).status_code == 200
assert c.get("/api/v1/billing/me", headers=U).status_code == 200
assert c.post("/api/v1/billing/checkout", json={"plano": "basico"}, headers=U).status_code == 503  # sem Stripe
assert c.get("/api/v1/admin/users", headers=U).status_code == 403
print("sem plano: bloqueado (402), tela de planos acessível ok")

uid = me["id"]
r = c.patch(f"/api/v1/admin/users/{uid}", json={"plano": "basico", "dias_acesso_manual": 30}, headers=A)
assert r.status_code == 200 and r.json()["tem_acesso"], r.text
assert c.get("/api/v1/media?tipo=photo", headers=U).status_code == 200
print("admin concedeu Básico manual -> acesso ok")

# ---------- contas conectadas (limite do Básico) ----------
from app.billing.plans import PLANS  # noqa: E402
N_BASICO = PLANS["basico"].max_contas
for i in range(N_BASICO):
    assert c.post("/api/v1/publishing/accounts", json={"nome_interno": f"c{i}", "username": f"u{i}"}, headers=U).status_code == 200
r = c.post("/api/v1/publishing/accounts", json={"nome_interno": "cx", "username": "ux"}, headers=U)
assert r.status_code == 402, r.text
print("limite de perfis ok:", r.json()["detail"])

# ---------- geração em massa ----------
r = c.post("/api/v1/videos/bulk", json={"quantidade": 51, "base_media_ids": [999]}, headers=U)
assert r.status_code == 402, r.text
r = c.post("/api/v1/videos/bulk", json={"quantidade": 50, "base_media_ids": [999]}, headers=U)
assert r.status_code == 404, r.text  # passou do limite, parou na mídia inexistente
r = c.post("/api/v1/videos/bulk", json={"quantidade": 5, "base_media_ids": [999], "use_ia_texto": True}, headers=U)
assert r.status_code == 402 and "IA" in r.json()["detail"], r.text
db = SessionLocal()
db.add(Job(user_id=uid, status="concluido", total=PLANS["basico"].videos_por_mes - 10, concluidos=PLANS["basico"].videos_por_mes - 10))
db.add(Job(user_id=uid, status="concluido", total=50, concluidos=50, criado_em=now - timedelta(days=40)))  # mês passado
db.commit()
r = c.post("/api/v1/videos/bulk", json={"quantidade": 11, "base_media_ids": [999]}, headers=U)
assert r.status_code == 402 and "mensal" in r.json()["detail"], r.text
r = c.post("/api/v1/videos/bulk", json={"quantidade": 10, "base_media_ids": [999]}, headers=U)
assert r.status_code == 404, r.text
print(f"lote (50), cota mensal ({PLANS['basico'].videos_por_mes}) e IA bloqueada no Básico ok")

# ---------- calendário (limite do Básico) ----------
for i in range(PLANS["basico"].max_calendario - 1):
    db.add(Content(user_id=uid, kind="reel", caminho=f"x{i}.mp4", approval_status="aprovado"))
gv1 = GeneratedVideo(user_id=uid, caminho="generated/a.mp4")
gv2 = GeneratedVideo(user_id=uid, caminho="generated/b.mp4")
db.add_all([gv1, gv2])
db.commit()
r = c.post("/api/v1/publishing/content", json={"generated_video_ids": [gv1.id, gv2.id], "auto_distribute": False}, headers=U)
assert r.status_code == 402, r.text
r = c.post("/api/v1/publishing/content", json={"generated_video_ids": [gv1.id], "auto_distribute": False}, headers=U)
assert r.status_code == 200, r.text
print("limite do calendário ok")

# ---------- stories por dia por conta (Básico = 5) ----------
acc = db.query(Account).filter(Account.user_id == uid).order_by(Account.id).first()
acc.status = "pronta"
db.commit()
acc2 = db.query(Account).filter(Account.user_id == uid).order_by(Account.id.desc()).first()
assert acc2.id != acc.id
for i in range(5):
    alvo = acc if i < 3 else acc2  # 3 numa conta + 2 na outra = 5 da assinatura
    ct = Content(user_id=uid, kind="story", caminho="s.jpg", account_id=alvo.id, approval_status="aprovado")
    db.add(ct)
    db.flush()
    db.add(Publication(content_id=ct.id, account_id=alvo.id, status="PUBLISHED", scheduled_at=now))
db.commit()
assert limits.stories_restantes_hoje(db, acc) == 0 and limits.stories_restantes_hoje(db, acc2) == 0
try:
    limits.check_story(db, acc)
    raise AssertionError("deveria bloquear")
except HTTPException as e:
    assert e.status_code == 402
m = Media(user_id=uid, tipo="photo", caminho="photo/s.jpg", nome_original="s.jpg")
db.add(m)
cfg = StoryConfig(account_id=acc.id, enabled=True)
db.add(cfg)
db.flush()
plan = StoryPlan(story_config_id=cfg.id, horario="23:59")
db.add(plan)
db.flush()
db.add(StoryFrame(story_plan_id=plan.id, media_id=m.id))
acc.stories_enabled = True
db.commit()
assert ensure_daily_stories(db, acc) == []
print("limite de stories/dia por assinatura ok (somando contas; manual e automático)")

# upgrade para Pro via "webhook" -> stories liberam
_apply_subscription(db, {
    "id": "sub_1", "customer": "cus_1", "status": "active", "metadata": {"user_id": str(uid), "plano": "pro"},
    "items": {"data": [{"price": {"id": "price_x"}, "current_period_end": int((now + timedelta(days=30)).timestamp())}]},
})
db.expire_all()
u = db.get(User, uid)
assert u.plano == "pro" and u.assinatura_status == "active" and u.periodo_fim
assert len(ensure_daily_stories(db, acc)) == 1
print("webhook de assinatura (upgrade Pro) ok")

# ---------- downgrade: scheduler só opera as N contas mais antigas ----------
c.post("/api/v1/publishing/accounts", json={"nome_interno": "cx", "username": "ux"}, headers=U)
ids = [a.id for a in db.query(Account).filter(Account.user_id == uid).order_by(Account.id)]
assert len(ids) == N_BASICO + 1
assert set(ids) <= limits.allowed_account_ids(db)
_apply_subscription(db, {"id": "sub_1", "customer": "cus_1", "status": "active",
                         "metadata": {"user_id": str(uid), "plano": "basico"}, "items": {"data": []}})
u.acesso_manual_ate = None
db.commit()
db.expire_all()
perm = limits.allowed_account_ids(db)
assert set(ids[:N_BASICO]) <= perm and ids[N_BASICO] not in perm
_apply_subscription(db, {"id": "sub_1", "customer": "cus_1", "status": "canceled",
                         "metadata": {"user_id": str(uid)}, "items": {"data": []}})
db.expire_all()
assert not (set(ids) & limits.allowed_account_ids(db))
assert c.get("/api/v1/media?tipo=photo", headers=U).status_code == 402
print("downgrade/cancelamento -> scheduler e acesso bloqueados ok")

# ---------- retenção (não agendados: 3 dias) ----------
st = settings.storage_path
(st / "generated").mkdir(parents=True, exist_ok=True)
admin_id = c.get("/api/v1/auth/me", headers=A).json()["id"]
velho = now - timedelta(days=31)
vs = {
    "velho": GeneratedVideo(user_id=uid, caminho="generated/velho.mp4", criado_em=velho),
    "novo": GeneratedVideo(user_id=uid, caminho="generated/novo.mp4", criado_em=now - timedelta(days=1)),
    "agendado": GeneratedVideo(user_id=uid, caminho="generated/agendado.mp4", criado_em=velho),
    "admin": GeneratedVideo(user_id=admin_id, caminho="generated/admin.mp4", criado_em=velho),
}
for v in vs.values():
    (st / v.caminho).write_bytes(b"x")
    db.add(v)
db.flush()
ct = Content(user_id=uid, kind="reel", caminho="generated/agendado.mp4", account_id=ids[0], approval_status="aprovado")
db.add(ct)
db.flush()
db.add(Publication(content_id=ct.id, account_id=ids[0], status="PENDING", scheduled_at=now + timedelta(days=1)))
db.commit()
ids_v = {k: v.id for k, v in vs.items()}
purge_expired_videos(db)
db.expire_all()
assert db.get(GeneratedVideo, ids_v["velho"]) is None and not (st / "generated/velho.mp4").exists()
assert db.get(GeneratedVideo, ids_v["novo"]) is not None
assert db.get(GeneratedVideo, ids_v["agendado"]) is not None and (st / "generated/agendado.mp4").exists()
assert db.get(GeneratedVideo, ids_v["admin"]) is None  # retenção vale para todos
print("retenção 3 dias ok (preserva agendados, inclui admins)")

# ---------- apaga o vídeo gerado assim que a postagem é confirmada ----------
from app.billing.retention import delete_after_publish  # noqa: E402

def _gerado_publicado(nome, outra_pendente=False):
    gv = GeneratedVideo(user_id=uid, caminho=f"generated/{nome}.mp4", criado_em=now)
    (st / gv.caminho).write_bytes(b"x")
    db.add(gv)
    db.flush()
    cont = Content(user_id=uid, kind="reel", caminho=gv.caminho, generated_video_id=gv.id,
                   account_id=ids[0], approval_status="aprovado")
    db.add(cont)
    db.flush()
    db.add(Publication(content_id=cont.id, account_id=ids[0], status="PUBLISHED", scheduled_at=now))
    if outra_pendente:
        db.add(Publication(content_id=cont.id, account_id=ids[1], status="PENDING", scheduled_at=now + timedelta(hours=2)))
    db.commit()
    return gv.id, cont

gid, cont = _gerado_publicado("postado")
assert delete_after_publish(db, cont) is True
db.expire_all()
assert db.get(GeneratedVideo, gid) is None and not (st / "generated/postado.mp4").exists()
gid2, cont2 = _gerado_publicado("postado2", outra_pendente=True)
assert delete_after_publish(db, cont2) is False  # ainda agendado em outro perfil
assert db.get(GeneratedVideo, gid2) is not None and (st / "generated/postado2.mp4").exists()
print("apaga vídeo após publicar ok (preserva se ainda agendado em outro perfil)")

# ---------- bloqueio pelo admin ----------
u = db.get(User, uid)
u.assinatura_status = "active"
db.commit()
assert c.get("/api/v1/media?tipo=photo", headers=U).status_code == 200
c.patch(f"/api/v1/admin/users/{uid}", json={"bloqueado": True}, headers=A)
assert c.get("/api/v1/media?tipo=photo", headers=U).status_code == 402
assert c.patch(f"/api/v1/admin/users/{admin_id}", json={"bloqueado": True}, headers=A).status_code == 400
print("bloqueio pelo admin ok")

# ---------- painel de monitoramento (admin) ----------
r = c.get("/api/v1/admin/system", headers=A)
assert r.status_code == 200, r.text
st = r.json()
for k in ("servidor", "banco", "agendador", "publicacoes", "negocio", "alertas", "retencao"):
    assert k in st, k
assert st["banco"]["ok"] and st["servidor"]["disco"]["total"] > 0
assert st["negocio"]["usuarios"] >= 1
assert c.get("/api/v1/admin/system", headers=U).status_code == 403
print("painel do sistema ok:", {k: st["servidor"][k]["nivel"] for k in ("disco", "memoria", "cpu")})

# ---------- mídias: 50 MB por arquivo, quantidade e espaço por plano ----------
import dataclasses  # noqa: E402
import io  # noqa: E402
from pathlib import Path  # noqa: E402

from PIL import Image  # noqa: E402

from app.billing import plans as plans_mod  # noqa: E402

M = reg("midias@t.com")
mid = c.get("/api/v1/auth/me", headers=M).json()["id"]
c.patch(f"/api/v1/admin/users/{mid}", json={"plano": "basico", "dias_acesso_manual": 30}, headers=A)


def jpg():
    b = io.BytesIO()
    Image.new("RGB", (64, 64), (200, 10, 10)).save(b, format="JPEG")
    b.seek(0)
    return b


grande = io.BytesIO(b"\xff" * (51 * 1024 * 1024))
r = c.post("/api/v1/media/photo", files={"file": ("grande.jpg", grande, "image/jpeg")}, headers=M)
assert r.status_code == 413, r.text
assert not list((settings.storage_path / "_tmp").glob("*"))  # parcial apagado
original = plans_mod.PLANS["basico"]
plans_mod.PLANS["basico"] = dataclasses.replace(original, max_midias=2)
for _ in range(2):
    assert c.post("/api/v1/media/photo", files={"file": ("a.jpg", jpg(), "image/jpeg")}, headers=M).status_code == 200
r = c.post("/api/v1/media/photo", files={"file": ("a.jpg", jpg(), "image/jpeg")}, headers=M)
assert r.status_code == 402 and "mídias" in r.json()["detail"], r.text
plans_mod.PLANS["basico"] = dataclasses.replace(original, armazenamento_gb=0.000001)  # ~1 KB
r = c.post("/api/v1/media/photo", files={"file": ("a.jpg", jpg(), "image/jpeg")}, headers=M)
assert r.status_code == 402 and "Espaço" in r.json()["detail"], r.text
plans_mod.PLANS["basico"] = original
me_b = c.get("/api/v1/billing/me", headers=M).json()
assert me_b["uso"]["midias"] == 2 and me_b["uso"]["armazenamento_bytes"] > 0
print("mídias: 50 MB por arquivo, quantidade e espaço do plano ok")

# ---------- vídeo gerado nunca passa de 60s ----------
from app.services import video as video_mod  # noqa: E402
from app.services.metadata import probe_duration  # noqa: E402

base = settings.storage_path / "_base.jpg"
Image.new("RGB", (108, 192), (0, 0, 0)).save(base)
out = settings.storage_path / "_longo.mp4"
video_mod.build_video(base, out, duration=90, width=108, height=192, fps=10)
d = probe_duration(out)
assert d is not None and d <= 60.5, d
out2 = settings.storage_path / "_longo_final.mp4"
video_mod.build_video(base, out2, duration=90, final_path=base, final_duration=5, width=108, height=192, fps=10)
d2 = probe_duration(out2)
assert d2 is not None and d2 <= 60.5, d2
print(f"vídeo limitado a 1 min ok ({d:.1f}s e {d2:.1f}s com clipe final)")

db.close()
os.remove("_smoke_billing.db")
shutil.rmtree("_smoke_billing_storage", ignore_errors=True)
print("\nTODOS OS TESTES DE BILLING PASSARAM")
