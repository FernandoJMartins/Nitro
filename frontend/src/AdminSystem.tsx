import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, Database, Gauge, BellRing, HardDrive, MemoryStick, Package, OctagonAlert, Send } from "lucide-react";
import { ErrorBanner } from "./Dialog";
import { adminNotifyTest, adminRunCanary, adminSystem, type LoginCanary, type Nivel, type SystemStatus } from "./api";
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
/** Biblioteca do Instagram: versão em uso x última publicada + bloqueios de login. */
const CANARIO_NIVEL: Record<LoginCanary["resultado"], Nivel> = {
  ok: "ok",
  bloqueado: "critico",
  inconclusivo: "atencao",
  erro: "atencao",
};
const CANARIO_TEXTO: Record<LoginCanary["resultado"], string> = {
  ok: "Login funcionando",
  bloqueado: "Instagram barrando o login",
  inconclusivo: "Inconclusivo",
  erro: "Falha de rede no teste",
};

function InstagramCard({ ig, onRefresh }: { ig: NonNullable<SystemStatus["instagram"]>; onRefresh: () => void }) {
  const [testando, setTestando] = useState(false);
  const [erroTeste, setErroTeste] = useState<string | null>(null);
  const c = ig.canario;
  async function testar() {
    setTestando(true);
    setErroTeste(null);
    try {
      await adminRunCanary();
      onRefresh();
    } catch (e) {
      setErroTeste(String(e));
    } finally {
      setTestando(false);
    }
  }
  const b = ig.biblioteca;
  const bloqueadas = ig.logins.bloqueadas_24h ?? 0;
  const ok = ig.logins.logins_ok_24h ?? 0;
  const nivel: Nivel = b.desatualizada && bloqueadas >= 2 ? "critico" : b.desatualizada || bloqueadas >= 2 ? "atencao" : "ok";
  const label = b.desatualizada ? "Atualização disponível" : bloqueadas >= 2 ? "Logins bloqueados" : "Em dia";
  return (
    <div className="sys-card">
      <div className="sys-card-head">
        <span className="sys-card-title">
          <Package size={16} aria-hidden="true" /> Biblioteca do Instagram
        </span>
        <StatusPill nivel={nivel} label={label} />
      </div>
      <div className="sys-muted">
        Em uso: {b.instalada ?? "?"}
        {b.em_uso_desde && <> (atualizada {atras(b.em_uso_desde)}{b.anterior ? `, antes ${b.anterior}` : ""})</>}
        <br />
        Mais nova: {b.ultima ? (b.ultima_url ? <a href={b.ultima_url} target="_blank" rel="noreferrer">{b.ultima}</a> : b.ultima) : "?"}
        {b.verificado_em && <> · verificado {atras(b.verificado_em)}</>}
        {b.erro && (
          <>
            <br />
            {b.erro}
          </>
        )}
        <br />
        Logins (24h): {ok} ok · {bloqueadas} bloqueados pelo Instagram
      </div>
      {ig.candidata && (
        <div className="sys-card-head" style={{ marginTop: 4 }}>
          <span className="sys-muted">
            Versão {ig.candidata.versao} testada {atras(ig.candidata.testado_em)}
            {ig.candidata.passou
              ? " — pronta: rode deploy/instagrapi_atualizacao.sh aplicar"
              : ` — falhou na etapa “${ig.candidata.etapa_falhou ?? "?"}”`}
          </span>
          <StatusPill
            nivel={ig.candidata.passou ? "ok" : "atencao"}
            label={ig.candidata.passou ? "Aprovada" : "Precisa de ajuste"}
          />
        </div>
      )}
      <div className="sys-card-head" style={{ marginTop: 4 }}>
        <span className="sys-muted">Teste diário de login {c ? atras(c.em) : "(ainda não rodou)"}</span>
        {c && <StatusPill nivel={CANARIO_NIVEL[c.resultado]} label={CANARIO_TEXTO[c.resultado]} />}
      </div>
      {c && (
        <div className="sys-muted">
          Via {c.rota}
          {c.detalhe && c.resultado !== "ok" && (
            <>
              <br />
              {c.detalhe}
            </>
          )}
        </div>
      )}
      <div>
        <button className="btn ghost sm" onClick={testar} disabled={testando}>
          {testando ? "Testando… (até 30s)" : "Testar login agora"}
        </button>
        <span className="sys-muted"> usa um usuário inventado — nenhuma conta real</span>
      </div>
      {erroTeste && <div className="sys-muted">{erroTeste}</div>}
    </div>
  );
}

/** Avisos no Telegram: configurado? último envio? botão de teste. */
function AvisosCard({ av }: { av: NonNullable<SystemStatus["avisos"]> }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  async function testar() {
    setEnviando(true);
    setMsg(null);
    try {
      await adminNotifyTest();
      setMsg("Enviado — confira o Telegram.");
    } catch (e) {
      setMsg(String(e));
    } finally {
      setEnviando(false);
    }
  }
  return (
    <div className="sys-card">
      <div className="sys-card-head">
        <span className="sys-card-title">
          <BellRing size={16} aria-hidden="true" /> Avisos no Telegram
        </span>
        <StatusPill
          nivel={!av.telegram_configurado ? "atencao" : av.ultimo_erro ? "critico" : "ok"}
          label={!av.telegram_configurado ? "Não configurado" : av.ultimo_erro ? "Falhando" : "Ativo"}
        />
      </div>
      <div className="sys-muted">
        {av.telegram_configurado ? (
          <>
            Servidor “{av.instancia}” · alertas conferidos {atras(av.verificado_em)}
            {av.ultimo_envio_em && <> · último aviso {atras(av.ultimo_envio_em)}</>}
            {av.ultimo_erro && (
              <>
                <br />
                {av.ultimo_erro}
              </>
            )}
          </>
        ) : (
          <>Defina TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID no .env deste servidor (passo a passo no README).</>
        )}
      </div>
      {av.telegram_configurado && (
        <div>
          <button className="btn ghost sm" onClick={testar} disabled={enviando}>
            {enviando ? "Enviando…" : "Enviar teste"}
          </button>
          {msg && <span className="sys-muted"> {msg}</span>}
        </div>
      )}
    </div>
  );
}

export default function AdminSystem() {
  const [st, setSt] = useState<SystemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const carregar = () =>
    adminSystem()
      .then((d) => (setSt(d), setError(null)))
      .catch((e) => setError(String(e)));

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
        {st.instagram && <InstagramCard ig={st.instagram} onRefresh={carregar} />}
        {st.avisos && <AvisosCard av={st.avisos} />}
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
