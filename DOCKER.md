# 🐳 Rodar com Docker

Sobe **tudo** (Postgres + backend + frontend) com um comando só. Não precisa instalar Python, Node, ffmpeg nem Postgres na máquina — só o **Docker Desktop**.

## 1. Configurar (uma vez)

Na raiz do projeto, copie o exemplo de variáveis e ajuste:

```bash
cp .env.example .env
```

Edite `.env`:
```
POSTGRES_PASSWORD=uma_senha_qualquer
OPENAI_API_KEY=sk-...      # opcional — só p/ os recursos de IA
OPENAI_MODEL=gpt-4o-mini
```

> Este `.env` (da raiz) é usado **só pelo Docker**. Ele é diferente do `backend/.env`, que é usado quando você roda sem Docker.

## 2. Subir

```bash
docker compose up -d --build
```

Pronto. Acesse:

| O quê | URL |
|-------|-----|
| **Aplicativo (frontend)** | http://localhost:8080 |
| API / Swagger | http://localhost:8000/docs |
| Health | http://localhost:8080/health |

O nginx do frontend já faz proxy de `/api` para o backend — então o app funciona direto, sem CORS.

## 3. Comandos úteis

```bash
docker compose logs -f backend     # ver logs do backend
docker compose ps                  # status dos containers
docker compose down                # parar (mantém os dados)
docker compose down -v             # parar e APAGAR os dados (banco + mídias)
docker compose up -d --build       # reconstruir após mudar o código
```

## Como está montado

```
┌─────────────────────────────────────────────┐
│  frontend  (nginx:80 → publica em :8080)      │
│    • serve o React buildado                   │
│    • proxy /api e /health → backend:8000      │
└───────────────────┬───────────────────────────┘
                    │
┌───────────────────▼───────────────────────────┐
│  backend  (FastAPI + ffmpeg + fontes)  :8000  │
│    • uploads, frases, IA, motor de vídeo      │
│    • volume "storage" → /app/storage          │
└───────────────────┬───────────────────────────┘
                    │
┌───────────────────▼───────────────────────────┐
│  db  (postgres:16)  :5432                      │
│    • volume "pgdata" → dados persistem         │
└────────────────────────────────────────────────┘
```

- **Volumes** (`pgdata`, `storage`) guardam banco e arquivos entre reinícios. Só somem com `down -v`.
- A imagem do backend já inclui **ffmpeg** e as **fontes** (Liberation/DejaVu) para o texto dentro do vídeo — testado e gerando `.mp4` corretamente dentro do container.

## Detalhes técnicos

- Backend: `python:3.11-slim` + `ffmpeg` + `fonts-liberation` + `fonts-dejavu-core`.
- Frontend: build multi-stage (`node:20` compila, `nginx:alpine` serve).
- As tabelas do banco são criadas automaticamente quando o backend sobe.
- Para volume grande de geração em produção, trocar o background do FastAPI por Celery + Redis (ver README).
