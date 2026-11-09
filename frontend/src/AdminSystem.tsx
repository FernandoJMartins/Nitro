import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, Database, Gauge, HardDrive, MemoryStick, OctagonAlert, Send } from "lucide-react";
import { ErrorBanner } from "./Dialog";
import { adminSystem, type Nivel, type SystemStatus } from "./api";
import "./AdminSystem.css";

const REFRESH_MS = 30_000;

function gb(bytes: number) {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
function mb(bytes: number) {
  return bytes >= 1024 ** 3 ? gb(bytes) : `${Math.round(bytes / 1024 ** 2)} MB`;
}
function brl(v: number) {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function duracao(s: number | null) {
  if (s == null) return "—";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}min` : `${m}min`;
}
function atras(iso: string | null) {
  if (!iso) return "nunca";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  return s < 60 ? `há ${Math.max(1, Math.round(s))}s` : `há ${duracao(s)}`;
}

const NIVEL_LABEL: Record<Nivel, string> = { ok: "Normal", atencao: "Atenção", critico: "Crítico" };

/** Status sempre com ícone + texto (nunca só a cor). */
function StatusPill({ nivel, label }: { nivel: Nivel; label?: string }) {
  const Icon = nivel === "ok" ? CheckCircle2 : nivel === "atencao" ? AlertTriangle : OctagonAlert;
  return (
    <span className={`sys-pill sys-${nivel}`}>
      <Icon size={14} aria-hidden="true" />
      {label ?? NIVEL_LABEL[nivel]}
    </span>
  );
}

/** Medidor: trilho + preenchimento, valor em texto ao lado (cor = estado, não identidade). */
function Meter({
  icon: Icon,
  titulo,
  frac,
  detalhe,
  nivel,
}: {
  icon: typeof HardDrive;
  titulo: string;
  frac: number;
  detalhe: string;
  nivel: Nivel;
}) {
  const pct = Math.max(0, Math.min(1, frac));
  return (
    <div className="sys-card">
      <div className="sys-card-head">
        <span className="sys-card-title">
          <Icon size={16} aria-hidden="true" /> {titulo}
        </span>
        <StatusPill nivel={nivel} />
      </div>
      <div className="sys-big">{Math.round(frac * 100)}%</div>
      <div
        className="sys-track"
        role="meter"
        aria-label={titulo}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct * 100)}
      >
        <div className={`sys-fill sys-fill-${nivel}`} style={{ width: `${pct * 100}%` }} />
      </div>
      <div className="sys-muted">{detalhe}</div>
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="sys-tile">
      <div className="sys-tile-label">{label}</div>
      <div className="sys-tile-value">{value}</div>
      {hint && <div className="sys-muted">{hint}</div>}
    </div>
  );
}

const STATUS_PUB: [string, string][] = [
  ["PUBLISHED", "Publicadas"],
  ["FAILED", "Falharam"],
  ["RETRYING", "Tentando de novo"],
  ["PENDING", "Na fila"],
  ["CANCELLED", "Canceladas"],
];

const PLANO_NOME: Record<string, string> = { basico: "Básico", pro: "Pro", agencia: "Agência" };

/** Painel de monitoramento do admin — atualiza sozinho a cada 30s. */
export default function AdminSystem() {
  const [st, setSt] = useState<SystemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    let vivo = true;
    const load = () =>
      adminSystem()
        .then((d) => vivo && (setSt(d), setError(null)))
        .catch((e) => vivo && setError(String(e)));
    load();
    const t = setInterval(load, REFRESH_MS);
    const relogio = setInterval(() => setTick((x) => x + 1), 5000); // atualiza os "há Xs"
    return () => {
      vivo = false;
      clearInterval(t);
      clearInterval(relogio);
    };
  }, []);

  if (!st) return error ? <ErrorBanner error={error} /> : <div className="loading">Carregando painel…</div>;

  const s = st.servidor;
  const n = st.negocio;
  const p = st.publicacoes;
  const geral: Nivel = st.alertas.some((a) => a.nivel === "critico")
    ? "critico"
    : st.alertas.length
      ? "atencao"
      : "ok";

  return (
    <div className="sys">
      <ErrorBanner error={error} onClose={() => setError(null)} />

      <div className={`sys-banner sys-banner-${geral}`}>
        <StatusPill nivel={geral} label={geral === "ok" ? "Tudo funcionando" : geral === "atencao" ? "Precisa de atenção" : "Problema crítico"} />
        <span className="sys-muted">Atualizado {atras(st.gerado_em)} · atualiza a cada 30s</span>
      </div>
      {st.alertas.length > 0 && (
        <ul className="sys-alerts">
          {st.alertas.map((a, i) => (
            <li key={i}>
              <StatusPill nivel={a.nivel} /> {a.mensagem}
            </li>
          ))}
        </ul>
      )}

      <h3 className="sys-h">Negócio</h3>
      <div className="sys-tiles">
        <Tile label="Receita mensal (MRR)" value={brl(n.mrr)} hint="assinaturas ativas na Stripe" />
        <Tile label="Assinantes" value={n.pagantes} hint={Object.entries(n.por_plano).map(([k, v]) => `${PLANO_NOME[k] ?? k}: ${v}`).join(" · ")} />
        <Tile label="Clientes cadastrados" value={n.usuarios} hint={`+${n.novos_7d} nos últimos 7 dias`} />
        <Tile label="Cortesia / sem acesso" value={`${n.cortesia} / ${n.sem_acesso}`} />
        <Tile label="Vídeos gerados no mês" value={n.videos_gerados_mes.toLocaleString("pt-BR")} />
        <Tile label="Perfis do Instagram" value={n.contas_instagram} />
      </div>

      <h3 className="sys-h">Servidor</h3>
      <div className="sys-grid">
        <Meter
          icon={HardDrive}
          titulo="Disco"
          frac={s.disco.usado / Math.max(1, s.disco.total)}
          detalhe={`${gb(s.disco.usado)} de ${gb(s.disco.total)} · ${gb(s.disco.livre)} livres`}
          nivel={s.disco.nivel}
        />
        <Meter
          icon={MemoryStick}
          titulo="Memória"
          frac={s.memoria.usado / Math.max(1, s.memoria.total)}
          detalhe={`${mb(s.memoria.usado)} de ${mb(s.memoria.total)} · swap ${mb(s.swap.usado)} de ${mb(s.swap.total)}`}
          nivel={s.memoria.nivel}
        />
        <Meter
          icon={Gauge}
          titulo="CPU (média 5 min)"
          frac={s.cpu.load5 / Math.max(1, s.cpu.nucleos)}
          detalhe={`carga ${s.cpu.load1.toFixed(2)} / ${s.cpu.load5.toFixed(2)} / ${s.cpu.load15.toFixed(2)} · ${s.cpu.nucleos} núcleo(s)`}
          nivel={s.cpu.nivel}
        />
      </div>

      <div className="sys-grid">
        <div className="sys-card">
          <div className="sys-card-head">
            <span className="sys-card-title">
              <Database size={16} aria-hidden="true" /> Banco de dados
            </span>
            <StatusPill nivel={st.banco.ok ? "ok" : "critico"} label={st.banco.ok ? "Conectado" : "Fora do ar"} />
          </div>
          <div className="sys-muted">
            {st.banco.ok
              ? `Resposta em ${st.banco.latencia_ms} ms${st.banco.tamanho != null ? ` · ${mb(st.banco.tamanho)}` : ""}`
              : st.banco.erro}
          </div>
        </div>
        <div className="sys-card">
          <div className="sys-card-head">
            <span className="sys-card-title">
              <Send size={16} aria-hidden="true" /> Agendador de posts
            </span>
            <StatusPill nivel={st.agendador.ok ? "ok" : "critico"} label={st.agendador.ok ? "Rodando" : "Parado"} />
          </div>
          <div className="sys-muted">
            Último ciclo {atras(st.agendador.ultimo_ciclo_em)} · {st.agendador.ciclos} ciclos desde o início
            {st.agendador.ultimo_erro && (
              <>
                <br />
                Último erro ({atras(st.agendador.ultimo_erro_em)}): {st.agendador.ultimo_erro}
              </>
            )}
          </div>
        </div>
        <div className="sys-card">
          <div className="sys-card-head">
            <span className="sys-card-title">
              <Clock size={16} aria-hidden="true" /> Tempo no ar
            </span>
          </div>
          <div className="sys-muted">
            Servidor: {duracao(s.uptime_servidor_s)} · App: {duracao(s.uptime_app_s)}
            <br />
            Limpeza de vídeos ({st.retencao.dias} dias): {atras(st.retencao.ultima_execucao_em)}, {st.retencao.removidos} removidos
          </div>
        </div>
      </div>

      <h3 className="sys-h">Publicações (últimas 24h)</h3>
      <div className="sys-tiles">
        {STATUS_PUB.map(([k, label]) => (
          <Tile key={k} label={label} value={p.ultimas_24h[k] ?? 0} />
        ))}
        <Tile label="Atrasadas (+30 min)" value={p.atrasadas} />
        <Tile label="Contas com erro" value={p.contas_com_erro_24h} />
      </div>

      {p.erros_recentes.length > 0 && (
        <>
          <h3 className="sys-h">Erros recentes</h3>
          <ul className="sys-errors">
            {p.erros_recentes.map((e, i) => (
              <li key={i}>
                <span className="sys-muted">
                  {new Date(e.em).toLocaleString("pt-BR")} {e.conta_id != null && `· conta #${e.conta_id}`}
                </span>
                <div>{e.mensagem}</div>
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="sys-muted sys-note">
        Este painel roda dentro do próprio site: se o servidor cair, ele cai junto. Para ser avisado quando o site sair do ar,
        cadastre <code>https://nitroflow.site/health</code> num monitor externo gratuito (ex.: UptimeRobot).
      </p>
    </div>
  );
}
