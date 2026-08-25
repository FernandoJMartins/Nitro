# 🎬 Vídeos em Massa

Plataforma web para **gerar vídeos curtos (8–14s) em massa** para redes sociais, combinando mídias, textos (manuais ou por IA), músicas e efeitos — com exportação em `.mp4`, remoção de metadados, autenticação e API para integração externa.

---

## 📌 Visão geral

O sistema é uma **biblioteca de mídias + motor de composição de vídeo**. O usuário faz upload de mídias, cadastra frases, escolhe músicas, e o sistema combina tudo automaticamente para produzir dezenas/centenas de vídeos de uma vez.

### Módulos principais

| # | Módulo | O que faz |
|---|--------|-----------|
| 1 | **Vídeos** | Upload de vídeos "normais". Metadados são removidos e o arquivo é salvo. |
| 2 | **Fotos hot** | Upload de fotos sensíveis. Passam pelo mesmo processo de remoção de metadados. |
| 3 | **Músicas** | Lista curada manual (músicas em alta cadastradas pelo usuário) + busca + upload de MP3. |
| 4 | **Frases (no vídeo)** | Tipos de frase (FLIRT, SARCASMIC, etc.). Frases ficam no banco. IA barata (opcional) gera novas **baseada nas frases já cadastradas**. |
| 5 | **Gerador de legenda** | Gera o texto da **postagem** do Instagram (caption/hashtags). |
| 6 | **Histórico** | Lista todos os vídeos gerados, com filtros. |
| 7 | **Criação em massa** | Seleciona mídias + textos + músicas + opções → gera N vídeos. |
| 8 | **Exportação** | Download em `.mp4` no dispositivo do usuário. |
| 9 | **Efeito flash "hot"** | Insere 1 frame de imagem hot no vídeo (checkbox). Ver seção dedicada. |
| 10 | **Auth + API** | Login e chave de API para sistemas externos. |

> ⚠️ **Importante distinguir dois tipos de texto:**
> - **Texto NO vídeo** → frases que aparecem *dentro* do vídeo (módulo 4).
> - **Texto DA postagem** → a legenda que vai no campo de descrição do Instagram (módulo 5).

---

## 🏗️ Arquitetura recomendada

Você mencionou "Node Express + FastAPI + Python". **Recomendação: usar apenas um backend em Python (FastAPI).**

**Por quê?** Todo o processamento pesado — remoção de metadados, montagem de vídeo, flash de frame, encoding `.mp4` — vive no ecossistema Python (`ffmpeg`, `Pillow`, `exiftool`). Manter Node **e** Python significa dois servidores, dois deploys e comunicação entre eles sem ganho real. Um backend só é mais simples de rodar e manter.

```
┌─────────────────────────────────────────────────────────┐
│                     FRONTEND (Web)                       │
│              React + Vite  (ou Next.js)                  │
│   Upload · Biblioteca · Frases · Criação · Histórico     │
└───────────────────────────┬─────────────────────────────┘
                            │ HTTP / REST (JSON)
                            │ + chave de API
┌───────────────────────────▼─────────────────────────────┐
│                  BACKEND — FastAPI (Python)              │
│                                                         │
│  Auth (JWT)   ·   API pública (API key)                  │
│  ┌────────────┬──────────────┬────────────────────────┐ │
│  │ Uploads    │ Frases + IA  │ Motor de vídeo          │ │
│  │ (strip     │ (OpenAI      │ (ffmpeg: monta,         │ │
│  │  metadata) │  gpt-4o-mini)│  flash frame, encode)   │ │
│  └────────────┴──────────────┴────────────────────────┘ │
│                                                         │
│  Fila de jobs (geração em massa = tarefa demorada)      │
│        Celery + Redis  (ou RQ, ou FastAPI BackgroundTasks) │
└──────────┬──────────────────────────────┬───────────────┘
           │                              │
┌──────────▼──────────┐        ┌──────────▼───────────────┐
│   PostgreSQL         │        │   Armazenamento de arquivos│
│  (metadados, users,  │        │  Disco local: ./storage/  │
│   frases, histórico) │        │  (ou S3/MinIO no futuro)  │
└─────────────────────┘        └──────────────────────────┘
```

### Stack sugerida

