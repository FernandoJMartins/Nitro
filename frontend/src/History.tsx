import { useEffect, useMemo, useState } from "react";
import { deleteVideos, getHistory, videoDownloadUrl, type GeneratedVideo } from "./api";

type LoteGroup = { lote: number | null; videos: GeneratedVideo[] };
type DayGroup = { dia: string; total: number; lotes: LoteGroup[] };

// Agrupa por dia (mais recente primeiro) e, dentro de cada dia, por lote (job_id),
// ordenando os lotes de forma decrescente. Vídeos sem lote ficam por último.
function groupByDayAndLote(items: GeneratedVideo[]): DayGroup[] {
  const days: DayGroup[] = [];
  for (const v of items) {
    const dia = new Date(v.criado_em).toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
    let day = days.find((d) => d.dia === dia);
    if (!day) {
      day = { dia, total: 0, lotes: [] };
      days.push(day);
    }
    day.total++;
    let lote = day.lotes.find((l) => l.lote === v.job_id);
    if (!lote) {
      lote = { lote: v.job_id, videos: [] };
      day.lotes.push(lote);
    }
    lote.videos.push(v);
  }
  for (const day of days) {
    day.lotes.sort((a, b) => {
      if (a.lote == null) return 1; // sem lote por último
      if (b.lote == null) return -1;
      return b.lote - a.lote; // lote decrescente
    });
  }
  return days;
}

function diaLabel(dia: string): string {
  const hoje = new Date().toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
  const ontem = new Date(Date.now() - 86400000).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
  if (dia === hoje) return `Hoje · ${dia}`;
  if (dia === ontem) return `Ontem · ${dia}`;
  return dia;
}

export default function History() {
  const [items, setItems] = useState<GeneratedVideo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [filtro, setFiltro] = useState<"nenhum" | "data" | "lote">("nenhum");
  const [valor, setValor] = useState<string>("");

  function refresh() {
    getHistory().then(setItems).catch((e) => setError(String(e)));
  }

  useEffect(() => {
    refresh();
  }, []);

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function baixarVideos(videos: GeneratedVideo[]) {
    for (const v of videos) {
      const a = document.createElement("a");
      a.href = videoDownloadUrl(v.id);
      a.download = `video_${v.id}.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  async function baixarSelecionados() {
    const videos = items.filter((v) => selected.has(v.id));
    await baixarVideos(videos);
  }

  async function apagarGrupo(rotulo: string, videos: GeneratedVideo[]) {
    const ok = window.confirm(
      `Apagar TODOS os ${videos.length} vídeo(s) de ${rotulo}?\n\nEsta ação não pode ser desfeita.`
    );
    if (!ok) return;
    try {
      await deleteVideos(videos.map((v) => v.id));
      refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  // Opções disponíveis para os filtros (preservando a ordem do histórico).
  const datas = useMemo(() => {
    const set: string[] = [];
    for (const v of items) {
      const dia = new Date(v.criado_em).toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
      });
      if (!set.includes(dia)) set.push(dia);
    }
    return set;
  }, [items]);

  const lotes = useMemo(() => {
    const set = new Set<number>();
    for (const v of items) if (v.job_id != null) set.add(v.job_id);
    return [...set].sort((a, b) => b - a); // decrescente
  }, [items]);

  // Aplica o filtro selecionado.
  const filtrados = useMemo(() => {
    if (filtro === "nenhum" || !valor) return items;
    if (filtro === "lote") return items.filter((v) => String(v.job_id) === valor);
    return items.filter(
      (v) =>
        new Date(v.criado_em).toLocaleDateString("pt-BR", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
        }) === valor
    );
  }, [items, filtro, valor]);

  const groups = groupByDayAndLote(filtrados);

  return (
    <>
      <p className="sub">
        Todos os vídeos gerados, agrupados por dia e por lote (do mais recente ao mais antigo).
      </p>

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
      {items.length === 0 && !error && <div className="empty">Nenhum vídeo gerado ainda.</div>}
      {items.length > 0 && filtrados.length === 0 && (
        <div className="empty">Nenhum vídeo encontrado para este filtro.</div>
      )}

      {selected.size > 0 && (
        <div className="selbar">
          <span>{selected.size} selecionado(s)</span>
          <button className="btn primary sm" onClick={baixarSelecionados}>
            ⬇️ Baixar selecionados ({selected.size})
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
              <button
                className="btn primary sm"
                onClick={() => baixarVideos(g.lotes.flatMap((l) => l.videos))}
              >
                ⬇️ Baixar todos ({g.total})
              </button>
              <button
                className="btn danger sm"
                onClick={() => apagarGrupo(`dia ${g.dia}`, g.lotes.flatMap((l) => l.videos))}
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
                  <span className="day-count">({lote.videos.length})</span>
                </span>
                <div className="day-actions">
                  <button className="btn sm" onClick={() => baixarVideos(lote.videos)}>
                    ⬇️ Baixar lote ({lote.videos.length})
                  </button>
                  <button
                    className="btn danger sm"
                    onClick={() =>
                      apagarGrupo(
                        lote.lote != null ? `lote #${lote.lote}` : "vídeos sem lote",
                        lote.videos
                      )
                    }
                  >
                    🗑️ Apagar lote
                  </button>
                </div>
              </div>
              <ul className="grid">
                {lote.videos.map((v) => (
                  <li key={v.id} className={"vcard" + (selected.has(v.id) ? " selected" : "")}>
                    <label className="vsel">
                      <input
                        type="checkbox"
                        checked={selected.has(v.id)}
                        onChange={() => toggle(v.id)}
                      />
                    </label>
                    <video src={videoDownloadUrl(v.id)} controls preload="metadata" />
                    <div className="vmeta">
                      {v.texto && <div className="vtext">“{v.texto}”</div>}
                      <div className="meta">
                        {v.duracao}s
                        {v.tipo_video && (
                          <>
                            {" "}
                            · <span className="badge">{({ pause: "pause", imagem: "imagem", final: "final" } as Record<string, string>)[v.tipo_video] ?? v.tipo_video}</span>
                          </>
                        )}
                        {v.job_id && <> · lote #{v.job_id}</>}
                      </div>
                      {v.legenda && <div className="vlegenda">📝 {v.legenda}</div>}
                      <a href={videoDownloadUrl(v.id)} download className="btn">
                        Baixar .mp4
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
