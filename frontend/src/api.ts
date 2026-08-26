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
export type MediaType = "video" | "photo" | "photo_hot" | "music";

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

export interface BulkBody {
  quantidade: number;
  base_media_ids: number[];
  music_media_ids: number[];
  hot_media_ids: number[];
  phrase_type_id: number | null;
  use_ia_texto: boolean;
  gerar_legenda_ia: boolean;
  duration_min: number;
  duration_max: number;
  use_flash: boolean;
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
