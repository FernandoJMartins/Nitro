import { useEffect, useState } from "react";
import {
  getLogs,
  getPubDashboard,
  getTimeline,
  listAccounts,
  listPublications,
  reschedulePublication,
  type PubAccount,
  type PubDashboard,
  type PubLog,
  type PubPublication,
  type PublicationStatus,
  type TimelineItem,
} from "./api";

const STATUS_ICON: Record<PublicationStatus, string> = {
  PENDING: "⏰",
  UPLOADING: "⏳",
  PROCESSING: "⏳",
  PUBLISHED: "✓",
  FAILED: "⚠",
  RETRYING: "↻",
  CANCELLED: "✕",
};

function Tile({ label, value, warn }: { label: string; value: number | string; warn?: boolean }) {
  return (
    <div className="card" style={{ flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
      <div className="meta">{label}</div>
      <strong style={{ fontSize: 22, color: warn ? "var(--danger)" : undefined }}>{value}</strong>
    </div>
  );
}

export default function PublishDashboard() {
  const [dash, setDash] = useState<PubDashboard | null>(null);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [pending, setPending] = useState<PubPublication[]>([]);
  const [logs, setLogs] = useState<PubLog[]>([]);
  const [accounts, setAccounts] = useState<PubAccount[]>([]);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    getPubDashboard().then(setDash).catch((e) => setError(String(e)));
    getTimeline(30).then(setTimeline).catch((e) => setError(String(e)));
    listPublications({ status: "PENDING" }).then(setPending).catch(() => {});
    getLogs({}).then(setLogs).catch(() => {});
    listAccounts().then(setAccounts).catch(() => {});
  }

  function nomeConta(id: number | null): string {
    if (id === null) return "sistema";
    const acc = accounts.find((a) => a.id === id);
    return acc ? `@${acc.username}` : `conta #${id}`;
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 15000);
    return () => clearInterval(id);
  }, []);

  async function reagendar(pubId: number, atual: string) {
    const novo = window.prompt("Novo horário (YYYY-MM-DDTHH:mm):", atual.slice(0, 16));
    if (!novo) return;
    try {
      await reschedulePublication(pubId, new Date(novo).toISOString());
      refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <>
      <p className="sub">Visão geral da publicação: aprovação, agendamento e execução em tempo real.</p>
      {error && <div className="error">⚠️ {error}</div>}

      {dash && (
        <>
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
            <Tile label="Aguardando aprovação" value={dash.aguardando_aprovacao} />
            <Tile label="Aprovados" value={dash.aprovados} />
            <Tile label="Agendados hoje" value={dash.agendados_hoje} />
            <Tile label="Em execução" value={dash.em_execucao} />
            <Tile label="Publicados hoje" value={dash.publicados_hoje} />
            <Tile label="Falhas hoje" value={dash.falhas_hoje} warn={dash.falhas_hoje > 0} />
            <Tile label="Retries aguardando" value={dash.retries} warn={dash.retries > 0} />
          </div>

          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", marginTop: 10 }}>
            <Tile label="Contas ativas" value={`${dash.contas_ativas}/${dash.contas_total}`} />
            <Tile label="Sessões válidas" value={dash.sessoes_validas} />
            <Tile
              label="Sessões expiradas"
              value={dash.sessoes_expiradas}
              warn={dash.sessoes_expiradas > 0}
            />
            <Tile label="Proxies ativos" value={`${dash.proxies_ativos}/${dash.proxies_total}`} />
            <Tile label="Proxies inativos" value={dash.proxies_inativos} warn={dash.proxies_inativos > 0} />
            <Tile label="Stories hoje" value={`${dash.stories_hoje}/${dash.stories_configuradas}`} />
          </div>

          {dash.ultimos_erros.length > 0 && (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="card-main" style={{ width: "100%" }}>
                <strong>⚠ Últimos erros por conta</strong>
                <ul className="list" style={{ marginTop: 8 }}>
                  {dash.ultimos_erros.map((e) => (
                    <li key={`${e.account_id}-${e.em}`} className="card">
                      <div className="card-main">
                        <strong>@{e.username}</strong>
                        <div className="meta" style={{ color: "var(--danger)" }}>{e.erro}</div>
                        {e.em && <div className="meta">{new Date(e.em).toLocaleString("pt-BR")}</div>}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </>
      )}

      <h3 style={{ marginTop: 24, marginBottom: 8, fontSize: 15 }}>Próximos agendamentos</h3>
      <ul className="list">
        {pending.slice(0, 15).map((p) => (
          <li key={p.id} className="card">
            <div className="card-main">
              <strong>
                {STATUS_ICON[p.status]} Publicação #{p.id}
              </strong>
              <div className="meta">{new Date(p.scheduled_at).toLocaleString("pt-BR")}</div>
            </div>
            <div className="card-actions">
              <button className="btn sm" onClick={() => reagendar(p.id, p.scheduled_at)}>
                Reagendar
              </button>
            </div>
          </li>
        ))}
        {pending.length === 0 && <li className="empty">Nada agendado no momento.</li>}
      </ul>

      <h3 style={{ marginTop: 24, marginBottom: 8, fontSize: 15 }}>Linha do tempo</h3>
      <ul className="list">
        {timeline.map((t, i) => (
          <li key={i} className="card">
            <div className="card-main">
              <strong>
                {STATUS_ICON[t.status]} @{t.account_username}
              </strong>
              <div className="meta">
                {new Date(t.horario).toLocaleString("pt-BR")} · {t.kind === "story" ? "story" : "reel"} · {t.status}
              </div>
            </div>
          </li>
        ))}
        {timeline.length === 0 && <li className="empty">Nenhuma atividade ainda.</li>}
      </ul>

      <h3 style={{ marginTop: 24, marginBottom: 8, fontSize: 15 }}>Logs de automação (por conta)</h3>
      <ul className="list">
        {logs.slice(0, 30).map((log) => (
          <li key={log.id} className="card">
            <div className="card-main">
              <strong className={log.nivel === "erro" ? "" : undefined} style={log.nivel === "erro" ? { color: "var(--danger)" } : undefined}>
                [{log.nivel}] {nomeConta(log.account_id)}
              </strong>
              <div className="meta">{log.mensagem}</div>
              <div className="meta">{new Date(log.criado_em).toLocaleString("pt-BR")}</div>
            </div>
          </li>
        ))}
        {logs.length === 0 && <li className="empty">Nenhum log ainda.</li>}
      </ul>
    </>
  );
}
