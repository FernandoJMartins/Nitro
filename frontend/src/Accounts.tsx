import { useEffect, useState } from "react";
import { Modal, ConfirmDialog } from "./Dialog";
import {
  checkProxy,
  connectAccount,
  createAccount,
  createCaption,
  createProxy,
  deleteAccount,
  deleteCaption,
  deleteProxy,
  getPublishingDefaults,
  listAccounts,
  listCaptions,
  listMedia,
  listProxies,
  pauseAccount,
  resumeAccount,
  updateAccount,
  updateCaption,
  updatePublishingDefaults,
  updateStoryConfig,
  getStoryConfig,
  verifyAccountSession,
  type AccountBody,
  type CaptionTemplate,
  type Media,
  type Proxy,
  type PubAccount,
  type PublishingDefaults,
} from "./api";

const PROXY_DOT: Record<string, string> = { verde: "🟢", amarelo: "🟡", vermelho: "🔴", cinza: "⚪" };

/**
 * Converte uma URL de proxy numa linha só nos campos que o backend espera.
 * Aceita dois formatos:
 *   - URL:        "socks5://usuario:senha@host:porta" (protocolo opcional, porta opcional = 1080)
 *   - Provider:   "host:porta:usuario:senha"  (ex.: server.sixproxy.com:24654:user:pass)
 */
function parseProxyUrl(raw: string): { protocolo: string; host: string; porta: number; usuario?: string; senha?: string } | null {
  let value = raw.trim();
  if (!value) return null;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) {
    // formato de provider: host:porta:usuario:senha (senha pode conter ":")
    const parts = value.split(":");
    if (parts.length >= 4 && /^\d+$/.test(parts[1])) {
      return {
        protocolo: "socks5",
        host: parts[0],
        porta: Number(parts[1]),
        ...(parts[2] ? { usuario: parts[2] } : {}),
        ...(parts.slice(3).join(":") ? { senha: parts.slice(3).join(":") } : {}),
      };
    }
    value = `socks5://${value}`;
  }
  try {
    const u = new URL(value);
    if (!u.hostname) return null;
    return {
      protocolo: u.protocol.replace(":", "").toLowerCase() || "socks5",
      host: u.hostname,
      porta: u.port ? Number(u.port) : 1080,
      ...(u.username ? { usuario: decodeURIComponent(u.username) } : {}),
      ...(u.password ? { senha: decodeURIComponent(u.password) } : {}),
    };
  } catch {
    return null;
  }
}

