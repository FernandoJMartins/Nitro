import { useEffect, useRef, useState } from "react";
import {
  bulkGenerate,
  getHistory,
  getJob,
  listMedia,
  listPhraseTypes,
  videoDownloadUrl,
  type GeneratedVideo,
  type Job,
  type Media,
  type PhraseType,
} from "./api";

function Checklist({
  items,
  selected,
  onToggle,
  emoji,
}: {
  items: Media[];
  selected: Set<number>;
  onToggle: (id: number) => void;
  emoji: string;
}) {
  if (items.length === 0) return <div className="hint">Nenhuma mídia deste tipo. Envie na aba Mídias.</div>;
  return (
    <div className="checklist">
      {items.map((m) => (
        <label key={m.id} className={selected.has(m.id) ? "chk picked" : "chk"}>
          <input type="checkbox" checked={selected.has(m.id)} onChange={() => onToggle(m.id)} />
          {emoji} {m.nome_original}
        </label>
      ))}
    </div>
  );
}

export default function Create() {
  const [videos, setVideos] = useState<Media[]>([]);
  const [photos, setPhotos] = useState<Media[]>([]);
  const [hotPhotos, setHotPhotos] = useState<Media[]>([]);
  const [musics, setMusics] = useState<Media[]>([]);
  const [types, setTypes] = useState<PhraseType[]>([]);

  const [baseSel, setBaseSel] = useState<Set<number>>(new Set());
  const [musicSel, setMusicSel] = useState<Set<number>>(new Set());
  const [hotSel, setHotSel] = useState<Set<number>>(new Set());

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
        const [v, p, h, m, t] = await Promise.all([
          listMedia("video"),
          listMedia("photo"),
          listMedia("photo_hot"),
          listMedia("music"),
          listPhraseTypes(),
        ]);
        setVideos(v);
        setPhotos(p);
        setHotPhotos(h);
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

  const baseItems = [...videos, ...photos];

  function toggler(setter: React.Dispatch<React.SetStateAction<Set<number>>>) {
    return (id: number) =>
      setter((prev) => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
  }

  async function onGenerate() {
    setError(null);
    if (baseSel.size === 0) return setError("Selecione ao menos uma mídia base.");
    if (useFlash && hotSel.size === 0) return setError("Marque ao menos uma foto hot para o flash.");
    if (useIaTexto && typeId == null) return setError("Para IA de texto, escolha um tipo de frase de referência.");

    setResults([]);
    try {
      const j = await bulkGenerate({
        quantidade,
        base_media_ids: [...baseSel],
        music_media_ids: [...musicSel],
        hot_media_ids: useFlash ? [...hotSel] : [],
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

  const running = job && (job.status === "fila" || job.status === "processando");

  return (
    <>
      <p className="sub">Gere vários vídeos de uma vez. Mídia, música, frase e foto hot são sorteadas por vídeo.</p>

      {error && <div className="error">⚠️ {error}</div>}

      <div className="form">
        <div className="field">
          <span>Mídias base (vídeos e fotos normais) — sorteadas por vídeo</span>
          <Checklist items={baseItems} selected={baseSel} onToggle={toggler(setBaseSel)} emoji="📄" />
        </div>

        <div className="field">
          <span>Músicas (sorteadas por vídeo)</span>
          <Checklist items={musics} selected={musicSel} onToggle={toggler(setMusicSel)} emoji="🎵" />
        </div>

        <label className="field">
          <span>Textos no vídeo — tipo de frase (a lista vira o sorteio)</span>
          <select value={typeId ?? ""} onChange={(e) => setTypeId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">— nenhum (vídeos sem texto) —</option>
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
          <span>Inserir flash da imagem hot (1 frame subliminar)</span>
        </label>

        {useFlash && (
          <div className="field">
            <span>Fotos hot do flash (sorteadas por vídeo)</span>
            <Checklist items={hotPhotos} selected={hotSel} onToggle={toggler(setHotSel)} emoji="🔥" />
          </div>
        )}

        <label className="field">
          <span>Quantidade de vídeos: {quantidade}</span>
          <input type="range" min={1} max={50} value={quantidade} onChange={(e) => setQuantidade(Number(e.target.value))} />
        </label>

        <div className="field">
          <span>
            Duração de cada vídeo (sorteada no range): <strong>{Math.min(durMin, durMax)}–{Math.max(durMin, durMax)}s</strong>
          </span>
          <div className="range-row">
            <label>
              mín
              <input
                type="number"
                min={1}
                max={60}
                value={durMin}
                onChange={(e) => setDurMin(Number(e.target.value))}
              />
            </label>
            <label>
              máx
              <input
                type="number"
                min={1}
                max={60}
                value={durMax}
                onChange={(e) => setDurMax(Number(e.target.value))}
              />
            </label>
          </div>
          <span className="hint">Ex.: foto estática costuma ficar boa entre 5 e 15s.</span>
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
        <ul className="grid">
          {results.map((v) => (
            <li key={v.id} className="vcard">
              <video src={videoDownloadUrl(v.id)} controls />
              <div className="vmeta">
                {v.texto && <div className="vtext">“{v.texto}”</div>}
                {v.usou_flash && <span className="badge">flash</span>}
                {v.legenda && <div className="vlegenda">📝 {v.legenda}</div>}
                <a href={videoDownloadUrl(v.id)} download className="btn">
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
