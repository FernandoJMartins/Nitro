import { useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog, NameDialog } from "./Dialog";
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

/* Zona de arrastar-e-soltar (substitui o input de arquivo cru). */
function Dropzone({
  label,
  accept,
  disabled,
  onFiles,
}: {
  label: string;
  accept: string;
  disabled?: boolean;
  onFiles: (files: FileList | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  return (
    <div
      className={over ? "dropzone over" : "dropzone"}
      role="button"
      tabIndex={0}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (!disabled) onFiles(e.dataTransfer.files);
      }}
    >
      <div className="dropzone-icon">📤</div>
      <div className="dropzone-label">{label}</div>
      <div className="dropzone-hint">Arraste os arquivos aqui ou clique para escolher</div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple
        hidden
        onChange={(e) => onFiles(e.target.files)}
      />
    </div>
  );
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

type Dialog =
  | { kind: "criar" }
  | { kind: "renomear"; folder: Folder }
  | { kind: "apagar"; folder: Folder }
  | null;

export default function MediaLibrary() {
  const [view, setView] = useState<"pastas" | "musicas">("pastas");
  const [folders, setFolders] = useState<Folder[]>([]);
  const [openFolder, setOpenFolder] = useState<Folder | null>(null);
  const [subtab, setSubtab] = useState<MediaType>("video");
  const [items, setItems] = useState<Media[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busca, setBusca] = useState("");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [counts, setCounts] = useState<Partial<Record<MediaType, number>>>({});

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

  // contagem de itens por sub-aba da pasta aberta (badge nas abas)
  async function loadCounts(folder: Folder) {
    try {
      const results = await Promise.all(SUBTABS.map((s) => listMedia(s.tipo, folder.id)));
      const c: Partial<Record<MediaType, number>> = {};
      SUBTABS.forEach((s, i) => (c[s.tipo] = results[i].length));
      setCounts(c);
    } catch {
      /* contagem é só enfeite; ignora erro */
    }
  }

  useEffect(() => {
    if (view === "pastas" && openFolder) loadCounts(openFolder);
    else setCounts({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, openFolder]);

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const tipo: MediaType = view === "musicas" ? "music" : subtab;
    const folderId = view === "musicas" ? null : openFolder?.id ?? null;
    setLoading(true);
    setError(null);
    try {
      for (const file of Array.from(files)) await uploadMedia(tipo, file, folderId);
      await loadItems();
      if (openFolder) loadCounts(openFolder);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function criarPasta(nome: string) {
    try {
      const f = await createFolder(nome);
      setDialog(null);
      await loadFolders();
      setOpenFolder(f);
      setSubtab("video");
    } catch (e) {
      setError(String(e));
    }
  }

  async function confirmarRenomear(f: Folder, nome: string) {
    try {
      const atualizada = await renameFolder(f.id, nome);
      setDialog(null);
      await loadFolders();
      if (openFolder?.id === f.id) setOpenFolder(atualizada);
    } catch (e) {
      setError(String(e));
    }
  }

  async function confirmarApagar(f: Folder) {
    try {
      await deleteFolder(f.id);
      setDialog(null);
      if (openFolder?.id === f.id) setOpenFolder(null);
      await loadFolders();
    } catch (e) {
      setError(String(e));
    }
  }

  const nomes = useMemo(() => folders.map((f) => f.nome), [folders]);
  const filtradas = useMemo(() => {
    const q = busca.trim().toLowerCase();
    if (!q) return folders;
    return folders.filter((f) => f.nome.toLowerCase().includes(q));
  }, [folders, busca]);

  const currentAccept = view === "musicas" ? "audio/*" : SUBTABS.find((s) => s.tipo === subtab)!.accept;

  return (
    <>
      {/* alterna entre Pastas e Músicas */}
      <div className="folderbar">
        <button
          className={view === "pastas" ? "fchip active" : "fchip"}
          onClick={() => setView("pastas")}
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

      {error && (
        <div className="error">
          ⚠️ {error}
          <button className="error-x" aria-label="Fechar" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}

      {/* ---------- MÚSICAS ---------- */}
      {view === "musicas" && (
        <>
          <p className="sub">Músicas ficam disponíveis para todos os vídeos. Metadados removidos no upload.</p>
          <Dropzone label="Enviar música (.mp3, .wav…)" accept="audio/*" onFiles={onFiles} />
          {loading && <div className="loading">Processando…</div>}
          <ul className="grid">
            {items.map((m) => (
              <MediaCard
                key={m.id}
                m={m}
                onDelete={async () => {
                  await deleteMedia(m.id);
                  await loadItems();
                }}
              />
            ))}
            {!loading && items.length === 0 && <li className="empty">Nenhuma música ainda.</li>}
          </ul>
        </>
      )}

      {/* ---------- PASTAS: lista ---------- */}
      {view === "pastas" && !openFolder && (
        <>
          <div className="folders-toolbar">
            <p className="sub">Cada pasta guarda vídeos, fotos e fotos hot de um mesmo projeto/tema.</p>
            <button className="btn primary" onClick={() => setDialog({ kind: "criar" })}>
              ＋ Nova pasta
            </button>
          </div>

          {folders.length > 8 && (
            <input
              className="folder-search"
              type="search"
              placeholder="🔎 Buscar pasta…"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
            />
          )}

          {folders.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">📂</div>
              <p>Nenhuma pasta ainda.</p>
              <button className="btn primary" onClick={() => setDialog({ kind: "criar" })}>
                ＋ Criar primeira pasta
              </button>
            </div>
          ) : filtradas.length === 0 ? (
            <div className="empty">Nenhuma pasta encontrada para “{busca}”.</div>
          ) : (
            <div className="folder-grid">
              {filtradas.map((f) => (
                <div
                  key={f.id}
                  className="folder-card"
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    setOpenFolder(f);
                    setSubtab("video");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setOpenFolder(f);
                      setSubtab("video");
                    }
                  }}
                >
                  <div className="folder-icon">📁</div>
                  <div className="folder-name" title={f.nome}>
                    {f.nome}
                  </div>
                  <div className="folder-actions">
                    <button
                      type="button"
                      className="folder-act"
                      title="Renomear pasta"
                      aria-label={`Renomear ${f.nome}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setDialog({ kind: "renomear", folder: f });
                      }}
                    >
                      ✏️
                    </button>
                    <button
                      type="button"
                      className="folder-act danger"
                      title="Apagar pasta"
                      aria-label={`Apagar ${f.nome}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setDialog({ kind: "apagar", folder: f });
                      }}
                    >
                      🗑️
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ---------- PASTAS: dentro de uma pasta ---------- */}
      {view === "pastas" && openFolder && (
        <>
          <div className="folder-head">
            <nav className="crumbs">
              <button className="crumb-link" onClick={() => setOpenFolder(null)}>
                📁 Pastas
              </button>
              <span className="crumb-sep">›</span>
              <span className="crumb-current">{openFolder.nome}</span>
            </nav>
            <button
              className="btn sm ghost"
              title="Renomear pasta"
              onClick={() => setDialog({ kind: "renomear", folder: openFolder })}
            >
              ✏️ Renomear
            </button>
          </div>

          <nav className="tabs">
            {SUBTABS.map((s) => {
              const n = counts[s.tipo];
              return (
                <button
                  key={s.tipo}
                  className={s.tipo === subtab ? "tab active" : "tab"}
                  onClick={() => setSubtab(s.tipo)}
                >
                  {s.label}
                  {n != null && n > 0 && <span className="tab-count">{n}</span>}
                </button>
              );
            })}
          </nav>

          <Dropzone
            label={`Enviar ${SUBTABS.find((s) => s.tipo === subtab)!.label} para ${openFolder.nome}`}
            accept={currentAccept}
            onFiles={onFiles}
          />

          {loading && <div className="loading">Processando…</div>}
          <ul className="grid">
            {items.map((m) => (
              <MediaCard
                key={m.id}
                m={m}
                onDelete={async () => {
                  await deleteMedia(m.id);
                  await loadItems();
                }}
              />
            ))}
            {!loading && items.length === 0 && <li className="empty">Nada aqui ainda. Envie acima.</li>}
          </ul>
        </>
      )}

      {/* ---------- Modais ---------- */}
      {dialog?.kind === "criar" && (
        <NameDialog
          title="Nova pasta"
          initial=""
          confirmLabel="Criar pasta"
          placeholder="Ex.: Campanha de verão"
          taken={nomes}
          onConfirm={criarPasta}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "renomear" && (
        <NameDialog
          title="Renomear pasta"
          initial={dialog.folder.nome}
          confirmLabel="Salvar"
          placeholder="Nome da pasta"
          taken={nomes}
          onConfirm={(nome) => confirmarRenomear(dialog.folder, nome)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "apagar" && (
        <ConfirmDialog
          title="Apagar pasta"
          confirmLabel="Apagar pasta"
          message={
            <>
              Apagar a pasta <strong>{dialog.folder.nome}</strong>? As mídias dela <strong>não</strong>{" "}
              são apagadas — apenas saem da pasta.
            </>
          }
          onConfirm={() => confirmarApagar(dialog.folder)}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}
