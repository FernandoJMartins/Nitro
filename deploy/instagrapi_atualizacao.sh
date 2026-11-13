#!/usr/bin/env bash
# Atualização da biblioteca do Instagram (instagrapi) — roda no SERVIDOR DE CASA.
#
#   deploy/instagrapi_atualizacao.sh verificar   # cron diário: testa versão nova num container descartável
#   deploy/instagrapi_atualizacao.sh aplicar     # você manda: atualiza casa, confere, commita e sobe no droplet
#
# "verificar" nunca mexe no que está rodando: só testa e avisa (painel Admin → Sistema
# + Telegram). "aplicar" só aceita uma versão que passou no "verificar".
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="nitro-backend-1"                        # container do servidor de casa
IMAGEM="nitro-backend"                           # imagem usada no teste descartável
DROPLET="root@143.198.15.104"
DROPLET_DIR="/opt/nitro"
GH="https://api.github.com/repos/subzeroid/instagrapi"
RESULTADO="/app/storage/_atualizacao_instagrapi.json"   # lido pelo painel (dentro do container)

log() { echo "[$(date '+%F %T')] $*"; }

env_var() {  # lê uma variável do .env de casa (sem exportar nada)
  grep -E "^$1=" "$REPO_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2- | sed 's/^"//; s/"$//'
}

telegram() {
  local token chat
  token="$(env_var TELEGRAM_BOT_TOKEN)"; chat="$(env_var TELEGRAM_CHAT_ID)"
  [ -n "$token" ] && [ -n "$chat" ] || return 0
  curl -fsS -m 15 "https://api.telegram.org/bot${token}/sendMessage" \
    --data-urlencode "chat_id=${chat}" --data-urlencode "text=$1" >/dev/null || true
}

instalada() { docker exec "$BACKEND" pip show instagrapi 2>/dev/null | awk '/^Version:/{print $2}'; }

salvar_resultado() {  # $1 = json
  printf '%s' "$1" | docker exec -i "$BACKEND" sh -c "cat > $RESULTADO"
}

ler_resultado() { docker exec "$BACKEND" sh -c "cat $RESULTADO 2>/dev/null" || true; }

verificar() {
  local tag sha atual anterior tmp saida status=0 resumo
  # TAG=x.y.z força uma versão (útil para testar o próprio script)
  tag="${TAG:-$(curl -fsS -m 20 "$GH/releases/latest" | python3 -c 'import json,sys; print(json.load(sys.stdin)["tag_name"].lstrip("v"))')}"
  atual="$(instalada)"
  log "instalada=$atual  última=$tag"
  if [ "$tag" = "$atual" ]; then
    log "em dia — nada a fazer"; return 0
  fi
  anterior="$(ler_resultado | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("versao",""))
except Exception: print("")')"
  if [ "$anterior" = "$tag" ]; then
    log "versão $tag já foi testada — resultado no painel"; return 0
  fi
  sha="$(curl -fsS -m 20 "$GH/commits/$tag" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sha"])')"

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN
  cp -r "$REPO_DIR/backend/app" "$REPO_DIR"/backend/test_*.py "$REPO_DIR/backend/requirements.txt" "$tmp/"
  sed -i -E "s#instagrapi/tar.gz/[0-9a-f]+#instagrapi/tar.gz/${sha}#" "$tmp/requirements.txt"

  log "testando $tag ($sha) num container descartável…"
  # 1) instala com os MESMOS limites do requirements (conflito = precisa de ajuste)
  # 2) testes do adaptador/fingerprint/billing   3) teste real de login (usuário inventado)
  set +e
  saida="$(docker run --rm -v "$tmp":/src -w /src -e PYTHONPATH=/src "$IMAGEM" sh -c '
    pip install -q -r requirements.txt pytest >/tmp/pip.log 2>&1 || { echo "ETAPA=dependencias"; tail -15 /tmp/pip.log; exit 10; }
    for t in test_instagram_adapter.py test_fingerprint.py; do  # separados: cada um monta seu banco
      python -m pytest -q $t 2>&1 | tail -15 > /tmp/t.log
      grep -Eq "[0-9]+ (failed|errors?)\b" /tmp/t.log && { echo "ETAPA=testes"; echo "$t:"; cat /tmp/t.log; exit 11; }
    done
    python test_billing.py >/tmp/b.log 2>&1 || { echo "ETAPA=testes"; tail -10 /tmp/b.log; exit 11; }
    python - <<EOF || exit 12
from instagrapi import Client
c = Client()
try:
    c.login("nitro_canario_upgrade_000", "SenhaQualquer-123")
except Exception as e:
    lr = getattr(c, "last_response", None)
    st = getattr(lr, "status_code", None)
    if type(e).__name__ in ("ClientThrottledError", "PleaseWaitFewMinutes") or st == 429:
        print("ETAPA=login"); print("429 no login com a versão nova:", e); raise SystemExit(12)
