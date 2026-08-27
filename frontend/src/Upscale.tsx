import { useEffect, useMemo, useRef, useState } from "react";
import {
  deleteUpscaled,
  downloadUpscaleZip,
  downloadUrl,
  getUpscaleHistory,
  getUpscaleJob,
  listFolders,
  listMedia,
  upscaledDownloadUrl,
  upscaleFromMedia,
  upscaleUpload,
  type Escala,
  type Folder,
  type Media,
  type UpscaledImage,
} from "./api";

type SubTab = "ampliar" | "historico";
type Fonte = "upload" | "pasta";

/* ---------------- Histórico (agrupado por dia + lote) ---------------- */
type LoteGroup = { lote: number | null; imagens: UpscaledImage[] };
type DayGroup = { dia: string; total: number; lotes: LoteGroup[] };

function diaDe(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function groupByDayAndLote(items: UpscaledImage[]): DayGroup[] {
  const days: DayGroup[] = [];
  for (const v of items) {
    const dia = diaDe(v.criado_em);
    let day = days.find((d) => d.dia === dia);
    if (!day) {
      day = { dia, total: 0, lotes: [] };
      days.push(day);
    }
    day.total++;
    let lote = day.lotes.find((l) => l.lote === v.job_id);
    if (!lote) {
      lote = { lote: v.job_id, imagens: [] };
      day.lotes.push(lote);
    }
    lote.imagens.push(v);
  }
  for (const day of days) {
    day.lotes.sort((a, b) => {
      if (a.lote == null) return 1;
      if (b.lote == null) return -1;
      return b.lote - a.lote;
    });
  }
  return days;
}

function diaLabel(dia: string): string {
  const hoje = diaDe(new Date().toISOString());
  const ontem = diaDe(new Date(Date.now() - 86400000).toISOString());
  if (dia === hoje) return `Hoje · ${dia}`;
  if (dia === ontem) return `Ontem · ${dia}`;
  return dia;
}

async function baixarImagens(imagens: UpscaledImage[]) {
  for (const v of imagens) {
    const a = document.createElement("a");
    a.href = upscaledDownloadUrl(v.id);
    a.download = `upscaled_${v.escala}x_${v.nome_original}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    await new Promise((r) => setTimeout(r, 400));
  }
}

function HistoryView({ refreshKey }: { refreshKey: number }) {
  const [items, setItems] = useState<UpscaledImage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [filtro, setFiltro] = useState<"nenhum" | "data" | "lote">("nenhum");
  const [valor, setValor] = useState<string>("");

  function refresh() {
    getUpscaleHistory().then(setItems).catch((e) => setError(String(e)));
  }
  useEffect(() => {
    refresh();
  }, [refreshKey]);

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function apagarGrupo(rotulo: string, imagens: UpscaledImage[]) {
    if (!window.confirm(`Apagar TODAS as ${imagens.length} imagem(ns) de ${rotulo}?\n\nEsta ação não pode ser desfeita.`))
      return;
    try {
      await deleteUpscaled(imagens.map((v) => v.id));
      refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  const datas = useMemo(() => {
    const set: string[] = [];
    for (const v of items) {
      const dia = diaDe(v.criado_em);
      if (!set.includes(dia)) set.push(dia);
    }
    return set;
  }, [items]);

  const lotes = useMemo(() => {
    const set = new Set<number>();
    for (const v of items) if (v.job_id != null) set.add(v.job_id);
    return [...set].sort((a, b) => b - a);
  }, [items]);

  const filtrados = useMemo(() => {
    if (filtro === "nenhum" || !valor) return items;
    if (filtro === "lote") return items.filter((v) => String(v.job_id) === valor);
    return items.filter((v) => diaDe(v.criado_em) === valor);
  }, [items, filtro, valor]);

  const groups = groupByDayAndLote(filtrados);

  return (
    <>
      <p className="sub">Todas as imagens ampliadas, agrupadas por dia e por lote (do mais recente ao mais antigo).</p>

      <div className="hist-filtro">
        <label>
          Filtrar por:{" "}
          <select
            value={filtro}
            onChange={(e) => {
              setFiltro(e.target.value as "nenhum" | "data" | "lote");
              setValor("");
            }}
          >
            <option value="nenhum">Nenhum</option>
            <option value="data">Data</option>
            <option value="lote">Lote</option>
          </select>
        </label>
        {filtro === "data" && (
          <select value={valor} onChange={(e) => setValor(e.target.value)}>
            <option value="">Todas as datas</option>
            {datas.map((d) => (
              <option key={d} value={d}>
                {diaLabel(d)}
              </option>
            ))}
          </select>
        )}
        {filtro === "lote" && (
          <select value={valor} onChange={(e) => setValor(e.target.value)}>
            <option value="">Todos os lotes</option>
            {lotes.map((l) => (
              <option key={l} value={String(l)}>
                Lote #{l}
              </option>
            ))}
          </select>
        )}
      </div>

      {error && <div className="error">⚠️ {error}</div>}
      {items.length === 0 && !error && <div className="empty">Nenhuma imagem ampliada ainda.</div>}
      {items.length > 0 && filtrados.length === 0 && (
        <div className="empty">Nenhuma imagem encontrada para este filtro.</div>
      )}

      {selected.size > 0 && (
        <div className="selbar">
          <span>{selected.size} selecionada(s)</span>
          <button
            className="btn primary sm"
            onClick={() => baixarImagens(items.filter((v) => selected.has(v.id)))}
          >
            ⬇️ Baixar selecionadas ({selected.size})
          </button>
          <button className="btn sm" onClick={() => downloadUpscaleZip([...selected])}>
            🗜️ ZIP ({selected.size})
          </button>
          <button className="btn sm" onClick={() => setSelected(new Set())}>
            Limpar
          </button>
        </div>
      )}

      {groups.map((g) => (
        <section key={g.dia} className="day-group">
          <div className="day-header">
            <span>
              📅 {diaLabel(g.dia)} <span className="day-count">({g.total})</span>
            </span>
            <div className="day-actions">
              <button className="btn primary sm" onClick={() => baixarImagens(g.lotes.flatMap((l) => l.imagens))}>
                ⬇️ Baixar todas ({g.total})
              </button>
              <button
                className="btn sm"
                onClick={() =>
                  downloadUpscaleZip(
                    g.lotes.flatMap((l) => l.imagens).map((v) => v.id),
                    `upscaled_${g.dia.replace(/\//g, "-")}.zip`
                  )
                }
              >
                🗜️ ZIP ({g.total})
              </button>
              <button
                className="btn danger sm"
                onClick={() => apagarGrupo(`dia ${g.dia}`, g.lotes.flatMap((l) => l.imagens))}
              >
                🗑️ Apagar tudo
              </button>
            </div>
          </div>

          {g.lotes.map((lote) => (
            <div key={String(lote.lote)} className="lote-group">
              <div className="lote-header">
                <span>
                  {lote.lote != null ? `📦 Lote #${lote.lote}` : "📦 Sem lote"}{" "}
                  <span className="day-count">({lote.imagens.length})</span>
                </span>
                <div className="day-actions">
                  <button className="btn sm" onClick={() => baixarImagens(lote.imagens)}>
                    ⬇️ Baixar lote ({lote.imagens.length})
                  </button>
                  <button
                    className="btn sm"
                    onClick={() =>
                      downloadUpscaleZip(
                        lote.imagens.map((v) => v.id),
                        lote.lote != null ? `upscaled_lote_${lote.lote}.zip` : "upscaled.zip"
                      )
                    }
                  >
                    🗜️ ZIP ({lote.imagens.length})
                  </button>
                  <button
                    className="btn danger sm"
                    onClick={() =>
                      apagarGrupo(lote.lote != null ? `lote #${lote.lote}` : "imagens sem lote", lote.imagens)
                    }
                  >
                    🗑️ Apagar lote
                  </button>
                </div>
              </div>
              <ul className="grid">
                {lote.imagens.map((v) => (
                  <li key={v.id} className={"vcard" + (selected.has(v.id) ? " selected" : "")}>
                    <label className="vsel">
                      <input type="checkbox" checked={selected.has(v.id)} onChange={() => toggle(v.id)} />
                    </label>
                    <img className="thumb" src={upscaledDownloadUrl(v.id)} alt={v.nome_original} />
                    <div className="vmeta">
                      <strong className="vtext" title={v.nome_original}>
                        {v.nome_original}
                      </strong>
                      <div className="meta">
                        <span className="badge">{v.escala}x</span> · {v.largura}×{v.altura}
                        {v.job_id && <> · lote #{v.job_id}</>}
                      </div>
                      <a href={upscaledDownloadUrl(v.id)} download className="btn">
                        Baixar
                      </a>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      ))}
    </>
  );
}

/* ---------------- Ampliar (upload OU pasta) ---------------- */
function AmpliarView({ onConcluido }: { onConcluido: () => void }) {
  const [escala, setEscala] = useState<Escala>(2);
  const [fonte, setFonte] = useState<Fonte>("upload");
  const [error, setError] = useState<string | null>(null);
  const [progresso, setProgresso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // modo pasta
  const [folders, setFolders] = useState<Folder[]>([]);
  const [folderId, setFolderId] = useState<number | null>(null);
  const [fotos, setFotos] = useState<Media[]>([]);
  const [selFotos, setSelFotos] = useState<Set<number>>(new Set());

  useEffect(() => {
    listFolders().then(setFolders).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    setSelFotos(new Set());
    if (folderId == null) {
      setFotos([]);
      return;
    }
    listMedia("photo", folderId)
      .then((ms) => {
        setFotos(ms);
        setSelFotos(new Set(ms.map((m) => m.id))); // começa com todas marcadas
      })
      .catch((e) => setError(String(e)));
  }, [folderId]);

  function toggleFoto(id: number) {
    setSelFotos((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function acompanhar(jobId: number, total: number) {
    // faz polling do progresso até concluir/erro
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      let job;
      try {
        job = await getUpscaleJob(jobId);
      } catch {
        continue;
      }
      setProgresso(`Ampliando… ${job.concluidos}/${total}`);
      if (job.status === "concluido" || job.status === "erro") {
        if (job.status === "erro" && job.erro) setError(job.erro);
        setProgresso(job.status === "concluido" ? `Concluído: ${job.concluidos}/${total} ✅` : null);
        onConcluido();
        return;
      }
    }
  }

  async function iniciarUpload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setOcupado(true);
    setError(null);
    setProgresso("Enviando imagens…");
    try {
      const job = await upscaleUpload(Array.from(files), escala);
      await acompanhar(job.id, job.total);
    } catch (e) {
      setError(String(e));
      setProgresso(null);
    } finally {
      setOcupado(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function iniciarPasta() {
    const ids = [...selFotos];
    if (ids.length === 0) {
      setError("Selecione ao menos uma foto da pasta.");
      return;
    }
    setOcupado(true);
    setError(null);
    setProgresso("Preparando lote…");
    try {
      const job = await upscaleFromMedia(ids, escala);
      await acompanhar(job.id, job.total);
    } catch (e) {
      setError(String(e));
      setProgresso(null);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <>
      <p className="sub">
        Amplia imagens em massa usando reamostragem de alta qualidade (LANCZOS). Escolha a escala e a origem.
      </p>

      {/* escala */}
      <div className="folderbar">
        <button className={escala === 2 ? "fchip active" : "fchip"} onClick={() => setEscala(2)}>
          2× (dobro)
        </button>
        <button className={escala === 4 ? "fchip active" : "fchip"} onClick={() => setEscala(4)}>
          4× (quádruplo)
        </button>
      </div>

      {/* origem */}
      <nav className="tabs">
        <button className={fonte === "upload" ? "tab active" : "tab"} onClick={() => setFonte("upload")}>
          📤 Enviar imagens
        </button>
        <button className={fonte === "pasta" ? "tab active" : "tab"} onClick={() => setFonte("pasta")}>
          📁 Escolher pasta
        </button>
      </nav>

      {error && <div className="error">⚠️ {error}</div>}

      {fonte === "upload" && (
        <div className="uploader">
          <div className="uploader-label">📤 Jogue as imagens aqui (.jpg, .png, .webp) — ampliadas em {escala}×</div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            disabled={ocupado}
            onChange={(e) => iniciarUpload(e.target.files)}
          />
        </div>
      )}

      {fonte === "pasta" && (
        <>
          <div className="hist-filtro">
            <label>
              Pasta:{" "}
              <select value={folderId ?? ""} onChange={(e) => setFolderId(e.target.value ? Number(e.target.value) : null)}>
                <option value="">Escolha uma pasta…</option>
                {folders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.nome}
                  </option>
                ))}
              </select>
            </label>
            {fotos.length > 0 && (
              <>
                <button className="btn sm" onClick={() => setSelFotos(new Set(fotos.map((m) => m.id)))}>
                  Marcar todas
                </button>
                <button className="btn sm" onClick={() => setSelFotos(new Set())}>
                  Desmarcar
                </button>
                <button className="btn primary sm" disabled={ocupado || selFotos.size === 0} onClick={iniciarPasta}>
                  🔍 Ampliar {selFotos.size} em {escala}×
                </button>
              </>
            )}
          </div>

          {folderId != null && fotos.length === 0 && <div className="empty">Esta pasta não tem fotos.</div>}

          <ul className="grid">
            {fotos.map((m) => (
              <li key={m.id} className={"vcard" + (selFotos.has(m.id) ? " selected" : "")}>
                <label className="vsel">
                  <input type="checkbox" checked={selFotos.has(m.id)} onChange={() => toggleFoto(m.id)} />
                </label>
                <img className="thumb" src={downloadUrl(m.id)} alt={m.nome_original} />
                <div className="vmeta">
                  <strong className="vtext" title={m.nome_original}>
                    {m.nome_original}
                  </strong>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {progresso && <div className="loading">{progresso}</div>}
    </>
  );
}

export default function Upscale() {
  const [tab, setTab] = useState<SubTab>("ampliar");
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <>
      <nav className="tabs">
        <button className={tab === "ampliar" ? "tab active" : "tab"} onClick={() => setTab("ampliar")}>
          🔍 Ampliar
        </button>
        <button className={tab === "historico" ? "tab active" : "tab"} onClick={() => setTab("historico")}>
          🕘 Histórico
        </button>
      </nav>

      {tab === "ampliar" && <AmpliarView onConcluido={() => setRefreshKey((k) => k + 1)} />}
      {tab === "historico" && <HistoryView refreshKey={refreshKey} />}
    </>
  );
}