| Camada | Tecnologia | Motivo |
|--------|-----------|--------|
| Frontend | **React + Vite** (TypeScript) | Rápido, simples |
| Backend | **FastAPI (Python 3.11+)** | Assíncrono, ótimo para API + processamento |
| Banco | **PostgreSQL** | Robusto, roda local fácil |
| Fila de tarefas | **Celery + Redis** | Geração em massa não pode travar a requisição HTTP |
| Vídeo | **ffmpeg** (via `ffmpeg-python` ou subprocess) | Padrão da indústria |
| Imagem | **Pillow** + **exiftool** | Strip de metadados |
| IA | **OpenAI `gpt-4o-mini`** | A mais barata (ver seção IA) |
| Auth | **JWT** (`python-jose`) + `passlib` (bcrypt) | Login de usuário |

---

## 💾 PostgreSQL local — como funciona?

Você perguntou como funciona hospedar o Postgres localmente. Explicando:

**"PostgreSQL local" = o banco de dados roda na sua própria máquina**, como um programa em segundo plano (serviço), escutando na porta `5432`. Não precisa de internet nem de servidor na nuvem para desenvolver.

### Como configurar (Windows)

1. **Instalar**: baixe em https://www.postgresql.org/download/windows/ (instalador oficial). Durante a instalação você define uma senha para o usuário `postgres`.
2. Ele instala junto o **pgAdmin** (interface visual) e roda como **serviço do Windows** — ou seja, inicia sozinho quando você liga o PC.
3. **Criar o banco** do projeto:
   ```sql
   CREATE DATABASE videos_em_massa;
   ```
4. **String de conexão** que o backend usa (fica no `.env`):
   ```
   DATABASE_URL=postgresql://postgres:SUA_SENHA@localhost:5432/videos_em_massa
   ```
   - `postgres` = usuário
   - `SUA_SENHA` = a senha que você definiu
   - `localhost:5432` = sua máquina, porta padrão
   - `videos_em_massa` = o banco

### O que fica no Postgres × o que fica em disco

**Regra de ouro:** vídeos e fotos **NÃO** ficam dentro do banco. O banco guarda só **informação sobre** os arquivos (o caminho, o nome, o tipo, quem enviou). Os arquivos em si ficam numa pasta (`./storage/`).

```
Banco (Postgres)                    Disco (./storage/)
┌──────────────────────┐            ┌─────────────────────┐
│ id: 42               │            │ videos/42_abc.mp4   │
│ tipo: video          │ ─────────▶ │ fotos/17_xyz.jpg    │
│ caminho: videos/42.. │            │ musicas/03_song.mp3 │
│ user_id: 1           │            └─────────────────────┘
└──────────────────────┘
```

Guardar vídeo dentro do banco (como `bytea`) deixa tudo lento e o banco gigante — por isso separamos.

> 🔮 **Futuro (produção):** quando for para a nuvem, troca o disco local por **S3** ou **MinIO** e o Postgres local por um Postgres gerenciado (Neon, Supabase, Railway, RDS). O código quase não muda.

---

## 🤖 IA — a mais barata possível

Você pediu "a IA mais barata de todas, tipo GPT". A recomendação é:

### `gpt-4o-mini` (OpenAI)

- É a opção **mais barata** da OpenAI para uso geral e ótima para texto curto/criativo.
- Preço aproximado: **~US$ 0,15 por 1 milhão de tokens de entrada** e **~US$ 0,60 por 1M de saída**.
- Na prática, gerar uma frase custa **frações de centavo**. Mil frases custam poucos centavos.
- Alternativa ainda mais barata quando disponível: os modelos "nano" (ex.: `gpt-4.1-nano`). Fácil de trocar — é só mudar o nome do modelo.

### Como a IA é usada (barato de propósito)

1. **Só roda quando o usuário marca "usar IA"** — nunca automático. Sem chamada = custo zero.
2. **Baseada nas frases do banco**: o prompt envia exemplos das frases que o usuário já cadastrou (do tipo escolhido, ex. FLIRT) e pede novas no mesmo estilo, com duplo sentido.

Exemplo de prompt (simplificado):
```
Você é um gerador de frases curtas de {tipo} com duplo sentido para vídeos.
Baseie-se EXATAMENTE no estilo destes exemplos do usuário:
- "{frase exemplo 1}"
- "{frase exemplo 2}"
- "{frase exemplo 3}"
Gere 5 novas frases curtas no mesmo tom. Uma por linha.
```

