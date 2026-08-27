import { useEffect, useRef, useState } from "react";
import {
  createFolder,
  deleteFolder,
  deleteMedia,
  downloadUrl,
  listFolders,
  listMedia,
  renameFolder,
  uploadMedia,
  type Folder,
  type Media,
  type MediaType,
} from "./api";

// tipos de mídia que vivem DENTRO de uma pasta
const SUBTABS: { tipo: MediaType; label: string; accept: string }[] = [
  { tipo: "video", label: "🎬 Vídeos", accept: "video/*" },
  { tipo: "photo", label: "🖼️ Fotos", accept: "image/*" },
  { tipo: "photo_hot", label: "🔥 Fotos hot", accept: "image/*" },
  { tipo: "overlay", label: "🏷️ Imagens estáticas", accept: "image/*" },
  { tipo: "final_clip", label: "🎞️ Clipes finais", accept: "image/*,video/*" },
];

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const VIDEO_RE = /\.(mp4|mov|mkv|webm|avi)$/i;

function Thumb({ m }: { m: Media }) {
  const src = downloadUrl(m.id);
  // 'final_clip' pode ser foto OU vídeo — decide pela extensão do arquivo.
  const isVideo = m.tipo === "video" || VIDEO_RE.test(m.caminho);
  if (isVideo) return <video className="thumb" src={src} preload="metadata" muted />;
  if (m.tipo === "music") return <div className="thumb thumb-music">🎵</div>;
  return <img className="thumb" src={src} alt={m.nome_original} />;
}

function MediaCard({ m, onDelete }: { m: Media; onDelete: () => void }) {
  return (
    <li className="vcard">
      <Thumb m={m} />
      <div className="vmeta">
        <strong className="vtext" title={m.nome_original}>
          {m.nome_original}
        </strong>
        <div className="meta">
          {formatSize(m.tamanho_bytes)}
          {m.duracao != null && <> · {m.duracao}s</>}
        </div>
        <div className="card-actions">
          <a href={downloadUrl(m.id)} className="btn sm" download>
            Baixar
          </a>
          <button
            className="btn danger sm"
            onClick={async () => {
              if (confirm("Remover esta mídia?")) onDelete();
            }}
          >
            Excluir
          </button>
        </div>
      </div>
    </li>
  );
}

