import { useEffect, useRef, useState } from "react";
import {
  deleteMedia,
  downloadUrl,
  listMedia,
  uploadMedia,
  type Media,
  type MediaType,
} from "./api";

const TABS: { tipo: MediaType; label: string; accept: string }[] = [
  { tipo: "video", label: "🎬 Vídeos", accept: "video/*" },
  { tipo: "photo", label: "🖼️ Fotos", accept: "image/*" },
  { tipo: "photo_hot", label: "🔥 Fotos hot", accept: "image/*" },
  { tipo: "music", label: "🎵 Músicas", accept: "audio/*" },
];

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function MediaLibrary() {
  const [tab, setTab] = useState<MediaType>("video");
  const [items, setItems] = useState<Media[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const current = TABS.find((t) => t.tipo === tab)!;

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setItems(await listMedia(tab));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        await uploadMedia(tab, file);
      }
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function onDelete(id: number) {
    if (!confirm("Remover esta mídia?")) return;
    await deleteMedia(id);
    await refresh();
  }

  return (
    <>
      <p className="sub">Os metadados são removidos automaticamente no upload.</p>

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.tipo}
            className={t.tipo === tab ? "tab active" : "tab"}
            onClick={() => setTab(t.tipo)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="uploader">
        <div className="uploader-label">
          📤 Enviando: <strong>{current.label}</strong>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept={current.accept}
          multiple
          onChange={(e) => onFiles(e.target.files)}
        />
        <span className="hint">
          Pode selecionar vários de uma vez. Para enviar outro tipo, troque a aba acima
          (Vídeos / Fotos hot / Músicas).
        </span>
      </div>

      {error && <div className="error">⚠️ {error}</div>}
      {loading && <div className="loading">Processando…</div>}

      <ul className="list">
        {items.map((m) => (
          <li key={m.id} className="card">
            <div className="card-main">
              <strong>{m.nome_original}</strong>
              <div className="meta">
                {formatSize(m.tamanho_bytes)}
                {m.duracao != null && <> · {m.duracao}s</>}
                {m.metadados_removidos && (
                  <>
                    {" "}
                    · <span className="badge">metadados removidos</span>
                  </>
                )}
              </div>
            </div>
            <div className="card-actions">
              <a href={downloadUrl(m.id)} className="btn">
                Baixar
              </a>
              <button className="btn danger" onClick={() => onDelete(m.id)}>
                Excluir
              </button>
            </div>
          </li>
        ))}
        {!loading && items.length === 0 && <li className="empty">Nenhuma mídia ainda.</li>}
      </ul>
    </>
  );
}
