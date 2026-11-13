"""Vigilância: trava de login após 429, validação do @, avisos (sem spam) e
classificação de proxy. Offline: rede e Telegram simulados.  Rodar: python test_vigilancia.py
"""
import os
import shutil
from datetime import datetime, timedelta, timezone

os.environ["DATABASE_URL"] = "sqlite:///./_smoke_vig.db"
os.environ["STORAGE_DIR"] = "./_smoke_vig_storage"
for p in ("_smoke_vig.db",):
    if os.path.exists(p):
        os.remove(p)
shutil.rmtree("_smoke_vig_storage", ignore_errors=True)

from fastapi.testclient import TestClient  # noqa: E402

from app.config import settings  # noqa: E402
from app.database import SessionLocal  # noqa: E402
from app.main import app  # noqa: E402
from app.publishing.models import Account, Proxy  # noqa: E402
from app.services import ip_tipo, notifier  # noqa: E402

settings.storage_path.mkdir(parents=True, exist_ok=True)
c = TestClient(app)
ADMIN = settings.admin_emails_set and sorted(settings.admin_emails_set)[0]
tok = c.post("/api/v1/auth/register", json={"email": ADMIN, "senha": "segredo1"}).json()["access_token"]
H = {"Authorization": f"Bearer {tok}"}
uid = c.get("/api/v1/auth/me", headers=H).json()["id"]

# ---------- @ inválido é recusado; "@perfil" vira "perfil" ----------
r = c.post("/api/v1/publishing/accounts", json={"nome_interno": "x", "username": "perfil 01", "senha": "abc"}, headers=H)
assert r.status_code == 422, r.text
r = c.post("/api/v1/publishing/accounts", json={"nome_interno": "Perfil 01", "username": "@perfil_01", "senha": "abc"}, headers=H)
assert r.status_code == 200 and r.json()["username"] == "perfil_01", r.text
acc_id = r.json()["id"]
print("validação do @ ok")

# ---------- trava do Conectar por 30 min após 429 ----------
db = SessionLocal()
a = db.get(Account, acc_id)
a.ultimo_erro = "Falha ao conectar: login CAA: Instagram limitou as tentativas desta conta/IP (429 Too Many Requests)."
a.ultimo_erro_em = datetime.now(timezone.utc) - timedelta(minutes=5)
db.commit()
r = c.get("/api/v1/publishing/accounts", headers=H)
assert r.json()[0]["login_bloqueado_ate"], r.text
r = c.post(f"/api/v1/publishing/accounts/{acc_id}/connect", headers=H)
assert r.status_code == 429 and "Aguarde" in r.json()["detail"], r.text
a.ultimo_erro_em = datetime.now(timezone.utc) - timedelta(minutes=40)  # passou o prazo
db.commit()
db.expire_all()
assert db.get(Account, acc_id).login_bloqueado_ate is None
a = db.get(Account, acc_id)
a.ultimo_erro = "senha incorreta"  # erro que não é 429 não trava
a.ultimo_erro_em = datetime.now(timezone.utc)
db.commit()
db.expire_all()
assert db.get(Account, acc_id).login_bloqueado_ate is None
print("trava de 30 min após 429 ok")

# ---------- classificação de proxy (rede simulada) ----------
respostas = {
    "1.1.1.1": {"status": "success", "isp": "Vivo", "org": "Telefonica", "as": "AS27699", "mobile": False, "hosting": False},
    "2.2.2.2": {"status": "success", "isp": "Vantiva", "org": "", "as": "AS262287 Latitude.sh LTDA", "mobile": False, "hosting": False},
    "3.3.3.3": {"status": "success", "isp": "Claro", "org": "", "as": "", "mobile": True, "hosting": False},
}


class _R:
    def __init__(self, j=None, text="", ok=True):
        self._j, self.text, self.ok = j, text, ok

    def json(self):
        return self._j


def _fake_get(url, *a, **k):
    if "ip-api.com" in url:
        return _R(respostas[url.rsplit("/", 1)[-1]])
    if "ipinfo.io" in url:
        return _R(text="AS0 Provedor Residencial")
    raise AssertionError(url)


ip_tipo.requests.get, original = _fake_get, ip_tipo.requests.get
ip_tipo._cache.clear()
assert ip_tipo.classificar("1.1.1.1")["tipo"] == "residencial"
assert ip_tipo.classificar("2.2.2.2")["tipo"] == "datacenter"  # revenda de data center
assert ip_tipo.classificar("3.3.3.3")["tipo"] == "movel"
ip_tipo.requests.get = original
p = Proxy(user_id=uid, nome_interno="p", protocolo="socks5", host="h", porta=1, tipo_ip="datacenter", provedor_ip="Latitude.sh")
db.add(p)
db.commit()
pr = c.get("/api/v1/publishing/proxies", headers=H).json()[0]
assert pr["tipo_ip"] == "datacenter" and pr["provedor_ip"] == "Latitude.sh"
print("classificação de proxy ok")

# ---------- avisos: novo -> envia; repetido -> não; sumiu -> resolvido ----------
enviadas = []
settings.telegram_bot_token, settings.telegram_chat_id = "t", "c"
notifier.enviar = lambda texto: enviadas.append(texto) or True
agora = datetime.now(timezone.utc)
al = [{"nivel": "atencao", "mensagem": "Disco 76% cheio — apague mídias antigas."}]
assert len(notifier.processar(al, agora)) == 1
al2 = [{"nivel": "atencao", "mensagem": "Disco 77% cheio — apague mídias antigas."}]  # número mudou: mesmo alerta
assert notifier.processar(al2, agora + timedelta(minutes=10)) == []
assert len(notifier.processar(al2, agora + timedelta(hours=25))) == 1  # lembrete diário
crit = [{"nivel": "critico", "mensagem": "Disco 95% cheio — apague mídias antigas."}]
assert len(notifier.processar(crit, agora + timedelta(hours=25, minutes=10))) == 1  # subiu para crítico
saida = notifier.processar([], agora + timedelta(hours=26))
assert len(saida) == 1 and "resolvido" in saida[0]
r = c.post("/api/v1/admin/notify-test", headers=H)
assert r.status_code == 200, r.text
print("avisos no Telegram (sem spam) ok")

# ---------- painel traz a vigilância ----------
st = c.get("/api/v1/admin/system", headers=H).json()
assert "instagram" in st and "avisos" in st and st["avisos"]["telegram_configurado"] is True
print("painel com vigilância ok")

print("\nTODOS OS TESTES DE VIGILÂNCIA PASSARAM")