export default function MediaLibrary() {
  const [view, setView] = useState<"pastas" | "musicas">("pastas");
  const [folders, setFolders] = useState<Folder[]>([]);
  const [openFolder, setOpenFolder] = useState<Folder | null>(null);
  const [subtab, setSubtab] = useState<MediaType>("video");
  const [items, setItems] = useState<Media[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function loadFolders() {
    try {
      setFolders(await listFolders());
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    loadFolders();
  }, []);

  // carrega o conteúdo atual (pasta+subtipo, ou músicas)
  async function loadItems() {
    setLoading(true);
    setError(null);
    try {
      if (view === "musicas") setItems(await listMedia("music"));
      else if (openFolder) setItems(await listMedia(subtab, openFolder.id));
      else setItems([]);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, openFolder, subtab]);

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const tipo: MediaType = view === "musicas" ? "music" : subtab;
    const folderId = view === "musicas" ? null : openFolder?.id ?? null;
    setLoading(true);
    setError(null);
    try {
      for (const file of Array.from(files)) await uploadMedia(tipo, file, folderId);
      await loadItems();
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function novaPasta() {
    const nome = window.prompt("Nome da nova pasta:");
    if (!nome?.trim()) return;
    try {
      const f = await createFolder(nome.trim());
      await loadFolders();
      setOpenFolder(f);
      setSubtab("video");
    } catch (e) {
      setError(String(e));
    }
  }

  async function removerPasta(f: Folder, ev: React.MouseEvent) {
    ev.stopPropagation();
    if (!window.confirm(`Apagar a pasta "${f.nome}"? As mídias dela não são apagadas, só saem da pasta.`)) return;
    await deleteFolder(f.id);
    if (openFolder?.id === f.id) setOpenFolder(null);
    await loadFolders();
  }

  async function renomearPasta(f: Folder, ev?: React.MouseEvent) {
    ev?.stopPropagation();
    const nome = window.prompt("Novo nome da pasta:", f.nome);
    if (nome == null) return; // cancelou
    const limpo = nome.trim();
    if (!limpo || limpo === f.nome) return;
    try {
      const atualizada = await renameFolder(f.id, limpo);
      await loadFolders();
      if (openFolder?.id === f.id) setOpenFolder(atualizada);
    } catch (e) {
      setError(String(e));
    }
  }

  const currentAccept = view === "musicas" ? "audio/*" : SUBTABS.find((s) => s.tipo === subtab)!.accept;

  return (
    <>
      {/* alterna entre Pastas e Músicas */}
      <div className="folderbar">
        <button
          className={view === "pastas" ? "fchip active" : "fchip"}
          onClick={() => {
            setView("pastas");
          }}
        >
          📁 Pastas
        </button>
        <button
          className={view === "musicas" ? "fchip active" : "fchip"}
          onClick={() => {
            setView("musicas");
            setOpenFolder(null);
          }}
        >
          🎵 Músicas (universais)
        </button>
      </div>

      {error && <div className="error">⚠️ {error}</div>}

      {/* ---------- MÚSICAS ---------- */}
      {view === "musicas" && (
        <>
          <p className="sub">Músicas ficam disponíveis para todos os vídeos. Metadados removidos no upload.</p>
          <div className="uploader">
            <div className="uploader-label">📤 Enviar música (.mp3, .wav…)</div>
            <input ref={fileRef} type="file" accept="audio/*" multiple onChange={(e) => onFiles(e.target.files)} />
          </div>
          {loading && <div className="loading">Processando…</div>}
          <ul className="grid">
            {items.map((m) => (
              <MediaCard key={m.id} m={m} onDelete={async () => {
                await deleteMedia(m.id);
                await loadItems();
              }} />
            ))}
            {!loading && items.length === 0 && <li className="empty">Nenhuma música ainda.</li>}
          </ul>
        </>
      )}

      {/* ---------- PASTAS: lista ---------- */}
      {view === "pastas" && !openFolder && (
        <>
          <p className="sub">Cada pasta guarda vídeos, fotos e fotos hot de um mesmo projeto/tema.</p>
          <div className="folder-grid">
            {folders.map((f) => (
              <button key={f.id} className="folder-card" onClick={() => { setOpenFolder(f); setSubtab("video"); }}>
                <div className="folder-icon">📁</div>
                <div className="folder-name">{f.nome}</div>
                <span className="folder-edit" title="Renomear pasta" onClick={(e) => renomearPasta(f, e)}>
                  ✏️
                </span>
                <span className="folder-del" title="Apagar pasta" onClick={(e) => removerPasta(f, e)}>
                  ×
                </span>
              </button>
            ))}
            <button className="folder-card new" onClick={novaPasta}>
              <div className="folder-icon">＋</div>
              <div className="folder-name">Nova pasta</div>
            </button>
          </div>
          {folders.length === 0 && <div className="empty">Crie uma pasta para começar a enviar mídias.</div>}
        </>
      )}

      {/* ---------- PASTAS: dentro de uma pasta ---------- */}
      {view === "pastas" && openFolder && (
        <>
          <div className="folder-head">
            <button className="btn sm" onClick={() => setOpenFolder(null)}>
              ← Pastas
            </button>
            <h2>📁 {openFolder.nome}</h2>
            <button className="btn sm" title="Renomear pasta" onClick={() => renomearPasta(openFolder)}>
              ✏️ Renomear
            </button>
          </div>

          <nav className="tabs">
            {SUBTABS.map((s) => (
              <button key={s.tipo} className={s.tipo === subtab ? "tab active" : "tab"} onClick={() => setSubtab(s.tipo)}>
                {s.label}
              </button>
            ))}
          </nav>

          <div className="uploader">
            <div className="uploader-label">
              📤 Enviar {SUBTABS.find((s) => s.tipo === subtab)!.label} para <strong>{openFolder.nome}</strong>
            </div>
            <input ref={fileRef} type="file" accept={currentAccept} multiple onChange={(e) => onFiles(e.target.files)} />
          </div>

          {loading && <div className="loading">Processando…</div>}
          <ul className="grid">
            {items.map((m) => (
              <MediaCard key={m.id} m={m} onDelete={async () => {
                await deleteMedia(m.id);
                await loadItems();
              }} />
            ))}
            {!loading && items.length === 0 && <li className="empty">Nada aqui ainda. Envie acima.</li>}
          </ul>
        </>
      )}
    </>
  );
}
