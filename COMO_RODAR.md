# ▶️ Como rodar (Fase 0 + Fase 1)

O que já está pronto: **biblioteca de mídias** (vídeos, fotos hot, músicas) com **remoção automática de metadados** no upload, salvando arquivos em disco e os dados no PostgreSQL. Backend FastAPI + frontend React.

---

## 1. Banco de dados (uma vez só)

Abra o **pgAdmin** ou o terminal `psql` e crie o banco:

```bash
psql -U postgres -c "CREATE DATABASE videos_em_massa;"
```

Depois edite `backend/.env` e troque `SUA_SENHA` pela senha do seu PostgreSQL:

```
DATABASE_URL=postgresql+psycopg://postgres:SUA_SENHA@localhost:5432/videos_em_massa
```

> As tabelas são criadas sozinhas quando o backend sobe pela primeira vez.

---

## 2. Backend (FastAPI)

```bash
cd backend
./.venv/Scripts/python.exe -m uvicorn app.main:app --reload --port 8000
```

- API rodando em: http://localhost:8000
- Documentação interativa (Swagger): http://localhost:8000/docs
- Teste rápido: http://localhost:8000/health → `{"status":"ok"}`

---

## 3. Frontend (React)

Em outro terminal:

```bash
cd frontend
npm run dev
```

Abra http://localhost:5173 — a tela tem abas de **Vídeos / Fotos hot / Músicas**, com upload (vários arquivos de uma vez), download e exclusão. O frontend já encaminha as chamadas `/api` para o backend na porta 8000.

---

## Testes de verificação (opcional)

Provam que os metadados realmente são removidos (não precisam do Postgres):

```bash
cd backend
./.venv/Scripts/python.exe test_metadata.py    # vídeo + imagem
./.venv/Scripts/python.exe test_api_smoke.py    # API completa via SQLite temporário
```

---

## O que já funciona nesta fase

| Recurso | Status |
|---------|--------|
| Upload de vídeo (remove metadados via ffmpeg) | ✅ |
| Upload de **foto normal** (base de vídeo; remove EXIF) | ✅ |
| Upload de **foto hot** (só para o flash; remove EXIF) | ✅ |
| Upload de música MP3 (remove tags via ffmpeg) | ✅ |
| Salvar arquivo em disco + registro no banco | ✅ |
| Listar / baixar / excluir mídias | ✅ |
| Validação de extensão por tipo | ✅ |
| Marcar música como "trending" (curadoria manual) | ✅ (campo no banco) |
| **Tipos de frase** (FLIRT, SARCASMIC…) — criar/listar/excluir | ✅ |
| **Frases** por tipo — criar/listar/excluir (aparecem dentro do vídeo) | ✅ |
| **Gerar frases com IA** baseada nas suas (gpt-4o-mini) | ✅ |
| Salvar só as sugestões de IA escolhidas | ✅ |
| **Motor de vídeo**: monta mídia + texto + música + duração → `.mp4` | ✅ |
| **Flash hot de 1 frame** (checkbox, requisito #9) | ✅ |
| Aba **Criar**: gerar 1 vídeo pela interface, com preview e download | ✅ |
| **Geração EM MASSA**: N vídeos de uma vez (mídia/música/frase/hot sorteados) | ✅ |
| Textos no vídeo sorteados da sua **lista de frases** | ✅ |
| Opção de **IA gerar os textos** do vídeo (você decide) | ✅ |
| **Legenda da postagem por IA** (opcional, você decide) | ✅ |
| Job em background com **barra de progresso** | ✅ |
| Aba **Histórico**: todos os vídeos gerados, preview + download | ✅ |

## IA de frases (Fase 2) — opcional

O botão **Gerar com IA** na aba **Frases** só funciona se você colocar sua chave da OpenAI em `backend/.env`:

```
OPENAI_API_KEY=sk-...suachave...
OPENAI_MODEL=gpt-4o-mini
```

- Sem chave, o resto do app funciona normalmente; só a geração por IA retorna um aviso.
- A IA **nunca roda sozinha** — só quando você clica em "Gerar". Custo perto de zero.
- Ela usa até 15 das suas frases daquele tipo como exemplo de estilo (duplo sentido).
- As sugestões **não** são salvas automaticamente: você marca quais quer e clica em "Salvar selecionadas".

## Motor de vídeo (Fase 3+4)

Na aba **Criar** você escolhe: mídia base (foto ou vídeo), tipo+frase (texto dentro do vídeo), música, duração (5–20s) e o **flash hot** (checkbox). O vídeo sai em formato vertical 1080x1920 (`.mp4`, H.264+AAC), com preview e botão de download.

**Sobre o flash de "1 frame":** confirmado por teste automatizado que o flash cai em **exatamente 1 frame** (nem 0, nem 2). A ~30fps isso é ~33ms — o mínimo físico possível (o "1ms" literal não existe em vídeo; ver README). Lembre: o Instagram re-encoda e pode descartar esse frame no upload.

## Geração em massa (Fase 5) — como usar

Na aba **Criar**:
1. Marque as **mídias base** (vídeos e **fotos normais**) que entram no sorteio. As **fotos hot NÃO** aparecem aqui — elas servem só para o flash.
2. Marque as **músicas** (sorteadas por vídeo).
3. Escolha o **tipo de frase** — sua lista de frases vira o sorteio dos textos que aparecem no vídeo.
4. Opcional: **IA gera os textos** (baseada na sua lista) — você decide.
5. Opcional: **legenda da postagem por IA** — você decide.
6. Opcional: **flash hot** + marque as fotos hot (sorteadas por vídeo).
7. Defina a **quantidade** e o **range de duração** (mín–máx, padrão 5–15s). Cada vídeo pega uma duração **aleatória** dentro do range. Clique em Gerar.

> 📷 **Foto estática como base:** funciona igual a um vídeo — a foto vira um vídeo parado com texto, música e (se ligado) flash hot. A única diferença é que a duração vem do range que você escolher. Você pode misturar fotos e vídeos no mesmo pool de mídias base.

Uma barra de progresso acompanha o lote. Ao terminar, os vídeos aparecem com preview e botão de download — e também ficam na aba **Histórico**.

> As opções de IA (textos e legenda) só funcionam com a `OPENAI_API_KEY` no `.env`. Sem chave, use a lista manual de frases normalmente.

> ⚙️ **Escala:** hoje o lote roda em background no próprio processo do backend (FastAPI BackgroundTasks). Para volumes grandes/produção, trocar por Celery + Redis (já previsto no README).

## Próximas fases (ver README)

Auth (login) + API pública com chave para integração externa (Fase 7).
