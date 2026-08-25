export type MediaType = "video" | "photo" | "photo_hot" | "music";

export interface Media {
  id: number;
  tipo: MediaType;
  nome_original: string;
  caminho: string;
  duracao: number | null;
  tamanho_bytes: number;
  metadados_removidos: boolean;
  is_trending: boolean;
  observacao: string | null;
  criado_em: string;
}

const BASE = "/api/v1/media";

export async function listMedia(tipo: MediaType): Promise<Media[]> {
  const r = await fetch(`${BASE}?tipo=${tipo}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function uploadMedia(tipo: MediaType, file: File): Promise<Media> {
  const form = new FormData();
  form.append("file", file);
  // os endpoints têm o mesmo nome do tipo: /media/video, /photo, /photo_hot, /music
  const r = await fetch(`${BASE}/${tipo}`, { method: "POST", body: form });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || "Falha no upload");
  return r.json();
}

export async function deleteMedia(id: number): Promise<void> {
  const r = await fetch(`${BASE}/${id}`, { method: "DELETE" });
  if (!r.ok) throw new Error(await r.text());
}

export function downloadUrl(id: number): string {
  return `${BASE}/${id}/download`;
}

// ---------- Frases (Fase 2) ----------
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

async function jsonOrThrow(r: Response) {
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || (await r.text()) || "Erro");
  return r.status === 204 ? null : r.json();
}

export async function listPhraseTypes(): Promise<PhraseType[]> {
  return jsonOrThrow(await fetch(`${V1}/phrase-types`));
}

export async function createPhraseType(nome: string, descricao?: string): Promise<PhraseType> {
  return jsonOrThrow(
    await fetch(`${V1}/phrase-types`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nome, descricao }),
    })
  );
}

export async function deletePhraseType(id: number): Promise<void> {
  await jsonOrThrow(await fetch(`${V1}/phrase-types/${id}`, { method: "DELETE" }));
}

export async function listPhrases(tipoId: number): Promise<Phrase[]> {
  return jsonOrThrow(await fetch(`${V1}/phrases?tipo_id=${tipoId}`));
}

export async function createPhrase(phrase_type_id: number, texto: string): Promise<Phrase> {
  return jsonOrThrow(
    await fetch(`${V1}/phrases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phrase_type_id, texto }),
    })
  );
}

export async function deletePhrase(id: number): Promise<void> {
  await jsonOrThrow(await fetch(`${V1}/phrases/${id}`, { method: "DELETE" }));
}

export interface AIResult {
  frases: string[];
  modelo: string;
  baseado_em: number;
}

export async function generateAI(
  phrase_type_id: number,
  quantidade: number,
  instrucao_extra?: string
): Promise<AIResult> {
  return jsonOrThrow(
    await fetch(`${V1}/phrases/ai`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phrase_type_id, quantidade, instrucao_extra }),
    })
  );
}

export async function bulkSavePhrases(phrase_type_id: number, textos: string[]): Promise<Phrase[]> {
  return jsonOrThrow(
    await fetch(`${V1}/phrases/bulk-save`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phrase_type_id, textos, origem: "ia" }),
    })
  );
}

// ---------- Geração de vídeo (Fase 3 + 4) ----------
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

export async function generateVideo(body: GenerateBody): Promise<GenerateResult> {
  return jsonOrThrow(
    await fetch(`${V1}/videos/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

// ---------- Geração em massa (Fase 5) + Histórico (Fase 6) ----------
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

export async function bulkGenerate(body: BulkBody): Promise<Job> {
  return jsonOrThrow(
    await fetch(`${V1}/videos/bulk`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

export async function getJob(id: number): Promise<Job> {
  return jsonOrThrow(await fetch(`${V1}/videos/jobs/${id}`));
}

export async function getHistory(jobId?: number): Promise<GeneratedVideo[]> {
  const q = jobId != null ? `?job_id=${jobId}` : "";
  return jsonOrThrow(await fetch(`${V1}/videos/history${q}`));
}

export function videoDownloadUrl(id: number): string {
  return `${V1}/videos/${id}/download`;
}

export async function deleteVideos(ids: number[]): Promise<{ removidos: number }> {
  return jsonOrThrow(
    await fetch(`${V1}/videos/history/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    })
  );
}
