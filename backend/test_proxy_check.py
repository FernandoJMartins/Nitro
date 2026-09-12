"""Teste da checagem de proxy (sem rede): retry em proxy rotativo, múltiplos
serviços de IP e mensagens de erro acionáveis.
"""
import os
from unittest import mock

os.environ["DATABASE_URL"] = "sqlite:///./_smoke_proxy.db"
os.environ["STORAGE_DIR"] = "./_smoke_proxy_storage"

from app.database import SessionLocal  # noqa: E402
from app.main import app as _app  # noqa: E402, F401 — registra/cria as tabelas
from app.publishing.core.proxies import CHECK_ATTEMPTS, check_proxy  # noqa: E402
from app.publishing.models import Proxy  # noqa: E402

db = SessionLocal()


def _novo_proxy() -> Proxy:
    proxy = Proxy(user_id=1, nome="p", protocolo="socks5", host="server.sixproxy.com", porta=24654)
    db.add(proxy)
    db.commit()
    db.refresh(proxy)
    return proxy


# 1) primeira tentativa pega IP de saída bloqueado (SSL EOF), a segunda responde
proxy = _novo_proxy()
resposta_ok = mock.Mock(status_code=200)
resposta_ok.json.return_value = {"ip": "1.2.3.4"}
with mock.patch(
    "app.publishing.core.proxies.requests.get",
    side_effect=[OSError("SSL: UNEXPECTED_EOF_WHILE_READING"), resposta_ok],
):
    check_proxy(db, proxy)
assert proxy.status in ("verde", "amarelo"), proxy.status
assert proxy.ip_publico == "1.2.3.4"
assert proxy.ultimo_erro is None
print("retry em proxy rotativo (SSL EOF na 1ª tentativa, sucesso na 2ª) ok")

# 2) todas as tentativas com SSL EOF -> vermelho com mensagem acionável
proxy2 = _novo_proxy()
with mock.patch(
    "app.publishing.core.proxies.requests.get",
    side_effect=[OSError("SSL: UNEXPECTED_EOF_WHILE_READING")] * CHECK_ATTEMPTS,
):
    check_proxy(db, proxy2)
assert proxy2.status == "vermelho"
assert "HTTPS através do proxy falhou" in proxy2.ultimo_erro, proxy2.ultimo_erro
print("todas as tentativas com SSL EOF -> vermelho + dica acionável ok")

# 3) proxy inalcançável (timeout de conexão) -> vermelho com "Proxy indisponível"
proxy3 = _novo_proxy()
with mock.patch(
    "app.publishing.core.proxies.requests.get",
    side_effect=[TimeoutError("connect timeout")] * CHECK_ATTEMPTS,
):
    check_proxy(db, proxy3)
assert proxy3.status == "vermelho" and "Proxy indisponível" in proxy3.ultimo_erro
print("proxy inalcançável -> vermelho 'Proxy indisponível' ok")

db.close()
print(">>> PROXY CHECK OK")
