"""Teste da fingerprint de dispositivo por conta (multilogin anti-cruzamento).

Sem rede: gerar fingerprint persiste o device do fork (modelo/hardware, uuids,
user-agent, locale, timezone), o resumo legível devolve modelo · Android ·
locale · fuso, e o endpoint /fingerprint regenera a identidade da conta.
"""
import json
import os
import uuid

os.environ["DATABASE_URL"] = "sqlite:///./_smoke_fp.db"
os.environ["STORAGE_DIR"] = "./_smoke_fp_storage"

import pytest  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.publishing.core.fingerprint import DEVICE_POOL, descrever_fingerprint, gerar_fingerprint  # noqa: E402


def _com_instagrapi() -> bool:
    try:
        import instagrapi  # noqa: PLC0415, F401
        return True
    except ImportError:
        return False


def test_gerar_fingerprint_persiste_device_completo():
    if not _com_instagrapi():
        pytest.skip("instagrapi não instalado (ex.: host) — geração offline indisponível")
    fp = gerar_fingerprint("es_ES", "Europe/Madrid")
    dados = json.loads(fp)
    assert set(dados) >= {"device_settings", "uuids", "user_agent", "locale", "timezone_offset", "timezone_name"}
    dev = dados["device_settings"]
    assert {"android_version", "android_release", "dpi", "resolution", "model", "cpu"} <= set(dev)
    # device veio do pool real de aparelhos
    assert any(p["model"] == dev["model"] and p["cpu"] == dev["cpu"] for p in DEVICE_POOL)
    assert dados["uuids"].get("uuid")  # uuid novo a cada geração
    assert dados["locale"] == "es_ES"
    assert dados["timezone_name"] == "Europe/Madrid"
    # uuids são novos a cada geração (reset do device)
    fp2 = gerar_fingerprint("es_ES", "Europe/Madrid")
    assert json.loads(fp2)["uuids"]["uuid"] != dados["uuids"]["uuid"]


def test_gerar_fingerprint_locale_e_fuso_invalidos_caem_no_padrao():
    if not _com_instagrapi():
        pytest.skip("instagrapi não instalado (ex.: host) — geração offline indisponível")
    fp = gerar_fingerprint(None, "Fuso/Inexistente")
    dados = json.loads(fp)
    assert dados["locale"] == "pt_BR"
    assert dados["timezone_name"] == "UTC"


def test_descrever_fingerprint_resumo_legivel():
    fp = json.dumps(
        {
            "device_settings": {"model": "Pixel 8 Pro", "android_release": "14"},
            "locale": "pt_BR",
            "timezone_name": "America/Sao_Paulo",
        }
    )
    assert descrever_fingerprint(fp) == "Pixel 8 Pro · Android 14 · pt_BR · America/Sao_Paulo"
    assert descrever_fingerprint(None) is None
    assert descrever_fingerprint("{garbage") is None
    assert descrever_fingerprint(json.dumps({"locale": "pt_BR"})) == "pt_BR"


client = TestClient(app)
_tok = client.post(
    "/api/v1/auth/register", json={"email": f"fp-{uuid.uuid4().hex[:8]}@t.com", "senha": "segredo1"}
).json()["access_token"]
client.headers.update({"Authorization": f"Bearer {_tok}"})


def test_endpoint_fingerprint_regenera_e_expoe_resumo():
    if not _com_instagrapi():
        pytest.skip("instagrapi não instalado (ex.: host) — endpoint devolveria 400 de propósito")
    r = client.post(
        "/api/v1/publishing/accounts",
        json={"nome_interno": "Perfil FP", "username": f"fp{uuid.uuid4().hex[:8]}", "idioma": "fr_FR"},
    )
    assert r.status_code == 200, r.text
    acc = r.json()
    assert acc["fingerprint_resumo"] is None  # ainda sem fingerprint
    r = client.post(f"/api/v1/publishing/accounts/{acc['id']}/fingerprint")
    assert r.status_code == 200, r.text
    acc = r.json()
    assert acc["fingerprint_resumo"]
    assert "fr_FR" in acc["fingerprint_resumo"]
    from app.database import SessionLocal  # noqa: PLC0415
    from app.publishing.models import Account  # noqa: PLC0415

    with SessionLocal() as s:
        primeiro_uuid = json.loads(s.get(Account, acc["id"]).fingerprint)["uuids"]["uuid"]
    # a segunda geração troca o aparelho/uuid (rotação de identidade) — o
    # resumo pode mudar de aparelho, mas o blob persistido precisa ser outro.
    acc = client.post(f"/api/v1/publishing/accounts/{acc['id']}/fingerprint").json()
    assert acc["fingerprint_resumo"]
    assert "fr_FR" in acc["fingerprint_resumo"]
    with SessionLocal() as s:
        blob = s.get(Account, acc["id"]).fingerprint
    assert json.loads(blob)["uuids"]["uuid"] != primeiro_uuid


def test_endpoint_fingerprint_devolve_resumo_vazio_sem_instagrapi():
    """Sem a biblioteca, o endpoint devolve 400 com mensagem clara — nunca 500."""
    if _com_instagrapi():
        pytest.skip("instagrapi instalado — caminho de erro não se aplica aqui")
    r = client.post(
        "/api/v1/publishing/accounts",
        json={"nome_interno": "Sem FP", "username": f"nfp{uuid.uuid4().hex[:8]}"},
    )
    acc = r.json()
    r = client.post(f"/api/v1/publishing/accounts/{acc['id']}/fingerprint")
    assert r.status_code == 400
    assert "instagrapi" in r.json()["detail"]