print("LOGIN=ok")
EOF
  ' 2>&1)"
  status=$?
  set -e

  local passou=false etapa=""
  [ $status -eq 0 ] && passou=true
  etapa="$(printf '%s\n' "$saida" | sed -n 's/^ETAPA=//p' | head -1)"
  resumo="$(printf '%s\n' "$saida" | grep -v '^ETAPA=' | tail -12)"

  salvar_resultado "$(python3 - "$tag" "$sha" "$atual" "$passou" "$etapa" "$resumo" <<'EOF'
import json, sys
from datetime import datetime, timezone
tag, sha, atual, passou, etapa, resumo = sys.argv[1:7]
print(json.dumps({
    "versao": tag, "sha": sha, "instalada": atual, "passou": passou == "true",
    "etapa_falhou": etapa or None, "resumo": resumo[-1500:],
    "testado_em": datetime.now(timezone.utc).isoformat(),
}))
EOF
)"

  if $passou; then
    log "PASSOU — pronto para aplicar"
    telegram "🟢 Casa — instagrapi $tag passou nos testes (em uso: $atual). Para atualizar casa + droplet, me diga \"pode subir\" ou rode: deploy/instagrapi_atualizacao.sh aplicar"
  else
    log "FALHOU na etapa: ${etapa:-desconhecida}"; printf '%s\n' "$resumo"
    telegram "🟡 Casa — instagrapi $tag saiu, mas NÃO passou nos testes (etapa: ${etapa:-?}). Precisa de ajuste no código antes de atualizar — peça ao Claude. Em uso continua $atual."
  fi
}

aplicar() {
  local json tag sha
  json="$(ler_resultado)"
  [ -n "$json" ] || { echo "Nenhuma versão testada. Rode primeiro: $0 verificar"; exit 1; }
  read -r tag sha passou < <(printf '%s' "$json" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["versao"], d["sha"], d["passou"])')
  [ "$passou" = "True" ] || { echo "A versão $tag NÃO passou nos testes — não aplico. Veja Admin → Sistema."; exit 1; }
  if python3 -c "import sys; v=lambda s: tuple(int(x) for x in s.split('.') if x.isdigit()); sys.exit(0 if v('$tag') < v('$(instalada)') else 1)"; then
    echo "A versão testada ($tag) é MAIS VELHA que a instalada ($(instalada)) — não rebaixo."; exit 1
  fi
  [ "$(instalada)" != "$tag" ] || { echo "Casa já está na $tag."; }

  cd "$REPO_DIR"
  git diff --quiet -- backend/requirements.txt || { echo "backend/requirements.txt tem mudanças não commitadas — resolva antes."; exit 1; }
  sed -i -E "s#instagrapi/tar.gz/[0-9a-f]+#instagrapi/tar.gz/${sha}#" backend/requirements.txt

  log "casa: reconstruindo o backend com instagrapi $tag…"
  docker compose -f docker-compose.dev.yml build backend
  docker compose -f docker-compose.dev.yml up -d backend
  for _ in $(seq 1 60); do
    docker exec "$BACKEND" python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health', timeout=3)" 2>/dev/null && break
    sleep 2
  done
  [ "$(instalada)" = "$tag" ] || { echo "Casa não subiu com a $tag — revertendo o requirements."; git checkout backend/requirements.txt; exit 1; }
  log "casa OK ($tag). Conferindo o login de verdade (usuário inventado)…"
  docker exec -w /app -e PYTHONPATH=/app "$BACKEND" python -c "
from app.database import SessionLocal
from app.services import login_canary
r = login_canary.executar(SessionLocal()); print(r['resultado'], '-', r.get('detalhe'))
assert r['resultado'] != 'bloqueado', 'login bloqueado com a versão nova'
"

  git add backend/requirements.txt
  git commit -m "instagrapi $tag (testada automaticamente no servidor de casa)" >/dev/null
  git push -q origin HEAD || log "aviso: git push falhou (seguindo com o deploy)"

  log "droplet: enviando e reconstruindo…"
  git archive HEAD backend | ssh "$DROPLET" "cd $DROPLET_DIR && tar -x && docker compose -f docker-compose.prod.yml up -d --build backend"
  for _ in $(seq 1 60); do curl -fsS -m 5 -o /dev/null https://nitroflow.site/health && break; sleep 3; done
  log "droplet: $(ssh "$DROPLET" "docker exec nitro-backend-1 pip show instagrapi | awk '/^Version:/{print \$2}'")"
  telegram "✅ instagrapi $tag aplicada em Casa e no nitroflow.site."
  log "pronto."
}

case "${1:-}" in
  verificar) verificar ;;
  aplicar) aplicar ;;
  *) echo "uso: $0 verificar|aplicar"; exit 2 ;;
esac
