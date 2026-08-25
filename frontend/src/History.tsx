import { useEffect, useState } from "react";
import { deleteVideos, getHistory, videoDownloadUrl, type GeneratedVideo } from "./api";

// Agrupa os vídeos por dia (preservando a ordem: mais recente primeiro).
function groupByDay(items: GeneratedVideo[]): { dia: string; videos: GeneratedVideo[] }[] {
  const groups: { dia: string; videos: GeneratedVideo[] }[] = [];
  for (const v of items) {
    const dia = new Date(v.criado_em).toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
    const last = groups[groups.length - 1];
    if (last && last.dia === dia) last.videos.push(v);
    else groups.push({ dia, videos: [v] });
  }
  return groups;
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

  function refresh() {
    getHistory().then(setItems).catch((e) => setError(String(e)));
  }

  useEffect(() => {
    refresh();
  }, []);

  async function apagarDia(dia: string, videos: GeneratedVideo[]) {
    const ok = window.confirm(
      `Apagar TODOS os ${videos.length} vídeo(s) do dia ${dia}?\n\nEsta ação não pode ser desfeita.`
    );
    if (!ok) return;
    try {
      await deleteVideos(videos.map((v) => v.id));
      refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  const groups = groupByDay(items);

  return (
    <>
      <p className="sub">Todos os vídeos gerados, agrupados por dia (do mais recente ao mais antigo).</p>
      {error && <div className="error">⚠️ {error}</div>}
      {items.length === 0 && !error && <div className="empty">Nenhum vídeo gerado ainda.</div>}

      {groups.map((g) => (
        <section key={g.dia} className="day-group">
          <div className="day-header">
            <span>
              📅 {diaLabel(g.dia)} <span className="day-count">({g.videos.length})</span>
            </span>
            <button className="btn danger sm" onClick={() => apagarDia(g.dia, g.videos)}>
              🗑️ Apagar tudo
            </button>
          </div>
          <ul className="grid">
            {g.videos.map((v) => (
              <li key={v.id} className="vcard">
                <video src={videoDownloadUrl(v.id)} controls preload="metadata" />
                <div className="vmeta">
                  {v.texto && <div className="vtext">“{v.texto}”</div>}
                  <div className="meta">
                    {v.duracao}s
                    {v.usou_flash && (
                      <>
                        {" "}
                        · <span className="badge">flash</span>
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
        </section>
      ))}
    </>
  );
}
