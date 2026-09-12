// ---------- Auth / token ----------
const TOKEN_KEY = "nitro_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t: string) {
  localStorage.setItem(TOKEN_KEY, t);
}
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const t = getToken();
  return t ? { ...extra, Authorization: `Bearer ${t}` } : extra;
}

async function jsonOrThrow(r: Response) {
  if (r.status === 401) {
    clearToken();
    window.dispatchEvent(new Event("nitro-unauth"));
  }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || (await r.text()) || "Erro");
  return r.status === 204 ? null : r.json();
}

// GET/DELETE/POST json helpers já com auth
async function apiGetAsync(path: string) {
  return jsonOrThrow(await fetch(path, { headers: authHeaders() }));
}
async function apiSend(path: string, method: string, body?: unknown) {
  return jsonOrThrow(
    await fetch(path, {
      method,
      headers: authHeaders(body !== undefined ? { "Content-Type": "application/json" } : {}),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  );
}

// ---------- Auth endpoints ----------
export interface UserOut {
  id: number;
  email: string;
  criado_em: string;
}

export async function register(email: string, senha: string): Promise<void> {
  const data = await jsonOrThrow(
    await fetch("/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, senha }),
    })
  );
  setToken(data.access_token);
}

export async function login(email: string, senha: string): Promise<void> {
  const data = await jsonOrThrow(
    await fetch("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, senha }),
    })
  );
  setToken(data.access_token);
}

export function me(): Promise<UserOut> {
  return apiGetAsync("/api/v1/auth/me");
}

// ---------- API keys ----------
export interface ApiKey {
  id: number;
  nome: string;
  prefixo: string;
  ativo: boolean;
  criado_em: string;
}
export interface ApiKeyCreated extends ApiKey {
  chave: string;
}

export function listKeys(): Promise<ApiKey[]> {
  return apiGetAsync("/api/v1/keys");
}
export function createKey(nome: string): Promise<ApiKeyCreated> {
  return apiSend("/api/v1/keys", "POST", { nome });
}
export function deleteKey(id: number): Promise<void> {
  return apiSend(`/api/v1/keys/${id}`, "DELETE");
}

// ---------- Mídias ----------
export type MediaType = "video" | "photo" | "photo_hot" | "overlay" | "final_clip" | "music";

export interface Media {
  id: number;
  tipo: MediaType;
  folder_id: number | null;
  nome_original: string;
  caminho: string;
  duracao: number | null;
  tamanho_bytes: number;
  metadados_removidos: boolean;
  is_trending: boolean;
  observacao: string | null;
  criado_em: string;
}

export interface Folder {
  id: number;
  nome: string;
  criado_em: string;
}

const BASE = "/api/v1/media";

// folder: número = pasta específica; "none" = sem pasta; undefined = todas
export function listMedia(tipo: MediaType, folder?: number | "none"): Promise<Media[]> {
  let q = `?tipo=${tipo}`;
  if (folder === "none") q += "&sem_pasta=true";
  else if (typeof folder === "number") q += `&folder_id=${folder}`;
  return apiGetAsync(`${BASE}${q}`);
}

export async function uploadMedia(tipo: MediaType, file: File, folderId?: number | null): Promise<Media> {
  const form = new FormData();
  form.append("file", file);
  const q = folderId ? `?folder_id=${folderId}` : "";
  const r = await fetch(`${BASE}/${tipo}${q}`, { method: "POST", headers: authHeaders(), body: form });
  return jsonOrThrow(r);
}

export function moveMedia(id: number, folderId: number | null): Promise<Media> {
  return apiSend(`${BASE}/${id}/folder`, "PATCH", { folder_id: folderId });
}

// ---------- Pastas (guardam vídeo+foto+foto hot; música é universal) ----------
export function listFolders(): Promise<Folder[]> {
  return apiGetAsync(`/api/v1/folders`);
}
export function createFolder(nome: string): Promise<Folder> {
  return apiSend(`/api/v1/folders`, "POST", { nome });
}
export function renameFolder(id: number, nome: string): Promise<Folder> {
  return apiSend(`/api/v1/folders/${id}`, "PATCH", { nome });
}
export function deleteFolder(id: number): Promise<void> {
  return apiSend(`/api/v1/folders/${id}`, "DELETE");
}