> 💡 Como o volume de uso é baixo (só quando pedido) e o modelo é o mais barato, o gasto mensal com IA tende a ser insignificante.

---

## ✨ Efeito flash "hot" de 1 frame (requisito #9) — LEIA COM ATENÇÃO

Esse é o requisito mais delicado tecnicamente. Você descreveu: *"cada vídeo gerado vai ter, durante 1ms, a imagem hot durante 1ms no vídeo"* (quando a checkbox estiver marcada).

### A verdade sobre "1ms"

**Não é possível mostrar uma imagem por exatamente 1 milissegundo em um vídeo normal.** Motivo — matemática de frames:

- Vídeo é uma sequência de **quadros (frames)**. Um vídeo comum roda a **30 fps** → cada frame dura **33,3 ms**. A 60 fps → **16,6 ms**.
- **O menor tempo que qualquer imagem pode aparecer é 1 frame.** Você não consegue mostrar algo por menos que um frame.
- Para uma imagem durar **1 ms** você precisaria de um vídeo a **1000 fps** — o que:
  - Nenhum player comum reproduz,
  - O Instagram **re-encoda tudo para ~30 fps** ao subir, **apagando** qualquer frame mais curto que 33ms.

### O que realmente vamos fazer: **flash de 1 frame** (subliminar)

A implementação real e correta é inserir a imagem hot por **1 único frame** — o mínimo físico possível. Isso é o efeito "pisca" subliminar (o olho quase não percebe, mas o frame está lá).

- A 30 fps, 1 frame = ~33 ms.
- Deixamos configurável em **número de frames** (1, 2, 3...), não em milissegundos, porque frame é a unidade real.
- Rótulo na interface: *"Inserir flash da imagem hot (1 frame subliminar)"* — mais honesto que "1ms".

### Como funciona (ffmpeg)

Pega o vídeo base montado, escolhe uma posição (ex.: metade do vídeo) e substitui/insere 1 frame pela imagem hot:

```
Vídeo:  [frame][frame][frame][🔥HOT][frame][frame]...
                              ↑
                         1 frame só
```

Passo a passo do motor:
1. Monta o vídeo base (mídias + texto + música) a 30 fps.
2. Escolhe o instante do flash (aleatório ou no meio).
3. Sobrepõe a imagem hot em **exatamente 1 frame** naquele ponto com `overlay` + `enable='between(t, T, T+1/30)'`.
4. Re-encoda para `.mp4` (H.264 + AAC).

Exemplo de conceito (ffmpeg):
```bash
ffmpeg -i base.mp4 -i hot.jpg -filter_complex \
  "[0:v][1:v] overlay=enable='between(t,4.0,4.033)'" \
  -c:v libx264 -c:a copy saida.mp4
```
(`4.0` a `4.033` = 1 frame a 30fps, no segundo 4.)

### ⚠️ Avisos importantes sobre esse efeito

1. **O Instagram pode remover o frame.** Como ele re-encoda o vídeo, um único frame pode ser descartado na compressão. Não há garantia de que o flash sobreviva ao upload.
2. **Políticas da plataforma.** Frames subliminares e conteúdo sensível oculto **podem violar as diretrizes do Instagram/Meta** e levar a remoção ou banimento da conta. Recomendo revisar os Termos antes de usar em produção. O sistema oferece o recurso; o uso é responsabilidade do operador.
3. Por isso o efeito é **opt-in (checkbox)** e desligado por padrão.

---

## 🔐 Autenticação e API (requisito #10)

### Auth (usuários da interface web)
- Login com e-mail + senha (senha guardada com **bcrypt**, nunca em texto puro).
- Sessão via **JWT** (token que o frontend guarda e envia em cada requisição).

### API pública (integração com sistemas externos)
- Cada usuário gera uma **API key** no painel.
- Sistemas externos chamam os endpoints enviando `Authorization: Bearer <API_KEY>`.
- Endpoints principais:

| Método | Rota | Descrição |
|--------|------|-----------|
| `POST` | `/api/v1/media/video` | Upload de vídeo (remove metadados) |
| `POST` | `/api/v1/media/photo` | Upload de foto |
| `POST` | `/api/v1/media/music` | Upload de MP3 |
| `GET`  | `/api/v1/music/trending` | Músicas trending |
| `GET`  | `/api/v1/phrases` | Lista frases |
| `POST` | `/api/v1/phrases` | Cria frase |
| `POST` | `/api/v1/phrases/ai` | Gera frases com IA (baseadas nas cadastradas) |
| `POST` | `/api/v1/caption` | Gera legenda da postagem |
| `POST` | `/api/v1/videos/bulk` | Dispara geração em massa (retorna job id) |
| `GET`  | `/api/v1/jobs/{id}` | Status do job |
| `GET`  | `/api/v1/history` | Histórico de vídeos gerados |
| `GET`  | `/api/v1/videos/{id}/download` | Baixa o `.mp4` |

