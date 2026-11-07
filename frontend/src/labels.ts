/** Textos em português para valores que vêm do servidor em código (status etc.).
 * Um lugar só: a mesma coisa tem sempre o mesmo nome em todas as telas. */

export const PUB_STATUS_LABEL: Record<string, string> = {
  PENDING: "Agendado",
  UPLOADING: "Enviando",
  PROCESSING: "Processando",
  PUBLISHED: "Publicado",
  FAILED: "Falhou",
  RETRYING: "Tentando de novo",
  CANCELLED: "Cancelado",
};

export const JOB_STATUS_LABEL: Record<string, string> = {
  fila: "Na fila",
  processando: "Gerando",
  concluido: "Concluído",
  erro: "Erro",
};

export const KIND_LABEL: Record<string, string> = {
  story: "Story",
  reel: "Reels",
};

export const pubStatus = (s: string) => PUB_STATUS_LABEL[s] ?? s;
