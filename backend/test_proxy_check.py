"""Teste da checagem de proxy (sem rede): retry em proxy rotativo, múltiplos
serviços de IP, fallback HTTP CONNECT e mensagens de erro acionáveis.
"""
import os
from unittest import mock

os.environ["DATABASE_URL"] = "sqlite:///./_smoke_proxy.db"
os.environ["STORAGE_DIR"] = "./_smoke_proxy_storage"

from app.database import SessionLocal  # noqa: E402
from app.main import app as _app  # noqa: E402, F401 — registra/cria as tabelas
from app.publishing.core.proxies import check_proxy  # noqa: E402
from app.publishing.models import Proxy  # noqa: E402

db = SessionLocal()

SSL_EOF = OSError("SSL: UNEXPECTED_EOF_WHILE_READING")


def _novo_proxy() -> Proxy:
    proxy = Proxy(user_id=1, nome_interno="p", protocolo="socks5", host="server.sixproxy.com", porta=24654)
    db.add(proxy)
    db.commit()
    db.refresh(proxy)
    return proxy


def _resposta(ip: str):
    r = mock.Mock(status_code=200)
    r.json.return_value = {"ip": ip}
    return r


# 1) primeira tentativa pega IP de saída bloqueado (SSL EOF), a segunda responde
proxy = _novo_proxy()
with mock.patch("app.publishing.core.proxies.requests.get", side_effect=[SSL_EOF, _resposta("1.2.3.4")]):
    check_proxy(db, proxy)
assert proxy.status in ("verde", "amarelo"), proxy.status
assert proxy.ip_publico == "1.2.3.4"
assert proxy.ultimo_erro is None
print("retry em proxy rotativo (SSL EOF na 1ª tentativa, sucesso na 2ª) ok")

# 2) SOCKS5 conecta mas o TLS é encerrado em tudo -> fallback HTTP CONNECT funciona
proxy2 = _novo_proxy()
with mock.patch(
    "app.publishing.core.proxies.requests.get",
    side_effect=[SSL_EOF, SSL_EOF, SSL_EOF, _resposta("9.9.9.9")],
):
    check_proxy(db, proxy2)
assert proxy2.status in ("verde", "amarelo"), proxy2.status
assert proxy2.protocolo == "http", "fallback HTTP CONNECT deveria ser persistido"
assert proxy2.ip_publico == "9.9.9.9"
print("fallback HTTP CONNECT (socks5 com TLS encerrado) -> http persistido ok")

# 3) tudo falha, mas HTTP puro responde -> vermelho com diagnóstico claro
proxy3 = _novo_proxy()
with mock.patch(
    "app.publishing.core.proxies.requests.get",
    side_effect=[SSL_EOF] * 6 + [_resposta("5.6.7.8")],
):
    check_proxy(db, proxy3)
assert proxy3.status == "vermelho"
assert "credenciais funcionam" in proxy3.ultimo_erro and "não serve para publicar" in proxy3.ultimo_erro
print("HTTPS sempre falha + HTTP puro OK -> vermelho com diagnóstico ok")

# 4) nem HTTP puro responde -> vermelho apontando endpoint/credenciais
proxy4 = _novo_proxy()
with mock.patch(
    "app.publishing.core.proxies.requests.get",
    side_effect=[SSL_EOF] * 10,
):
    check_proxy(db, proxy4)
assert proxy4.status == "vermelho" and "nem HTTP puro respondeu" in proxy4.ultimo_erro
print("tudo falha (nem HTTP) -> vermelho 'endpoint/credenciais inválidos' ok")

# 5) proxy inalcançável (timeout) -> vermelho com "Proxy indisponível"
proxy5 = _novo_proxy()
with mock.patch(
    "app.publishing.core.proxies.requests.get",
    side_effect=[TimeoutError("connect timeout")] * 10,
):
    check_proxy(db, proxy5)
assert proxy5.status == "vermelho" and "Proxy indisponível" in proxy5.ultimo_erro
print("proxy inalcançável -> vermelho 'Proxy indisponível' ok")

db.close()
print(">>> PROXY CHECK OK")