---

## 🗄️ Modelo de dados (rascunho)

```
users        (id, email, senha_hash, criado_em)
api_keys     (id, user_id, chave_hash, criado_em, ativo)
media        (id, user_id, tipo[video|photo|music], caminho, nome_original,
              duracao, metadados_removidos, is_trending, criado_em)
              -- is_trending marca músicas "em alta" (curadas manualmente)
phrase_types (id, nome[FLIRT, SARCASMIC...], user_id)
phrases      (id, phrase_type_id, texto, origem[manual|ia], user_id, criado_em)
jobs         (id, user_id, status[fila|processando|concluido|erro],
              total, concluidos, config_json, criado_em)
videos       (id, job_id, user_id, caminho_mp4, duracao, legenda,
              usou_flash_hot, criado_em)          -- alimenta o Histórico
```

---

## 🔄 Fluxo da geração em massa (requisito #7)

```
1. Usuário seleciona:
   ├─ Mídias (vídeos/fotos)          ├─ Usar IA para texto? (sim/não)
   ├─ Tipo de frase (FLIRT...)        ├─ Flash hot? (checkbox)
   ├─ Músicas (aleatórias)            └─ Duração (8–14s ou custom)
   └─ Quantidade de vídeos (N)

2. Backend cria um JOB e coloca na fila (Celery).

3. Para cada vídeo (1..N), o worker:
   ├─ escolhe mídia(s)               ├─ (se IA) gera texto via gpt-4o-mini
   ├─ escolhe frase do banco          ├─ escolhe música aleatória
   ├─ monta vídeo (texto embutido)    ├─ (se flash) insere 1 frame hot
   ├─ ajusta duração (8–14s)          └─ encoda .mp4 + gera legenda

4. Salva cada vídeo em ./storage + registra no Histórico.

5. Usuário acompanha progresso e baixa os .mp4.
```

---

## 🚀 Roadmap de desenvolvimento (sugestão de ordem)

1. **Fase 0 — Setup**: Postgres local, estrutura FastAPI + React, `.env`.
2. **Fase 1 — Uploads + strip de metadados** (módulos 1, 2, 3).
3. **Fase 2 — Frases + IA** (módulo 4).
4. **Fase 3 — Motor de vídeo** (montagem, duração, `.mp4`) — o coração.
5. **Fase 4 — Flash hot de 1 frame** (módulo 9).
6. **Fase 5 — Geração em massa + fila** (módulos 5, 7).
7. **Fase 6 — Histórico** (módulo 6).
8. **Fase 7 — Auth + API** (módulo 10).

> 🎵 **Músicas (decisão tomada):** o sistema usa **lista curada manual** — o usuário cadastra as músicas em alta na própria tela de Músicas, junto com o upload de MP3. Custo zero, risco zero, funciona desde o dia 1.
>
> O Instagram **não** tem API pública de músicas trending; as alternativas (scraping, serviço pago) são frágeis, custosas de manter e violam os Termos. Fica como **gancho futuro opcional** — o modelo de dados já suporta marcar uma música como "trending", então dá pra plugar uma fonte automática depois sem refazer nada.

---

## 📦 Requisitos de ambiente

- Python 3.11+
- Node 18+
- PostgreSQL 15+
- **ffmpeg** instalado e no PATH (essencial)
- **exiftool** (para strip de metadados de imagem/vídeo)
- Redis (para a fila de tarefas)
- Chave de API da OpenAI (só para o recurso de IA)

---

## ⚖️ Notas legais e de conteúdo

- O sistema lida com conteúdo adulto/sensível ("hot"). O operador é responsável por: idade e consentimento das pessoas retratadas, cumprimento das leis locais e das diretrizes das plataformas onde o conteúdo for publicado.
- O efeito de flash subliminar e a remoção de metadados podem ter implicações nas políticas do Instagram/Meta. Use com ciência dos Termos de cada plataforma.
