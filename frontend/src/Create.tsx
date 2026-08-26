import { useEffect, useRef, useState } from "react";
import {
  bulkGenerate,
  downloadUrl,
  getHistory,
  getJob,
  listFolders,
  listMedia,
  listPhraseTypes,
  videoDownloadUrl,
  type Folder,
  type GeneratedVideo,
  type Job,
  type Media,
  type PhraseType,
} from "./api";

function ItemThumb({ m }: { m: Media }) {
  const src = downloadUrl(m.id);
  if (m.tipo === "video") return <video className="mini-thumb" src={src} preload="metadata" muted />;
  return <img className="mini-thumb" src={src} alt="" />;
}

// Seletor: uma pasta -> "pasta inteira" ou "escolher itens"
function FolderPicker({
  label,
  folders,
  folderId,
  setFolderId,
  mode,
  setMode,
  items,
  sel,
  toggle,
}: {
  label: string;
  folders: Folder[];
  folderId: number | null;
  setFolderId: (id: number | null) => void;
  mode: "whole" | "items";
  setMode: (m: "whole" | "items") => void;
  items: Media[];
  sel: Set<number>;
  toggle: (id: number) => void;
}) {
  return (
    <div className="field">
      <span>{label}</span>
      <select value={folderId ?? ""} onChange={(e) => setFolderId(e.target.value ? Number(e.target.value) : null)}>
        <option value="">— escolha uma pasta —</option>
        {folders.map((f) => (
          <option key={f.id} value={f.id}>
            📁 {f.nome}
          </option>
        ))}
      </select>

      {folderId != null && (
        <>
          <div className="mode-row">
            <label className={mode === "whole" ? "moderb active" : "moderb"}>
              <input type="radio" checked={mode === "whole"} onChange={() => setMode("whole")} /> Pasta inteira ({items.length})
            </label>
            <label className={mode === "items" ? "moderb active" : "moderb"}>
              <input type="radio" checked={mode === "items"} onChange={() => setMode("items")} /> Escolher itens
            </label>
          </div>

          {mode === "items" && (
            <div className="checklist">
              {items.map((m) => (
                <label key={m.id} className={sel.has(m.id) ? "chk picked" : "chk"}>
                  <input type="checkbox" checked={sel.has(m.id)} onChange={() => toggle(m.id)} />
                  <ItemThumb m={m} />
                  <span className="chk-name">{m.nome_original}</span>
                </label>
              ))}
              {items.length === 0 && <div className="hint">Pasta vazia deste tipo.</div>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function Create() {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [musics, setMusics] = useState<Media[]>([]);
  const [types, setTypes] = useState<PhraseType[]>([]);

  // base (vídeos + fotos de uma pasta)
  const [baseFolderId, setBaseFolderId] = useState<number | null>(null);
  const [baseMode, setBaseMode] = useState<"whole" | "items">("whole");
  const [baseItems, setBaseItems] = useState<Media[]>([]);
  const [baseSel, setBaseSel] = useState<Set<number>>(new Set());

  // hot (fotos hot de uma pasta)
  const [hotFolderId, setHotFolderId] = useState<number | null>(null);
  const [hotMode, setHotMode] = useState<"whole" | "items">("whole");
  const [hotItems, setHotItems] = useState<Media[]>([]);
  const [hotSel, setHotSel] = useState<Set<number>>(new Set());

  const [musicSel, setMusicSel] = useState<Set<number>>(new Set());
  const [quantidade, setQuantidade] = useState(5);
  const [durMin, setDurMin] = useState(5);
  const [durMax, setDurMax] = useState(15);
  const [typeId, setTypeId] = useState<number | null>(null);
  const [useIaTexto, setUseIaTexto] = useState(false);
  const [legendaIa, setLegendaIa] = useState(false);
  const [useFlash, setUseFlash] = useState(false);

  const [job, setJob] = useState<Job | null>(null);
  const [results, setResults] = useState<GeneratedVideo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [fs, m, t] = await Promise.all([listFolders(), listMedia("music"), listPhraseTypes()]);
        setFolders(fs);
        setMusics(m);
        setTypes(t);
      } catch (e) {
        setError(String(e));
      }
    })();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // carrega itens da pasta base (vídeos + fotos)
  useEffect(() => {
    setBaseSel(new Set());
    if (baseFolderId == null) return setBaseItems([]);
    Promise.all([listMedia("video", baseFolderId), listMedia("photo", baseFolderId)])
      .then(([v, p]) => setBaseItems([...v, ...p]))
      .catch((e) => setError(String(e)));
  }, [baseFolderId]);

  // carrega fotos hot da pasta hot
  useEffect(() => {
    setHotSel(new Set());
    if (hotFolderId == null) return setHotItems([]);
    listMedia("photo_hot", hotFolderId)
      .then(setHotItems)
      .catch((e) => setError(String(e)));
  }, [hotFolderId]);

  function toggler(setter: React.Dispatch<React.SetStateAction<Set<number>>>) {
    return (id: number) =>
      setter((prev) => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
  }

  function resolveBaseIds(): number[] {
    return baseMode === "whole" ? baseItems.map((m) => m.id) : [...baseSel];
  }
  function resolveHotIds(): number[] {
    return hotMode === "whole" ? hotItems.map((m) => m.id) : [...hotSel];
  }

  async function onGenerate() {
    setError(null);
    const baseIds = resolveBaseIds();
    if (baseIds.length === 0) return setError("Escolha uma pasta base (ou itens dela) com vídeos/fotos.");
    const hotIds = useFlash ? resolveHotIds() : [];
    if (useFlash && hotIds.length === 0) return setError("Escolha uma pasta (ou itens) com fotos hot para o flash.");
    if (useIaTexto && typeId == null) return setError("Para IA de texto, escolha um tipo de frase.");

    setResults([]);
    try {
      const j = await bulkGenerate({
        quantidade,
        base_media_ids: baseIds,
        music_media_ids: [...musicSel],
        hot_media_ids: hotIds,
        phrase_type_id: typeId,
        use_ia_texto: useIaTexto,
        gerar_legenda_ia: legendaIa,
        duration_min: Math.min(durMin, durMax),
        duration_max: Math.max(durMin, durMax),
        use_flash: useFlash,
      });
      setJob(j);
      startPolling(j.id);
    } catch (e) {
      setError(String(e));
    }
  }

  function startPolling(jobId: number) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = window.setInterval(async () => {
      try {
        const j = await getJob(jobId);
        setJob(j);
        if (j.status === "concluido" || j.status === "erro") {
          if (pollRef.current) clearInterval(pollRef.current);
          setResults(await getHistory(jobId));
        }
      } catch {
        /* ignora */
      }
    }, 1000);
  }

  async function baixarTodos() {
    // dispara um download por vídeo; o navegador pede "permitir vários" só uma vez
    for (const v of results) {
      const a = document.createElement("a");
      a.href = videoDownloadUrl(v.id);
      a.download = `video_${v.id}.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  const running = job && (job.status === "fila" || job.status === "processando");

  if (folders.length === 0) {
    return (
      <div className="empty">
        Você ainda não tem pastas. Vá em <strong>Mídias → Pastas</strong>, crie uma pasta e envie vídeos/fotos.
      </div>
    );
  }

  return (
    <>
      <p className="sub">Gere vários vídeos de uma vez. Escolha uma pasta (inteira ou itens dela) como base.</p>
      {error && <div className="error">⚠️ {error}</div>}

      <div className="form">
        <FolderPicker
          label="Base — vídeos e fotos (sorteados por vídeo)"
          folders={folders}
          folderId={baseFolderId}
          setFolderId={setBaseFolderId}
          mode={baseMode}
          setMode={setBaseMode}
          items={baseItems}
          sel={baseSel}
          toggle={toggler(setBaseSel)}
        />

        <label className="field">
          <span>Músicas (universais, sorteadas por vídeo)</span>
          <div className="checklist">
            {musics.map((m) => (
              <label key={m.id} className={musicSel.has(m.id) ? "chk picked" : "chk"}>
                <input type="checkbox" checked={musicSel.has(m.id)} onChange={() => toggler(setMusicSel)(m.id)} />
                <span className="chk-name">🎵 {m.nome_original}</span>
              </label>
            ))}
            {musics.length === 0 && <div className="hint">Nenhuma música. Envie em Mídias → Músicas.</div>}
          </div>
        </label>

        <label className="field">
          <span>Textos no vídeo — tipo de frase</span>
          <select value={typeId ?? ""} onChange={(e) => setTypeId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">— nenhum (sem texto) —</option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.nome}
              </option>
            ))}
          </select>
        </label>

        <label className="field checkrow">
          <input type="checkbox" checked={useIaTexto} onChange={(e) => setUseIaTexto(e.target.checked)} />
          <span>Deixar a IA gerar os textos do vídeo (baseada na sua lista)</span>
        </label>
        <label className="field checkrow">
          <input type="checkbox" checked={legendaIa} onChange={(e) => setLegendaIa(e.target.checked)} />
          <span>Gerar legenda da postagem com IA (opcional)</span>
        </label>
        <label className="field checkrow">
          <input type="checkbox" checked={useFlash} onChange={(e) => setUseFlash(e.target.checked)} />
          <span>Inserir flash da imagem hot (subliminar, ~0,1s)</span>
        </label>

        {useFlash && (
          <FolderPicker
            label="Fotos hot do flash (sorteadas por vídeo)"
            folders={folders}
            folderId={hotFolderId}
            setFolderId={setHotFolderId}
            mode={hotMode}
            setMode={setHotMode}
            items={hotItems}
            sel={hotSel}
            toggle={toggler(setHotSel)}
          />
        )}

        <label className="field">
          <span>Quantidade de vídeos: {quantidade}</span>
          <input type="range" min={1} max={50} value={quantidade} onChange={(e) => setQuantidade(Number(e.target.value))} />
        </label>

        <div className="field">
          <span>
            Duração (sorteada): <strong>{Math.min(durMin, durMax)}–{Math.max(durMin, durMax)}s</strong>
          </span>
          <div className="range-row">
            <label>
              mín
              <input type="number" min={1} max={60} value={durMin} onChange={(e) => setDurMin(Number(e.target.value))} />
            </label>
            <label>
              máx
              <input type="number" min={1} max={60} value={durMax} onChange={(e) => setDurMax(Number(e.target.value))} />
            </label>
          </div>
        </div>

        <button className="btn primary big" onClick={onGenerate} disabled={!!running}>
          {running ? "Gerando…" : `🎬 Gerar ${quantidade} vídeos`}
        </button>
      </div>

      {job && (
        <div className="progress-box">
          <div>
            Lote #{job.id} — <strong>{job.status}</strong> · {job.concluidos}/{job.total}
          </div>
          <div className="bar">
            <div className="bar-fill" style={{ width: `${(job.concluidos / job.total) * 100}%` }} />
          </div>
          {job.erro && <div className="hint">⚠️ {job.erro}</div>}
        </div>
      )}

      {results.length > 0 && (
        <div className="results-head">
          <strong>{results.length} vídeo(s) gerado(s)</strong>
          <button className="btn primary" onClick={baixarTodos}>
            ⬇️ Baixar todos ({results.length})
          </button>
        </div>
      )}

      {results.length > 0 && (
        <ul className="grid">
          {results.map((v) => (
            <li key={v.id} className="vcard">
              <video src={videoDownloadUrl(v.id)} controls />
              <div className="vmeta">
                {v.texto && <div className="vtext">“{v.texto}”</div>}
                {v.usou_flash && <span className="badge">flash</span>}
                {v.legenda && <div className="vlegenda">📝 {v.legenda}</div>}
                <a href={videoDownloadUrl(v.id)} download className="btn sm">
                  Baixar .mp4
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