export function deleteMedia(id: number): Promise<void> {
  return apiSend(`${BASE}/${id}`, "DELETE");
}

export function downloadUrl(id: number): string {
  return `${BASE}/${id}/download?token=${getToken() ?? ""}`;
}

// ---------- Frases ----------
const V1 = "/api/v1";

export interface PhraseType {
  id: number;
  nome: string;
  descricao: string | null;
  criado_em: string;
}
export interface Phrase {
  id: number;
  phrase_type_id: number;
  texto: string;
  origem: "manual" | "ia";
  criado_em: string;
}

export function listPhraseTypes(): Promise<PhraseType[]> {
  return apiGetAsync(`${V1}/phrase-types`);
}
export function createPhraseType(nome: string, descricao?: string): Promise<PhraseType> {
  return apiSend(`${V1}/phrase-types`, "POST", { nome, descricao });
}
export function deletePhraseType(id: number): Promise<void> {
  return apiSend(`${V1}/phrase-types/${id}`, "DELETE");
}
export interface PhraseTypeShare {
  slug: string;
  total_frases: number;
}
export function sharePhraseType(id: number): Promise<PhraseTypeShare> {
  return apiSend(`${V1}/phrase-types/${id}/share`, "POST");
}
export function importPhraseType(slug: string): Promise<PhraseType> {
  return apiSend(`${V1}/phrase-types/import`, "POST", { slug });
}
export function listPhrases(tipoId: number): Promise<Phrase[]> {
  return apiGetAsync(`${V1}/phrases?tipo_id=${tipoId}`);
}
export function createPhrase(phrase_type_id: number, texto: string): Promise<Phrase> {
  return apiSend(`${V1}/phrases`, "POST", { phrase_type_id, texto });
}
export function deletePhrase(id: number): Promise<void> {
  return apiSend(`${V1}/phrases/${id}`, "DELETE");
}

export interface AIResult {
  frases: string[];
  modelo: string;
  baseado_em: number;
}
export function generateAI(phrase_type_id: number, quantidade: number, instrucao_extra?: string): Promise<AIResult> {
  return apiSend(`${V1}/phrases/ai`, "POST", { phrase_type_id, quantidade, instrucao_extra });
}
export function bulkSavePhrases(phrase_type_id: number, textos: string[]): Promise<Phrase[]> {
  return apiSend(`${V1}/phrases/bulk-save`, "POST", { phrase_type_id, textos, origem: "ia" });
}

// ---------- Geração ----------
export interface GenerateBody {
  base_media_id: number;
  phrase_id?: number | null;
  music_media_id?: number | null;
  duration: number;
  use_flash: boolean;
  hot_media_id?: number | null;
  flash_at?: number | null;
}
export interface GenerateResult {
  id: string;
  url: string;
  duration: number;
  used_flash: boolean;
}
export function generateVideo(body: GenerateBody): Promise<GenerateResult> {
  return apiSend(`${V1}/videos/generate`, "POST", body);
}

export type VideoType = "pause" | "imagem" | "final" | "texto";

export interface BulkBody {
  quantidade: number;
  base_media_ids: number[];
  music_media_ids: number[];
  phrase_type_id: number | null;                 // fallback global (vídeo simples)
  text_types: Record<string, number | null>;     // tipo de frase por tipo de vídeo
  use_ia_texto: boolean;
  gerar_legenda_ia: boolean;
  duration_min: number;
  duration_max: number;
  // tipos de vídeo (marque 1 ou vários — sorteado por vídeo)
  video_types: VideoType[];
  hot_media_ids: number[];
  overlay_media_ids: number[];
  final_media_ids: number[];
  font_id: string | null;
  font_sizes: Record<string, number>;             // tamanho da fonte (px) por tipo de vídeo
  // posições (centro do elemento) em fração da tela [0..1], vindas do preview 9:16
  text_x: number;
  text_y: number;
  overlay_x: number;
  overlay_y: number;
  overlay_scale: number; // multiplicador de tamanho da imagem estática
}

