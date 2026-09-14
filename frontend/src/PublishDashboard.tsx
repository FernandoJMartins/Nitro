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

const STATUS_COLOR: Record<PublicationStatus, string> = {
  PENDING: "st-warn",
  UPLOADING: "st-warn",
  PROCESSING: "st-warn",
  PUBLISHED: "st-ok",
  FAILED: "st-danger",
  RETRYING: "st-warn",
  CANCELLED: "st-muted",
};

function Tile({ label, value, warn }: { label: string; value: number | string; warn?: boolean }) {
  return (
    <div className="card" style={{ flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
      <div className="meta">{label}</div>
      <strong style={{ fontSize: 22, color: warn ? "var(--danger)" : undefined }}>{value}</strong>
    </div>
  );
}

function Secao({ n, titulo, dica }: { n: number; titulo: string; dica?: string }) {
  return (
    <div className="section-title">
      <span className="step">{n}</span>
      {titulo}
      {dica && <span className="hint">{dica}</span>}
    </div>
  );
}

export default function PublishDashboard() {
  const [dash, setDash] = useState<PubDashboard | null>(null);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [pending, setPending] = useState<PubPublication[]>([]);
  const [logs, setLogs] = useState<PubLog[]>([]);
  const [accounts, setAccounts] = useState<PubAccount[]>([]);
  const [logsOpen, setLogsOpen] = useState(false);
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
      <p className="sub">
        Visão geral em tempo real: o que foi publicado hoje, a saúde das contas e o que está na fila.
      </p>
      {error && <div className="error">⚠️ {error}</div>}

      {dash && (
        <>
          <Secao n={1} titulo="Publicação hoje" dica="conteúdo aprovado, agendado e executado nas últimas 24h" />
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
            <Tile label="Aguardando aprovação" value={dash.aguardando_aprovacao} />
            <Tile label="Aprovados" value={dash.aprovados} />
            <Tile label="Agendados hoje" value={dash.agendados_hoje} />
            <Tile label="Em execução" value={dash.em_execucao} />
            <Tile label="Publicados hoje" value={dash.publicados_hoje} />
            <Tile label="Falhas hoje" value={dash.falhas_hoje} warn={dash.falhas_hoje > 0} />
            <Tile label="Retries aguardando" value={dash.retries} warn={dash.retries > 0} />
          </div>

          <Secao n={2} titulo="Saúde das contas" dica="sessões, proxies e stories configurados" />
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))" }}>
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
            <div className="card" style={{ marginTop: 14, alignItems: "flex-start" }}>
              <div className="card-main" style={{ width: "100%" }}>
                <strong className="st-danger">⚠ Atenção — erros por conta</strong>
                <ul className="list" style={{ marginTop: 8 }}>
                  {dash.ultimos_erros.map((e) => (
                    <li key={`${e.account_id}-${e.em}`} className="card" style={{ alignItems: "flex-start" }}>
                      <div className="card-main" style={{ width: "100%" }}>
                        <strong>@{e.username}</strong>
                        <div className="meta st-danger">{e.erro}</div>
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

      <Secao n={3} titulo="Fila de publicação" dica="próximas publicações agendadas" />
      <ul className="list">
        {pending.slice(0, 15).map((p) => (
          <li key={p.id} className="card">
            <div className="card-main">
              <strong>
                <span className={STATUS_COLOR[p.status]}>{STATUS_ICON[p.status]}</span>{" "}
                {new Date(p.scheduled_at).toLocaleString("pt-BR")}
              </strong>
              <div className="meta">
                para {nomeConta(p.account_id)}
                {p.tentativas > 0 ? ` · ${p.tentativas} tentativa(s)` : ""}
              </div>
            </div>
            <div className="card-actions">
              <button className="btn ghost sm" onClick={() => reagendar(p.id, p.scheduled_at)}>
                🕒 Reagendar
              </button>
            </div>
          </li>
        ))}
        {pending.length === 0 && <li className="empty">Nada agendado no momento.</li>}
      </ul>

      <Secao n={4} titulo="Atividade recente" dica="últimos reels e stories publicados ou tentados" />
      <ul className="list">
        {timeline.map((t, i) => (
          <li key={i} className="card">
            <div className="card-main">
              <strong>
                <span className={STATUS_COLOR[t.status]}>{STATUS_ICON[t.status]}</span> @{t.account_username}
              </strong>
              <div className="meta">
                {new Date(t.horario).toLocaleString("pt-BR")} · {t.kind === "story" ? "📖 story" : "🎬 reel"}
              </div>
            </div>
            <span className={`badge ${STATUS_COLOR[t.status]}`}>{t.status}</span>
          </li>
        ))}
        {timeline.length === 0 && <li className="empty">Nenhuma atividade ainda.</li>}
      </ul>

      <div className="card" style={{ marginTop: 16, alignItems: "flex-start" }}>
        <div className="card-main" style={{ width: "100%" }}>
          <div
            className={`panel-head${logsOpen ? " open" : ""}`}
            onClick={() => setLogsOpen((v) => !v)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setLogsOpen((v) => !v);
              }
            }}
          >
            <strong>🧾 Logs de automação ({Math.min(logs.length, 30)}{logs.length > 30 ? "+" : ""})</strong>
            <span className="caret">▶</span>
          </div>
          {logsOpen && (
            <ul className="list" style={{ marginTop: 10 }}>
              {logs.slice(0, 30).map((log) => (
                <li key={log.id} className="card" style={{ alignItems: "flex-start" }}>
                  <div className="card-main" style={{ width: "100%" }}>
                    <strong className={log.nivel === "erro" ? "st-danger" : "st-muted"}>
                      [{log.nivel}] {nomeConta(log.account_id)}
                    </strong>
                    <div className="meta">{log.mensagem}</div>
                    <div className="meta">{new Date(log.criado_em).toLocaleString("pt-BR")}</div>
                  </div>
                </li>
              ))}
              {logs.length === 0 && <li className="empty">Nenhum log ainda.</li>}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