function ProxyManager({ proxies, onChange }: { proxies: Proxy[]; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function add() {
    const parsed = parseProxyUrl(url);
    if (!parsed) {
      setError("URL inválida — use o formato socks5://usuario:senha@host:porta");
      return;
    }
    try {
      await createProxy({
        nome: `${parsed.host}:${parsed.porta}`,
        host: parsed.host,
        porta: parsed.porta,
        protocolo: parsed.protocolo,
        usuario: parsed.usuario,
        senha: parsed.senha,
      });
      setUrl("");
      setOpen(false);
      onChange();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-main" style={{ width: "100%" }}>
        <strong>Proxies (SOCKS5, opcional)</strong>
        <ul className="list" style={{ marginTop: 10 }}>
          {proxies.map((p) => (
            <li key={p.id} className="card">
              <div className="card-main">
                <strong>
                  {PROXY_DOT[p.status]} {p.nome}
                </strong>
                <div className="meta">
                  {p.protocolo}://{p.usuario ? `${p.usuario}@` : ""}
                  {p.host}:{p.porta}
                  {p.latencia_ms != null && <> · {Math.round(p.latencia_ms)}ms</>}
                  {p.ip_publico && <> · IP {p.ip_publico}</>}
                  {p.ultimo_erro && <> · {p.ultimo_erro}</>}
                </div>
              </div>
              <div className="card-actions">
                <button className="btn sm" onClick={() => checkProxy(p.id).then(onChange)}>
                  Testar
                </button>
                <button className="btn danger sm" onClick={() => deleteProxy(p.id).then(onChange)}>
                  Excluir
                </button>
              </div>
            </li>
          ))}
          {proxies.length === 0 && <li className="empty">Nenhum proxy cadastrado — contas sem proxy publicam direto.</li>}
        </ul>

        {!open ? (
          <button className="btn sm" onClick={() => setOpen(true)}>
            ＋ Novo proxy
          </button>
        ) : (
          <div className="form" style={{ marginTop: 10 }}>
            {error && <div className="error">⚠️ {error}</div>}
            <div className="checkrow" style={{ gap: 8 }}>
              <input
                placeholder="socks5://usuario:senha@host:porta — ou — host:porta:usuario:senha"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                style={{ flex: 1 }}
                onKeyDown={(e) => e.key === "Enter" && add()}
              />
              <button className="btn primary" onClick={add}>
                Adicionar proxy
              </button>
            </div>
            <div className="hint" style={{ marginTop: 6 }}>
              Uma linha só. Formatos aceitos: <code>socks5://usuario:senha@host:porta</code> ou o formato de
              provider <code>host:porta:usuario:senha</code> (protocolo e porta opcionais — padrão socks5 e 1080).
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setOpen(false)}>
                Cancelar
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function AccountForm({
  proxies,
  photos,
  initial,
  onSave,
  onClose,
}: {
  proxies: Proxy[];
  photos: Media[];
  initial?: PubAccount;
  onSave: (
    body: AccountBody,
    storyBody?: {
      enabled: boolean;
      horario: string;
      imagem_media_id: number | null;
      texto: string | null;
      link?: string | null;
      plans?: { horario: string; frames: { media_id: number; texto?: string | null; link?: string | null }[] }[];
    }
  ) => void;
  onClose: () => void;
}) {
  const [nomeInterno, setNomeInterno] = useState(initial?.nome_interno ?? "");
  const [username, setUsername] = useState(initial?.username ?? "");
  const [senha, setSenha] = useState("");
  const [proxyId, setProxyId] = useState<number | "">(initial?.proxy_id ?? "");
  const [postsHora, setPostsHora] = useState<number | "">(initial?.posts_por_hora ?? "");
  const [janelaInicio, setJanelaInicio] = useState(initial?.janela_inicio ?? "");
  const [janelaFim, setJanelaFim] = useState(initial?.janela_fim ?? "");
  const [captionMode, setCaptionMode] = useState<AccountBody["caption_mode"]>(initial?.caption_mode ?? "automatica");
  const [audioMode, setAudioMode] = useState<AccountBody["audio_mode"]>(initial?.audio_mode ?? "nenhum");
  const [storiesEnabled, setStoriesEnabled] = useState(initial?.stories_enabled ?? false);
  const [storyPlans, setStoryPlans] = useState<{ key: number; horario: string; frames: number[]; texto: string; link: string }[]>([
    { key: Date.now(), horario: "18:00", frames: [], texto: "", link: "" },
  ]);

  useEffect(() => {
    if (initial && initial.stories_enabled) {
      getStoryConfig(initial.id).then((cfg) => {
        const loaded = (cfg.plans ?? []).map((p) => ({
          key: p.id,
          horario: p.horario,
          frames: p.media_ids,
          texto: p.texto ?? "",
          link: p.link ?? "",
        }));
        if (loaded.length > 0) setStoryPlans(loaded);
      });
    }
  }, [initial]);

  function submit() {
    if (!nomeInterno.trim() || !username.trim()) return;
    const body: AccountBody = {
      nome_interno: nomeInterno.trim(),
      username: username.trim(),
      ...(senha.trim() ? { senha: senha.trim() } : {}),
      proxy_id: proxyId === "" ? null : proxyId,
      posts_por_hora: postsHora === "" ? null : postsHora,
      janela_inicio: janelaInicio || null,
      janela_fim: janelaFim || null,
      caption_mode: captionMode,
      audio_mode: audioMode,
      stories_enabled: storiesEnabled,
    };
    const primeiro = storyPlans[0];
    const storyBody = storiesEnabled
      ? {
          enabled: true,
          horario: primeiro?.horario ?? "18:00",
          imagem_media_id: primeiro?.frames[0] ?? null,
          texto: primeiro?.texto || null,
          link: primeiro?.link || null,
          plans: storyPlans.map((p) => ({
            horario: p.horario,
            frames: p.frames.map((media_id) => ({ media_id, texto: p.texto || null, link: p.link || null })),
          })),
        }
      : undefined;
    onSave(body, storyBody);
  }

  return (
    <Modal title={initial ? `Editar ${initial.nome_interno}` : "Nova conta"} onClose={onClose}>
      <div className="form">
        <label className="field">
          Nome interno
          <input value={nomeInterno} onChange={(e) => setNomeInterno(e.target.value)} placeholder="Ex.: Perfil 01" />
        </label>
        <label className="field">
          Username (Instagram)
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Ex.: perfil01" />
        </label>
        <label className="field">
          Senha {initial?.senha_configurada ? "(já configurada — deixe em branco para manter)" : ""}
          <input
            type="password"
            value={senha}
            onChange={(e) => setSenha(e.target.value)}
            placeholder={initial?.senha_configurada ? "••••••••" : "Senha da conta"}
            autoComplete="new-password"
          />
          <span className="hint">
            Guardada criptografada. Usada na autenticação real da conta (botão “Conectar” — login efetivo no
            Instagram, com a sessão persistida e reutilizada).
          </span>
        </label>
        <label className="field">
          Proxy
          <select value={proxyId} onChange={(e) => setProxyId(e.target.value ? Number(e.target.value) : "")}>
            <option value="">Sem proxy</option>
            {proxies.map((p) => (
              <option key={p.id} value={p.id}>
                {PROXY_DOT[p.status]} {p.nome}
              </option>
            ))}
          </select>
        </label>
        <div className="checkrow" style={{ gap: 12 }}>
          <label className="field" style={{ flex: 1 }}>
            Posts/hora (vazio = usar padrão global)
            <input
              type="number"
              min={1}
              value={postsHora}
              onChange={(e) => setPostsHora(e.target.value ? Number(e.target.value) : "")}
            />
          </label>
        </div>
        <div className="checkrow" style={{ gap: 12 }}>
          <label className="field" style={{ flex: 1 }}>
            Janela — início
            <input type="time" value={janelaInicio} onChange={(e) => setJanelaInicio(e.target.value)} />
          </label>
          <label className="field" style={{ flex: 1 }}>
            Janela — fim
            <input type="time" value={janelaFim} onChange={(e) => setJanelaFim(e.target.value)} />
          </label>
        </div>
        <div className="checkrow" style={{ gap: 12 }}>
          <label className="field" style={{ flex: 1 }}>
            Legenda
            <select value={captionMode} onChange={(e) => setCaptionMode(e.target.value as AccountBody["caption_mode"])}>
              <option value="automatica">Automática</option>
              <option value="manual">Manual</option>
            </select>
          </label>
          <label className="field" style={{ flex: 1 }}>
            Áudio
            <select value={audioMode} onChange={(e) => setAudioMode(e.target.value as AccountBody["audio_mode"])}>
              <option value="nenhum">Nenhum</option>
              <option value="manual">Manual</option>
              <option value="automatica">Automático (tendências)</option>
            </select>
          </label>
        </div>

        <label className="checkrow">
          <input type="checkbox" checked={storiesEnabled} onChange={(e) => setStoriesEnabled(e.target.checked)} />
          Stories automáticos (vários por dia)
        </label>

        {storiesEnabled && (
          <>
            <div className="hint">
              Cada story tem um horário e uma sequência de imagens. Vários stories = vários agendamentos no dia.
            </div>
            {storyPlans.map((p, i) => (
              <div key={p.key} className="card" style={{ padding: 10, marginBottom: 8 }}>
                <div className="checkrow" style={{ gap: 8, alignItems: "center" }}>
                  <label className="field" style={{ width: 120 }}>
                    Horário
                    <input
                      type="time"
                      value={p.horario}
                      onChange={(e) =>
                        setStoryPlans((prev) => prev.map((x, j) => (j === i ? { ...x, horario: e.target.value } : x)))
                      }
                    />
                  </label>
                  <label className="field" style={{ flex: 1 }}>
                    Texto
                    <input
                      value={p.texto}
                      onChange={(e) =>
                        setStoryPlans((prev) => prev.map((x, j) => (j === i ? { ...x, texto: e.target.value } : x)))
                      }
                      placeholder="Confere aí 👇"
                    />
                  </label>
                  <label className="field" style={{ flex: 1 }}>
                    Link (opcional)
                    <input
                      value={p.link}
                      onChange={(e) =>
                        setStoryPlans((prev) => prev.map((x, j) => (j === i ? { ...x, link: e.target.value } : x)))
                      }
                      placeholder="https://…"
                    />
                  </label>
                  {storyPlans.length > 1 && (
                    <button
                      className="btn danger sm"
                      onClick={() => setStoryPlans((prev) => prev.filter((_, j) => j !== i))}
                    >
                      ✕
                    </button>
                  )}
                </div>
                <label className="field">
                  Imagens (selecione várias para uma sequência — Ctrl/⌘ + clique)
                  <select
                    multiple
                    size={4}
                    value={p.frames.map(String)}
                    onChange={(e) => {
                      const frames = Array.from(e.target.selectedOptions).map((o) => Number(o.value));
                      setStoryPlans((prev) => prev.map((x, j) => (j === i ? { ...x, frames } : x)));
                    }}
                  >
                    {photos.map((ph) => (
                      <option key={ph.id} value={ph.id}>
                        {ph.nome_original}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            ))}
            <button
              className="btn sm"
              onClick={() =>
                setStoryPlans((prev) => [...prev, { key: Date.now() + prev.length, horario: "18:00", frames: [], texto: "", link: "" }])
              }
            >
              ＋ Adicionar story ao dia
            </button>
          </>
        )}

        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" onClick={submit} disabled={!nomeInterno.trim() || !username.trim()}>
            {initial ? "Salvar" : "Criar conta"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function CaptionsManager({
  captions,
  accounts,
  onChange,
}: {
  captions: CaptionTemplate[];
  accounts: PubAccount[];
  onChange: () => void;
}) {
  const [titulo, setTitulo] = useState("");
  const [texto, setTexto] = useState("");
  const [accountId, setAccountId] = useState<number | "">("");
  const [error, setError] = useState<string | null>(null);

  function nomeConta(id: number | null): string {
    if (id === null) return "Global";
    const acc = accounts.find((a) => a.id === id);
    return acc ? `@${acc.username}` : `Conta #${id}`;
  }

  async function add() {
    if (!titulo.trim() || !texto.trim()) return;
    try {
      await createCaption(titulo.trim(), texto.trim(), accountId === "" ? null : accountId);
      setTitulo("");
      setTexto("");
      setAccountId("");
      onChange();
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-main" style={{ width: "100%" }}>
        <strong>Legendas (modelos globais e por conta)</strong>
        <p className="hint">
          Use variáveis: {"{{username}} {{date}} {{number}} {{random_emoji}}"} · A legenda específica da conta tem
          prioridade sobre a global.
        </p>
        {error && <div className="error">⚠️ {error}</div>}
        <ul className="list" style={{ marginTop: 10 }}>
          {captions.map((c) => (
            <li key={c.id} className="card">
              <div className="card-main">
                <strong>
                  {c.titulo} <span className="badge">{nomeConta(c.account_id)}</span>
                  {c.account_id === null && <span className="badge ia">padrão</span>}
                </strong>
                <div className="meta">{c.texto}</div>
              </div>
              <div className="card-actions">
                <button className="btn sm" onClick={() => updateCaption(c.id, { ativo: !c.ativo }).then(onChange)}>
                  {c.ativo ? "Desativar" : "Ativar"}
                </button>
                <button className="btn danger sm" onClick={() => deleteCaption(c.id).then(onChange)}>
                  Excluir
                </button>
              </div>
            </li>
          ))}
          {captions.length === 0 && <li className="empty">Nenhuma legenda cadastrada.</li>}
        </ul>
        <div className="checkrow" style={{ gap: 8, marginTop: 8 }}>
          <input placeholder="Título" value={titulo} onChange={(e) => setTitulo(e.target.value)} style={{ width: 140 }} />
          <input placeholder="Texto da legenda…" value={texto} onChange={(e) => setTexto(e.target.value)} style={{ flex: 1 }} />
          <select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : "")}
            style={{ width: 160 }}
          >
            <option value="">Global (todas)</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                @{a.username}
              </option>
            ))}
          </select>
          <button className="btn primary sm" onClick={add} disabled={!titulo.trim() || !texto.trim()}>
            ＋ Adicionar
          </button>
        </div>
      </div>
    </div>
  );
}

const STATUS_BADGE: Record<string, string> = {
  rascunho: "⚪ Rascunho",
  conectando: "🟡 Conectando",
  pronta: "🟢 Pronta",
  pausada: "⏸️ Pausada",
  erro: "🔴 Erro",
};

function DefaultsManager({ onChange }: { onChange: () => void }) {
  const [d, setD] = useState<PublishingDefaults | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    getPublishingDefaults().then(setD).catch((e) => setMsg(`⚠ ${String(e)}`));
  }, []);

  if (!d) return <div className="card" style={{ marginTop: 16 }}>Carregando configuração global…</div>;

  async function salvar() {
    setMsg(null);
    try {
      await updatePublishingDefaults(d!);
      setMsg("Configuração global salva.");
      onChange();
    } catch (e) {
      setMsg(`⚠ ${String(e)}`);
    }
  }

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-main" style={{ width: "100%" }}>
        <strong>Configuração global de publicação</strong>
        <p className="hint">Vale para todas as contas, exceto quando a conta define um valor próprio.</p>
        {msg && <div className={msg.startsWith("⚠") ? "error" : "hint"}>{msg}</div>}
        <div className="checkrow" style={{ gap: 12, marginTop: 10, flexWrap: "wrap" }}>
          <label className="field" style={{ width: 140 }}>
            Posts/hora
            <input
              type="number"
              min={1}
              value={d.posts_por_hora}
              onChange={(e) => setD({ ...d, posts_por_hora: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            Janela — início
            <input type="time" value={d.janela_inicio} onChange={(e) => setD({ ...d, janela_inicio: e.target.value })} />
          </label>
          <label className="field">
            Janela — fim
            <input type="time" value={d.janela_fim} onChange={(e) => setD({ ...d, janela_fim: e.target.value })} />
          </label>
          <label className="field">
            Timezone
            <input value={d.timezone} onChange={(e) => setD({ ...d, timezone: e.target.value })} placeholder="America/Sao_Paulo" />
          </label>
          <label className="checkrow">
            <input
              type="checkbox"
              checked={d.trending_enabled ?? false}
              onChange={(e) => setD({ ...d, trending_enabled: e.target.checked })}
            />
            Coletar áudios em alta automaticamente
          </label>
          <button className="btn primary sm" onClick={salvar}>
            Salvar global
          </button>
        </div>
        {d.ultima_coleta_em && (
          <div className="meta" style={{ marginTop: 6 }}>
            Última coleta de tendências: {new Date(d.ultima_coleta_em).toLocaleString("pt-BR")}
          </div>
        )}
      </div>
    </div>
  );
}

export default function Accounts() {
  const [accounts, setAccounts] = useState<PubAccount[]>([]);
  const [proxies, setProxies] = useState<Proxy[]>([]);
  const [captions, setCaptions] = useState<CaptionTemplate[]>([]);
  const [photos, setPhotos] = useState<Media[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [formFor, setFormFor] = useState<PubAccount | "new" | null>(null);
  const [toDelete, setToDelete] = useState<PubAccount | null>(null);
  const [connecting, setConnecting] = useState<number | null>(null);
  const [verifying, setVerifying] = useState<number | null>(null);

  function refreshAll() {
    listAccounts().then(setAccounts).catch((e) => setError(String(e)));
    listProxies().then(setProxies).catch((e) => setError(String(e)));
    listCaptions().then(setCaptions).catch((e) => setError(String(e)));
    listMedia("photo").then(setPhotos).catch(() => {});
  }

  useEffect(refreshAll, []);

  async function saveAccount(
    body: AccountBody,
    storyBody?: {
      enabled: boolean;
      horario: string;
      imagem_media_id: number | null;
      texto: string | null;
      link?: string | null;
      plans?: { horario: string; frames: { media_id: number; texto?: string | null; link?: string | null }[] }[];
    }
  ) {
    try {
      let acc: PubAccount;
      if (formFor && formFor !== "new") {
        acc = await updateAccount(formFor.id, body);
      } else {
        acc = await createAccount(body);
      }
      if (storyBody) await updateStoryConfig(acc.id, storyBody);
      setFormFor(null);
      refreshAll();
    } catch (e) {
      setError(String(e));
    }
  }

  async function conectar(a: PubAccount) {
    setConnecting(a.id);
    try {
      await connectAccount(a.id);
      setError(null);
      refreshAll();
    } catch (e) {
      const msg = String(e);
      // 2FA/desafio: pede o código de verificação e tenta de novo (login real)
      if (/challenge|twofactor|two-factor|verifica|2fa|recaptcha/i.test(msg)) {
        const codigo = window.prompt(`@${a.username} pediu verificação. Código (SMS/e-mail/app):`);
        if (codigo?.trim()) {
          try {
            await connectAccount(a.id, codigo.trim());
            setError(null);
            refreshAll();
          } catch (e2) {
            setError(String(e2));
          }
        }
      } else {
        setError(msg);
      }
      refreshAll();
    } finally {
      setConnecting(null);
    }
  }

  async function verificar(a: PubAccount) {
    setVerifying(a.id);
    try {
      const r = await verifyAccountSession(a.id);
      if (r.valida) setError(null);
      else setError(`Sessão de @${a.username} expirada — reconecte a conta.`);
      refreshAll();
    } catch (e) {
      setError(String(e));
    } finally {
      setVerifying(null);
    }
  }

  return (
    <>
      <p className="sub">Contas/perfis, proxy opcional e configuração de publicação por conta.</p>
      {error && <div className="error">⚠️ {error}</div>}

      <ProxyManager proxies={proxies} onChange={refreshAll} />
      <DefaultsManager onChange={refreshAll} />

      <div className="selbar" style={{ marginBottom: 12 }}>
        <span>{accounts.length} conta(s)</span>
        <button className="btn primary sm" onClick={() => setFormFor("new")}>
          ＋ Adicionar perfil
        </button>
      </div>

      <ul className="list">
        {accounts.map((a) => (
          <li key={a.id} className="card">
            <div className="card-main">
              <strong>
                @{a.username} <span className="badge">{a.nome_interno}</span>
              </strong>
              <div className="meta">
                {STATUS_BADGE[a.status]}
                {a.automation_status === "pausada" && a.status === "pronta" && <> · ⏸️ Automação pausada</>}
                {" · "}
                {a.senha_configurada ? "🔒 Senha configurada" : "⚠ Sem senha"}
                {" · "}
                {a.session_configurada ? "🔑 Sessão salva" : "⚠ Sem sessão"}
                {a.proxy && <> · {PROXY_DOT[a.proxy.status]} {a.proxy.nome}</>}
                {" · "}
                {a.posts_por_hora ?? "padrão"} posts/h · {a.janela_inicio ?? "—"}→{a.janela_fim ?? "—"}
                {a.stories_enabled && <> · 📖 Stories ativo</>}
              </div>
              {a.ultimo_erro && <div className="meta" style={{ color: "var(--danger)" }}>⚠ {a.ultimo_erro}</div>}
            </div>
            <div className="card-actions" style={{ flexWrap: "wrap" }}>
              <button className="btn primary sm" onClick={() => conectar(a)} disabled={connecting === a.id}>
                {connecting === a.id ? "Conectando…" : "🔗 Conectar"}
              </button>
              {a.session_configurada && (
                <button className="btn sm" onClick={() => verificar(a)} disabled={verifying === a.id}>
                  {verifying === a.id ? "Verificando…" : "✓ Verificar sessão"}
                </button>
              )}
              {a.status === "pronta" && a.automation_status !== "pausada" && (
                <button className="btn sm" onClick={() => pauseAccount(a.id).then(refreshAll)}>
                  Pausar
                </button>
              )}
              {a.status === "pronta" && a.automation_status === "pausada" && (
                <button className="btn sm" onClick={() => resumeAccount(a.id).then(refreshAll)}>
                  Retomar
                </button>
              )}
              <button className="btn sm" onClick={() => setFormFor(a)}>
                Editar
              </button>
              <button className="btn danger sm" onClick={() => setToDelete(a)}>
                Excluir
              </button>
            </div>
          </li>
        ))}
        {accounts.length === 0 && <li className="empty">Nenhuma conta cadastrada ainda.</li>}
      </ul>

      <CaptionsManager captions={captions} accounts={accounts} onChange={refreshAll} />

      {formFor && (
        <AccountForm
          proxies={proxies}
          photos={photos}
          initial={formFor === "new" ? undefined : formFor}
          onSave={saveAccount}
          onClose={() => setFormFor(null)}
        />
      )}
      {toDelete && (
        <ConfirmDialog
          title="Excluir conta"
          confirmLabel="Excluir conta"
          message={
            <>
              Excluir a conta <strong>@{toDelete.username}</strong>? Conteúdos já atribuídos a ela ficam sem conta.
            </>
          }
          onConfirm={() => {
            deleteAccount(toDelete.id).then(() => {
              setToDelete(null);
              refreshAll();
            });
          }}
          onClose={() => setToDelete(null)}
        />
      )}
    </>
  );
}