export interface Font {
  id: string;
  nome: string;
  origem: "sistema" | "arquivo";
  css: string; // família aproximada para renderizar no navegador
}
export function listFonts(): Promise<Font[]> {
  return apiGetAsync(`${V1}/videos/fonts`);
}
export interface Job {
  id: number;
  status: "fila" | "processando" | "concluido" | "erro";
  total: number;
  concluidos: number;
  erro: string | null;
  criado_em: string;
}
export interface GeneratedVideo {
  id: number;
  job_id: number | null;
  caminho: string;
  duracao: number;
  texto: string | null;
  legenda: string | null;
  usou_flash: boolean;
  tipo_video: string | null;
  criado_em: string;
}

export function bulkGenerate(body: BulkBody): Promise<Job> {
  return apiSend(`${V1}/videos/bulk`, "POST", body);
}
export function getJob(id: number): Promise<Job> {
  return apiGetAsync(`${V1}/videos/jobs/${id}`);
}
export function getHistory(jobId?: number): Promise<GeneratedVideo[]> {
  return apiGetAsync(`${V1}/videos/history${jobId != null ? `?job_id=${jobId}` : ""}`);
}
export function videoDownloadUrl(id: number): string {
  return `${V1}/videos/${id}/download?token=${getToken() ?? ""}`;
}
export function deleteVideos(ids: number[]): Promise<{ removidos: number }> {
  return apiSend(`${V1}/videos/history/delete`, "POST", { ids });
}

export function videoZipUrl(ids: number[]): string {
  return `${V1}/videos/history/zip?ids=${ids.join(",")}&token=${getToken() ?? ""}`;
}

// Dispara o download do ZIP com um link direto (GET), no mesmo gesto do clique —
// assim o navegador não bloqueia como acontece com download via fetch/blob.
export function downloadVideoZip(ids: number[], nome = "videos.zip"): void {
  const a = document.createElement("a");
  a.href = videoZipUrl(ids);
  a.download = nome;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------- Upscaling (utilitário) ----------
export type Escala = 2 | 4;

export interface UpscaleJob {
  id: number;
  status: "fila" | "processando" | "concluido" | "erro";
  escala: number;
  total: number;
  concluidos: number;
  erro: string | null;
  criado_em: string;
}

export interface UpscaledImage {
  id: number;
  job_id: number | null;
  caminho: string;
  nome_original: string;
  escala: number;
  largura: number;
  altura: number;
  tamanho_bytes: number;
  criado_em: string;
}

export async function upscaleUpload(files: File[], escala: Escala): Promise<UpscaleJob> {
  const form = new FormData();
  for (const f of files) form.append("files", f);
  const r = await fetch(`${V1}/upscale/upload?escala=${escala}`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
  return jsonOrThrow(r);
}

export function upscaleFromMedia(media_ids: number[], escala: Escala): Promise<UpscaleJob> {
  return apiSend(`${V1}/upscale/from-media`, "POST", { media_ids, escala });
}

export function getUpscaleJob(id: number): Promise<UpscaleJob> {
  return apiGetAsync(`${V1}/upscale/jobs/${id}`);
}

export function getUpscaleHistory(jobId?: number): Promise<UpscaledImage[]> {
  return apiGetAsync(`${V1}/upscale/history${jobId != null ? `?job_id=${jobId}` : ""}`);
}

export function upscaledDownloadUrl(id: number): string {
  return `${V1}/upscale/${id}/download?token=${getToken() ?? ""}`;
}

export function deleteUpscaled(ids: number[]): Promise<{ removidos: number }> {
  return apiSend(`${V1}/upscale/history/delete`, "POST", { ids });
}

export function upscaleZipUrl(ids: number[]): string {
  return `${V1}/upscale/history/zip?ids=${ids.join(",")}&token=${getToken() ?? ""}`;
}

// Dispara o download do ZIP com um link direto (GET), no mesmo gesto do clique —
// assim o navegador não bloqueia como acontece com download via fetch/blob.
export function downloadUpscaleZip(ids: number[], nome = "upscaled.zip"): void {
  const a = document.createElement("a");
  a.href = upscaleZipUrl(ids);
  a.download = nome;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ---------- Publicação (multicontas) ----------
const PUB = `${V1}/publishing`;

export interface Proxy {
  id: number;
  nome: string;
  protocolo: string;
  host: string;
  porta: number;
  usuario: string | null;
  status: "verde" | "amarelo" | "vermelho" | "cinza";
  latencia_ms: number | null;
  ip_publico: string | null;
  ultimo_check_em: string | null;
  ultimo_erro: string | null;
  criado_em: string;
}

export function listProxies(): Promise<Proxy[]> {
  return apiGetAsync(`${PUB}/proxies`);
}
export function createProxy(body: {
  nome: string;
  host: string;
  porta: number;
  protocolo?: string;
  usuario?: string;
  senha?: string;
}): Promise<Proxy> {
  return apiSend(`${PUB}/proxies`, "POST", body);
}
export function deleteProxy(id: number): Promise<void> {
  return apiSend(`${PUB}/proxies/${id}`, "DELETE");
}
export function checkProxy(id: number): Promise<Proxy> {
  return apiSend(`${PUB}/proxies/${id}/check`, "POST");
}

export type AccountStatus = "rascunho" | "conectando" | "pronta" | "pausada" | "erro";

export interface PubAccount {
  id: number;
  nome_interno: string;
  username: string;
  platform: string;
  status: AccountStatus;
  senha_configurada: boolean;
  session_configurada: boolean;
  proxy_id: number | null;
  posts_por_hora: number | null;
  janela_inicio: string | null;
  janela_fim: string | null;
  timezone: string | null;
  caption_mode: "manual" | "automatica";
  audio_mode: "manual" | "automatica" | "nenhum";
  stories_enabled: boolean;
  automation_status: "ociosa" | "pausada" | "erro";
  ultimo_acesso_em: string | null;
  ultimo_post_em: string | null;
  ultimo_erro: string | null;
  criado_em: string;
  proxy: { id: number; nome: string; status: string } | null;
}

export interface AccountBody {
  nome_interno: string;
  username: string;
  platform?: string;
  // texto puro só na ida — o backend criptografa antes de salvar e nunca devolve.
  senha?: string;
  proxy_id?: number | null;
  posts_por_hora?: number | null;
  janela_inicio?: string | null;
  janela_fim?: string | null;
  timezone?: string | null;
  caption_mode?: "manual" | "automatica";
  audio_mode?: "manual" | "automatica" | "nenhum";
  stories_enabled?: boolean;
}

export function listAccounts(): Promise<PubAccount[]> {
  return apiGetAsync(`${PUB}/accounts`);
}
export function connectAccount(id: number, verificationCode?: string): Promise<PubAccount> {
  return apiSend(`${PUB}/accounts/${id}/connect`, "POST", verificationCode ? { verification_code: verificationCode } : {});
}
export function verifyAccountSession(id: number): Promise<{ valida: boolean; motivo: string | null }> {
  return apiSend(`${PUB}/accounts/${id}/verify-session`, "POST");
}
export function createAccount(body: AccountBody): Promise<PubAccount> {
  return apiSend(`${PUB}/accounts`, "POST", body);
}
export function updateAccount(id: number, body: Partial<AccountBody>): Promise<PubAccount> {
  return apiSend(`${PUB}/accounts/${id}`, "PATCH", body);
}
export function deleteAccount(id: number): Promise<void> {
  return apiSend(`${PUB}/accounts/${id}`, "DELETE");
}
export function markAccountReady(id: number): Promise<PubAccount> {
  return apiSend(`${PUB}/accounts/${id}/ready`, "POST");
}
export function pauseAccount(id: number): Promise<PubAccount> {
  return apiSend(`${PUB}/accounts/${id}/pause`, "POST");
}
export function resumeAccount(id: number): Promise<PubAccount> {
  return apiSend(`${PUB}/accounts/${id}/resume`, "POST");
}

export interface PublishingDefaults {
  posts_por_hora: number;
  janela_inicio: string;
  janela_fim: string;
  timezone: string;
  trending_enabled?: boolean;
  ultima_coleta_em?: string | null;
}
export function getPublishingDefaults(): Promise<PublishingDefaults> {
  return apiGetAsync(`${PUB}/defaults`);
}
export function updatePublishingDefaults(body: PublishingDefaults): Promise<PublishingDefaults> {
  return apiSend(`${PUB}/defaults`, "PUT", body);
}

export interface CaptionTemplate {
  id: number;
  titulo: string;
  texto: string;
  ativo: boolean;
  account_id: number | null;
  criado_em: string;
}
export function listCaptions(): Promise<CaptionTemplate[]> {
  return apiGetAsync(`${PUB}/captions`);
}
export function createCaption(titulo: string, texto: string, account_id?: number | null): Promise<CaptionTemplate> {
  return apiSend(`${PUB}/captions`, "POST", { titulo, texto, account_id: account_id ?? null });
}
export function updateCaption(id: number, body: Partial<{ titulo: string; texto: string; ativo: boolean }>): Promise<CaptionTemplate> {
  return apiSend(`${PUB}/captions/${id}`, "PATCH", body);
}
export function deleteCaption(id: number): Promise<void> {
  return apiSend(`${PUB}/captions/${id}`, "DELETE");
}

export interface StoryConfig {
  id: number;
  account_id: number;
  enabled: boolean;
  imagem_media_id: number | null;
  texto: string | null;
  link: string | null;
  horario: string;
  ultima_geracao_em: string | null;
  plans: StoryPlanOut[];
}
export interface StoryPlanOut {
  id: number;
  horario: string;
  ordem: number;
  media_ids: number[];
  texto: string | null;
  link: string | null;
  ultima_geracao_em: string | null;
}
export function getStoryConfig(accountId: number): Promise<StoryConfig> {
  return apiGetAsync(`${PUB}/accounts/${accountId}/story-config`);
}
export function updateStoryConfig(
  accountId: number,
  body: {
    enabled: boolean;
    imagem_media_id?: number | null;
    texto?: string | null;
    link?: string | null;
    horario?: string;
    plans?: { horario: string; frames: { media_id: number; texto?: string | null; link?: string | null }[] }[];
  }
): Promise<StoryConfig> {
  return apiSend(`${PUB}/accounts/${accountId}/story-config`, "PUT", body);
}

export type ApprovalStatus = "pendente" | "aprovado" | "rejeitado";

export interface PubContent {
  id: number;
  kind: "reel" | "story";
  origem: "manual" | "gerador";
  generated_video_id: number | null;
  caminho: string;
  duracao: number | null;
  legenda: string | null;
  audio_id: number | null;
  account_id: number | null;
  approval_status: ApprovalStatus;
  schedule_mode: "automatico" | "especifico";
  scheduled_at: string | null;
  criado_em: string;
}

export interface ImportableVideo {
  id: number;
  job_id: number | null;
  caminho: string;
  duracao: number | null;
  legenda: string | null;
  criado_em: string;
}

export function listImportable(): Promise<ImportableVideo[]> {
  return apiGetAsync(`${PUB}/content/importable`);
}
export function importFromGenerator(generated_video_ids: number[], auto_distribute = true): Promise<PubContent[]> {
  return apiSend(`${PUB}/content`, "POST", { generated_video_ids, auto_distribute });
}
export function listContent(approval_status?: ApprovalStatus): Promise<PubContent[]> {
  const q = approval_status ? `?approval_status=${approval_status}` : "";
  return apiGetAsync(`${PUB}/content${q}`);
}
export function editContent(
  id: number,
  body: Partial<{ legenda: string | null; account_id: number | null; audio_id: number | null }>
): Promise<PubContent> {
  return apiSend(`${PUB}/content/${id}`, "PATCH", body);
}
export function approveContent(ids: number[]): Promise<PubContent[]> {
  return apiSend(`${PUB}/content/approve`, "POST", { ids });
}
export function rejectContent(ids: number[]): Promise<PubContent[]> {
  return apiSend(`${PUB}/content/reject`, "POST", { ids });
}
export function approveAllContent(): Promise<{ aprovados: number }> {
  return apiSend(`${PUB}/content/approve-all`, "POST");
}
export function rejectAllContent(): Promise<{ rejeitados: number }> {
  return apiSend(`${PUB}/content/reject-all`, "POST");
}
export function redistributeContent(id: number): Promise<PubContent> {
  return apiSend(`${PUB}/content/${id}/redistribute`, "POST");
}
export function scheduleContent(id: number, scheduled_at: string): Promise<PubPublication> {
  return apiSend(`${PUB}/content/${id}/schedule`, "POST", { scheduled_at });
}

export type PublicationStatus =
  | "PENDING"
  | "UPLOADING"
  | "PROCESSING"
  | "PUBLISHED"
  | "FAILED"
  | "RETRYING"
  | "CANCELLED";

export interface PubPublication {
  id: number;
  content_id: number;
  account_id: number;
  status: PublicationStatus;
  tentativas: number;
  scheduled_at: string;
  iniciado_em: string | null;
  confirmado_em: string | null;
  falhou_em: string | null;
  erro: string | null;
}

export interface CalendarItem {
  publication_id: number;
  content_id: number;
  account_id: number;
  account_username: string;
  kind: "reel" | "story";
  status: PublicationStatus;
  scheduled_at: string;
  caminho: string;
}
export function getCalendar(start: string, end: string): Promise<CalendarItem[]> {
  const q = new URLSearchParams({ start, end });
  return apiGetAsync(`${PUB}/calendar?${q}`);
}
export function listPublications(params?: { account_id?: number; status?: PublicationStatus }): Promise<PubPublication[]> {
  const q = new URLSearchParams();
  if (params?.account_id != null) q.set("account_id", String(params.account_id));
  if (params?.status) q.set("status", params.status);
  const qs = q.toString();
  return apiGetAsync(`${PUB}/publications${qs ? `?${qs}` : ""}`);
}
export function reschedulePublication(id: number, scheduled_at: string): Promise<PubPublication> {
  return apiSend(`${PUB}/publications/${id}/reschedule`, "PATCH", { scheduled_at });
}

export interface AccountErrorOut {
  account_id: number;
  username: string;
  erro: string;
  em: string | null;
}

export interface PubDashboard {
  aguardando_aprovacao: number;
  aprovados: number;
  agendados_hoje: number;
  publicados_hoje: number;
  falhas_hoje: number;
  contas_ativas: number;
  contas_total: number;
  proxies_ativos: number;
  proxies_inativos: number;
  proxies_total: number;
  stories_hoje: number;
  stories_configuradas: number;
  sessoes_validas: number;
  sessoes_expiradas: number;
  em_execucao: number;
  retries: number;
  ultimos_erros: AccountErrorOut[];
}
export function getPubDashboard(): Promise<PubDashboard> {
  return apiGetAsync(`${PUB}/dashboard`);
}

export interface TrendingAudio {
  id: number;
  nome: string;
  provider: string;
  platform: string;
  external_id: string | null;
  referencia: string | null;
  popularidade: number | null;
  status: string;
  coletado_em: string;
}
export function listAudio(): Promise<TrendingAudio[]> {
  return apiGetAsync(`${PUB}/audio`);
}
export function collectTrendingAudio(): Promise<TrendingAudio[]> {
  return apiSend(`${PUB}/audio/collect`, "POST");
}

export interface TimelineItem {
  horario: string;
  account_username: string;
  status: PublicationStatus;
  kind: "reel" | "story";
}
export function getTimeline(limit = 30): Promise<TimelineItem[]> {
  return apiGetAsync(`${PUB}/timeline?limit=${limit}`);
}

export interface PubLog {
  id: number;
  account_id: number | null;
  publication_id: number | null;
  nivel: "info" | "aviso" | "erro";
  mensagem: string;
  criado_em: string;
}
export function getLogs(params?: { account_id?: number; publication_id?: number }): Promise<PubLog[]> {
  const q = new URLSearchParams();
  if (params?.account_id != null) q.set("account_id", String(params.account_id));
  if (params?.publication_id != null) q.set("publication_id", String(params.publication_id));
  const qs = q.toString();
  return apiGetAsync(`${PUB}/logs${qs ? `?${qs}` : ""}`);
}
