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
  listProxies,
  pauseAccount,
  regenerateFingerprint,
  resumeAccount,
  updateAccount,
  updateCaption,
  updateProxy,
  updatePublishingDefaults,
  updateStoryConfig,
  verifyAccountSession,
  type AccountBody,
  type CaptionTemplate,
  type Proxy,
  type PubAccount,
  type PublishingDefaults,
} from "./api";

const PROXY_DOT: Record<string, string> = { verde: "🟢", amarelo: "🟡", vermelho: "🔴", cinza: "⚪" };

const LOCALES = ["pt_BR", "en_US", "es_ES", "pt_PT", "fr_FR", "it_IT", "de_DE"];

type ScheduleMode = "hora" | "ciclo" | "horarios";

function inferScheduleMode(a?: {
  horarios_selecionados?: string[] | null;
  posts_por_ciclo?: number | null;
  horas_por_ciclo?: number | null;
}): ScheduleMode {
  // mesma prioridade do backend: horários fixos > ciclo > posts/hora
  if (a?.horarios_selecionados?.length) return "horarios";
  if (a?.posts_por_ciclo && a?.horas_por_ciclo) return "ciclo";
  return "hora";
}

function HourPicker({
  selecionados,
  onChange,
}: {
  selecionados: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const horas = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00`);
  function toggle(h: string) {
    const next = new Set(selecionados);
    next.has(h) ? next.delete(h) : next.add(h);
    onChange(next);
  }
  return (
    <div style={{ marginTop: 4 }}>
      <div className="checkrow" style={{ gap: 6, marginBottom: 6 }}>
        <button type="button" className="btn sm" onClick={() => onChange(new Set(horas))}>
          Todos
        </button>
        <button type="button" className="btn sm" onClick={() => onChange(new Set())}>
          Limpar
        </button>
        <span className="hint">{selecionados.size} selecionado(s)</span>
      </div>
      <div className="checkrow" style={{ gap: 4, flexWrap: "wrap" }}>
        {horas.map((h) => {
          const on = selecionados.has(h);
          return (
            <button
              key={h}
              type="button"
              onClick={() => toggle(h)}
              style={{
                padding: "3px 8px",
                fontSize: 12,
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: on ? "var(--blue)" : "var(--surface)",
                color: on ? "#fff" : "var(--text)",
                cursor: "pointer",
              }}
            >
              {h}
            </button>
          );
        })}
      </div>
    </div>
  );
}

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
  const [novo, setNovo] = useState(false);
  const [url, setUrl] = useState("");
  const [nomeInterno, setNomeInterno] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [editando, setEditando] = useState<Proxy | null>(null);
  const [editNome, setEditNome] = useState("");
  const [editProtocolo, setEditProtocolo] = useState("socks5");
  const [editHost, setEditHost] = useState("");
  const [editPorta, setEditPorta] = useState("");
  const [editUsuario, setEditUsuario] = useState("");
  const [editSenha, setEditSenha] = useState("");
  const [editError, setEditError] = useState<string | null>(null);

  async function add() {
    const parsed = parseProxyUrl(url);
    if (!parsed) {
      setError("URL inválida — use o formato socks5://usuario:senha@host:porta");
      return;
    }
    try {
      await createProxy({
        ...(nomeInterno.trim() ? { nome_interno: nomeInterno.trim() } : {}),
        host: parsed.host,
        porta: parsed.porta,
        protocolo: parsed.protocolo,
        usuario: parsed.usuario,
        senha: parsed.senha,
      });
      setUrl("");
      setNomeInterno("");
      setNovo(false);
      onChange();
    } catch (e) {
      setError(String(e));
    }
  }

  function startEdit(p: Proxy) {
    setEditando(p);
    setEditNome(p.nome_interno);
    setEditProtocolo(p.protocolo);
    setEditHost(p.host);
    setEditPorta(String(p.porta));
    setEditUsuario(p.usuario ?? "");
    setEditSenha("");
    setEditError(null);
  }

  async function saveEdit() {
    if (editando === null) return;
    const porta = Number(editPorta);
    if (!editHost.trim() || !Number.isInteger(porta) || porta <= 0 || porta > 65535) {
      setEditError("Informe host e porta válidos.");
      return;
    }
    try {
      await updateProxy(editando.id, {
        ...(editNome.trim() ? { nome_interno: editNome.trim() } : {}),
        protocolo: editProtocolo,
        host: editHost.trim(),
        porta,
        usuario: editUsuario.trim() || null,
        ...(editSenha ? { senha: editSenha } : {}),
      });
      setEditando(null);
      onChange();
    } catch (e) {
      setEditError(String(e));
    }
  }

  return (
    <div className="card">
      <div className="card-main" style={{ width: "100%" }}>
        <ul className="list">
          {proxies.map((p) => (
            <li key={p.id} className="card">
              <div className="card-main">
                <strong>
                  {PROXY_DOT[p.status]} {p.nome_interno}
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
                <button className="btn sm" onClick={() => startEdit(p)}>
                  Editar
                </button>
                <button className="btn danger sm" onClick={() => deleteProxy(p.id).then(onChange)}>
                  Excluir
                </button>
              </div>
            </li>
          ))}
          {proxies.length === 0 && <li className="empty">Nenhum proxy cadastrado — contas sem proxy publicam direto.</li>}
        </ul>

        <button className="btn sm" onClick={() => setNovo(true)}>
          ＋ Novo proxy
        </button>
      </div>

      {novo && (
        <Modal title="Novo proxy" onClose={() => setNovo(false)}>
          <div className="form">
            {error && <div className="error">⚠️ {error}</div>}
            <label className="field">
              Nome interno (opcional — padrão: host:porta)
              <input
                value={nomeInterno}
                onChange={(e) => setNomeInterno(e.target.value)}
                placeholder="Ex.: Proxy EUA"
                onKeyDown={(e) => e.key === "Enter" && add()}
              />
            </label>
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
              <button className="btn ghost" onClick={() => setNovo(false)}>
                Cancelar
              </button>
            </div>
          </div>
        </Modal>
      )}

      {editando && (
        <Modal title={`Editar proxy — ${editando.nome_interno}`} onClose={() => setEditando(null)}>
          <div className="form">
            <div className="checkrow" style={{ gap: 8 }}>
              <label className="field" style={{ flex: 2 }}>
                Nome interno
                <input
                  value={editNome}
                  onChange={(e) => setEditNome(e.target.value)}
                  placeholder="Ex.: Proxy EUA"
                />
              </label>
              <label className="field" style={{ flex: 1 }}>
                Protocolo
                <select value={editProtocolo} onChange={(e) => setEditProtocolo(e.target.value)}>
                  <option value="socks5">socks5</option>
                  <option value="http">http</option>
                </select>
              </label>
            </div>
            <div className="checkrow" style={{ gap: 8 }}>
              <label className="field" style={{ flex: 3 }}>
                Host
                <input value={editHost} onChange={(e) => setEditHost(e.target.value)} />
              </label>
              <label className="field" style={{ flex: 1 }}>
                Porta
                <input type="number" value={editPorta} onChange={(e) => setEditPorta(e.target.value)} />
              </label>
            </div>
            <div className="checkrow" style={{ gap: 8 }}>
              <label className="field" style={{ flex: 1 }}>
                Usuário
                <input value={editUsuario} onChange={(e) => setEditUsuario(e.target.value)} autoComplete="off" />
              </label>
              <label className="field" style={{ flex: 1 }}>
                Senha
                <input
                  type="password"
                  value={editSenha}
                  onChange={(e) => setEditSenha(e.target.value)}
                  placeholder="•••••• (em branco = manter)"
                  autoComplete="new-password"
                />
              </label>
            </div>
            {editError && <div className="error">⚠️ {editError}</div>}
            <div className="modal-actions">
              <button className="btn ghost sm" onClick={() => setEditando(null)}>
                Cancelar
              </button>
              <button className="btn primary sm" onClick={saveEdit}>
                Salvar
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function AccountForm({
  proxies,
  initial,
  onSave,
  onClose,
}: {
  proxies: Proxy[];
  initial?: PubAccount;
  // o check "Stories automáticos" continua aqui; a MONTAGEM dos stories
  // (imagens, horários, textos, links) fica no tab dedicado "Stories".
  onSave: (body: AccountBody, storiesEnabled: boolean, gerarFingerprint: boolean) => void;
  onClose: () => void;
}) {
  const [nomeInterno, setNomeInterno] = useState(initial?.nome_interno ?? "");
  const [username, setUsername] = useState(initial?.username ?? "");
  const [senha, setSenha] = useState("");
  const [sessionid, setSessionid] = useState("");
  const [proxyId, setProxyId] = useState<number | "">(initial?.proxy_id ?? "");
  const [postsHora, setPostsHora] = useState<number | "">(initial?.posts_por_hora ?? "");
  const [postsCiclo, setPostsCiclo] = useState<number | "">(initial?.posts_por_ciclo ?? "");
  const [horasCiclo, setHorasCiclo] = useState<number | "">(initial?.horas_por_ciclo ?? "");
  const [horarios, setHorarios] = useState<Set<string>>(new Set(initial?.horarios_selecionados ?? []));
  const [modo, setModo] = useState<ScheduleMode>(inferScheduleMode(initial));
  const [formError, setFormError] = useState<string | null>(null);
  const [janelaInicio, setJanelaInicio] = useState(initial?.janela_inicio ?? "");
  const [janelaFim, setJanelaFim] = useState(initial?.janela_fim ?? "");
  const [captionMode, setCaptionMode] = useState<AccountBody["caption_mode"]>(initial?.caption_mode ?? "automatica");
  const [audioMode, setAudioMode] = useState<AccountBody["audio_mode"]>(initial?.audio_mode ?? "nenhum");
  const [idioma, setIdioma] = useState(initial?.idioma ?? "");
  const [gerarFingerprint, setGerarFingerprint] = useState(false);
  const [storiesEnabled, setStoriesEnabled] = useState(initial?.stories_enabled ?? false);

  function submit() {
    if (!nomeInterno.trim() || !username.trim()) return;
    if (modo === "ciclo" && (postsCiclo === "" || horasCiclo === "")) {
      setFormError("Modo “por ciclo”: preencha quantos posts (X) e a cada quantas horas (Y).");
      return;
    }
    if (modo === "horarios" && horarios.size === 0) {
      setFormError("Modo “horários fixos”: marque ao menos um horário (ou escolha outro modo).");
      return;
    }
    setFormError(null);
    const body: AccountBody = {
      nome_interno: nomeInterno.trim(),
      username: username.trim(),
      ...(senha.trim() ? { senha: senha.trim() } : {}),
      ...(sessionid.trim() ? { sessionid: sessionid.trim() } : {}),
      proxy_id: proxyId === "" ? null : proxyId,
      posts_por_hora: modo === "hora" ? (postsHora === "" ? null : postsHora) : null,
      posts_por_ciclo: modo === "ciclo" ? (postsCiclo === "" ? null : postsCiclo) : null,
      horas_por_ciclo: modo === "ciclo" ? (horasCiclo === "" ? null : horasCiclo) : null,
      horarios_selecionados: modo === "horarios" && horarios.size ? [...horarios].sort() : null,
      idioma: idioma || null,
      janela_inicio: janelaInicio || null,
      janela_fim: janelaFim || null,
      caption_mode: captionMode,
      audio_mode: audioMode,
      stories_enabled: storiesEnabled,
    };
    onSave(body, storiesEnabled, gerarFingerprint);
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
          Sessionid (cookie do navegador){" "}
          {initial?.sessionid_configurada ? "(já configurado — deixe em branco para manter)" : ""}
          <input
            type="password"
            value={sessionid}
            onChange={(e) => setSessionid(e.target.value)}
            placeholder={initial?.sessionid_configurada ? "••••••••" : "Cole o cookie sessionid"}
            autoComplete="new-password"
          />
          <span className="hint">
            Contorna o bloqueio 429 de login: abra o Instagram já logado no navegador, copie o valor do cookie{" "}
            <code>sessionid</code> (F12 → Application → Cookies) e cole aqui. Guardado criptografado.
          </span>
        </label>
        <label className="field">
          Proxy
          <select value={proxyId} onChange={(e) => setProxyId(e.target.value ? Number(e.target.value) : "")}>
            <option value="">Sem proxy</option>
            {proxies.map((p) => (
              <option key={p.id} value={p.id}>
                {PROXY_DOT[p.status]} {p.nome_interno}
              </option>
            ))}
          </select>
        </label>
        <div className="checkrow" style={{ gap: 12 }}>
          <label className="field" style={{ flex: 1 }}>
            Idioma (locale do app)
            <select value={idioma} onChange={(e) => setIdioma(e.target.value)}>
              <option value="">padrão (pt_BR)</option>
              {LOCALES.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="field">
          Fingerprint do dispositivo
          {initial?.fingerprint_resumo ? (
            <div className="hint">
              Atual: <strong>{initial.fingerprint_resumo}</strong>
            </div>
          ) : (
            <div className="hint">Sem fingerprint salva — a conta loga com o device padrão do sistema.</div>
          )}
          <button
            type="button"
            className={`btn sm${gerarFingerprint ? " primary" : ""}`}
            onClick={() => setGerarFingerprint(true)}
            disabled={gerarFingerprint}
          >
            {gerarFingerprint ? "✓ Nova fingerprint será gerada ao salvar" : "🎲 Gerar nova fingerprint"}
          </button>
          <span className="hint">
            Cada conta loga de um aparelho próprio (modelo, resolução, user-agent, uuids, idioma e fuso) —
            igual às opções de navegador anti-deteção, para o Instagram não cruzar as contas entre si.
          </span>
        </div>
        <div className="field">
          Modo de agendamento
          <nav className="tabs" style={{ marginTop: 4 }}>
            <button type="button" className={modo === "hora" ? "tab active" : "tab"} onClick={() => setModo("hora")}>
              🕐 Posts/hora
            </button>
            <button type="button" className={modo === "ciclo" ? "tab active" : "tab"} onClick={() => setModo("ciclo")}>
              🔁 Por ciclo
            </button>
            <button type="button" className={modo === "horarios" ? "tab active" : "tab"} onClick={() => setModo("horarios")}>
              ⏰ Horários fixos
            </button>
          </nav>
          {modo === "hora" && (
            <>
              <div className="checkrow" style={{ gap: 12, marginTop: 8 }}>
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
              <div className="hint">Limite simples por hora. Alto demais cai em spam.</div>
            </>
          )}
          {modo === "ciclo" && (
            <>
              <div className="checkrow" style={{ gap: 12, marginTop: 8 }}>
                <label className="field" style={{ flex: 1 }}>
                  Posts por ciclo — X
                  <input
                    type="number"
                    min={1}
                    value={postsCiclo}
                    onChange={(e) => setPostsCiclo(e.target.value ? Number(e.target.value) : "")}
                  />
                </label>
                <label className="field" style={{ flex: 1 }}>
                  A cada (horas) — Y
                  <input
                    type="number"
                    min={0.5}
                    step={0.5}
                    value={horasCiclo}
                    onChange={(e) => setHorasCiclo(e.target.value ? Number(e.target.value) : "")}
                  />
                </label>
              </div>
              <div className="hint">
                Ex.: <strong>2 posts a cada 3 horas</strong> → um post a cada ~1h30. Ritmo mais
                natural/humano que um teto fixo por hora.
              </div>
            </>
          )}
          {modo === "horarios" && (
            <>
              <div style={{ marginTop: 8 }}>
                <HourPicker selecionados={horarios} onChange={setHorarios} />
              </div>
              <span className="hint">
                1 post por horário/dia, com offset aleatório de ±15min (nunca repete o horário exato).
                O que não couber hoje vai para o dia seguinte.
              </span>
            </>
          )}
        </div>
        {formError && <div className="error">⚠️ {formError}</div>}
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
        <div className="hint">
          Este check só liga/desliga a automação de stories da conta. As imagens, horários, textos e links de
          cada story são montados no tab <strong>Stories</strong>.
        </div>

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
    <div className="card">
      <div className="card-main" style={{ width: "100%" }}>
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

function VerificationModal({
  account,
  onClose,
  onConfirm,
}: {
  account: PubAccount;
  onClose: () => void;
  onConfirm: (codigo: string) => Promise<void>;
}) {
  const [codigo, setCodigo] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function enviar() {
    if (!codigo.trim() || enviando) return;
    setEnviando(true);
    setErro(null);
    try {
      await onConfirm(codigo.trim());
      // sucesso: o pai fecha o modal
    } catch (e) {
      setErro(String(e));
      setEnviando(false);
    }
  }

  return (
    <Modal title={`Verificação de login — @${account.username}`} onClose={onClose}>
      <p className="hint" style={{ marginTop: 0 }}>
        O Instagram pediu uma verificação extra para <strong>@{account.username}</strong>. Confira o
        código enviado por <strong>SMS, e-mail ou app autenticador</strong> e cole abaixo.
      </p>
      {erro && <div className="error">⚠️ {erro}</div>}
      <label className="field">
        Código de verificação
        <input
          value={codigo}
          onChange={(e) => setCodigo(e.target.value)}
          placeholder="Ex.: 123456"
          autoFocus
          autoComplete="one-time-code"
          onKeyDown={(e) => e.key === "Enter" && enviar()}
        />
      </label>
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          Cancelar
        </button>
        <button type="button" className="btn primary" disabled={!codigo.trim() || enviando} onClick={enviar}>
          {enviando ? "Verificando…" : "Enviar código"}
        </button>
      </div>
    </Modal>
  );
}

function DefaultsManager({ onChange }: { onChange: () => void }) {
  const [d, setD] = useState<PublishingDefaults | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // aba escolhida é ESTADO próprio (não derivado de d): trocar para "ciclo" com X/Y ainda
  // em 0 não pode fazer a aba voltar sozinha para "hora" — senão o usuário nunca
  // consegue preencher os campos do modo novo.
  const [modo, setModoTab] = useState<ScheduleMode>("hora");

  useEffect(() => {
    getPublishingDefaults()
      .then((data) => {
        setD(data);
        setModoTab(inferScheduleMode(data)); // sincroniza a aba com o que já está salvo
      })
      .catch((e) => setMsg(`⚠ ${String(e)}`));
  }, []);

  const escolherModo = (m: ScheduleMode) => {
    if (!d) return;
    setModoTab(m);
    if (m === "hora") setD({ ...d, posts_por_ciclo: 0, horas_por_ciclo: 0, horarios_selecionados: null });
    if (m === "ciclo") setD({ ...d, horarios_selecionados: null });
    if (m === "horarios") setD({ ...d, posts_por_ciclo: 0, horas_por_ciclo: 0 });
  };

  const salvar = async () => {
    if (!d) return;
    setMsg(null);
    if (modo === "ciclo" && (!d.posts_por_ciclo || !d.horas_por_ciclo)) {
      setMsg("⚠ Modo “por ciclo”: preencha X e Y (ou escolha outro modo).");
      return;
    }
    if (modo === "horarios" && !(d.horarios_selecionados?.length)) {
      setMsg("⚠ Modo “horários fixos”: marque ao menos um horário (ou escolha outro modo).");
      return;
    }
    try {
      await updatePublishingDefaults(d);
      setMsg("Configuração global salva.");
      onChange();
    } catch (e) {
      setMsg(`⚠ ${String(e)}`);
    }
  };

  return (
    <div className="card">
      <div className="card-main" style={{ width: "100%" }}>
        {!d && <div className="hint">Carregando configuração…</div>}
        {d && (
          <>
        <p className="hint">Vale para todas as contas, exceto quando a conta define um valor próprio.</p>
        {msg && <div className={msg.startsWith("⚠") ? "error" : "hint"}>{msg}</div>}
        <div className="checkrow" style={{ gap: 12, marginTop: 10, flexWrap: "wrap" }}>
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
          <button className="btn primary sm" onClick={salvar}>
            Salvar global
          </button>
        </div>
        <div className="field">
          Modo de agendamento
          <nav className="tabs" style={{ marginTop: 4 }}>
            <button type="button" className={modo === "hora" ? "tab active" : "tab"} onClick={() => escolherModo("hora")}>
              🕐 Posts/hora
            </button>
            <button type="button" className={modo === "ciclo" ? "tab active" : "tab"} onClick={() => escolherModo("ciclo")}>
              🔁 Por ciclo
            </button>
            <button type="button" className={modo === "horarios" ? "tab active" : "tab"} onClick={() => escolherModo("horarios")}>
              ⏰ Horários fixos
            </button>
          </nav>
          {modo === "hora" && (
            <div className="checkrow" style={{ gap: 12, marginTop: 8 }}>
              <label className="field" style={{ width: 140 }}>
                Posts/hora
                <input
                  type="number"
                  min={1}
                  value={d.posts_por_hora}
                  onChange={(e) => setD({ ...d, posts_por_hora: Number(e.target.value) })}
                />
              </label>
              <span className="hint">Limite simples por hora — alto demais cai em spam.</span>
            </div>
          )}
          {modo === "ciclo" && (
            <div className="checkrow" style={{ gap: 12, marginTop: 8 }}>
              <label className="field" style={{ width: 130 }}>
                Posts por ciclo — X
                <input
                  type="number"
                  min={1}
                  value={d.posts_por_ciclo}
                  onChange={(e) => setD({ ...d, posts_por_ciclo: Number(e.target.value) })}
                />
              </label>
              <label className="field" style={{ width: 140 }}>
                A cada (horas) — Y
                <input
                  type="number"
                  min={0.5}
                  step={0.5}
                  value={d.horas_por_ciclo}
                  onChange={(e) => setD({ ...d, horas_por_ciclo: Number(e.target.value) })}
                />
              </label>
              <span className="hint">Ex.: 2 a cada 3h → um post a cada ~1h30.</span>
            </div>
          )}
          {modo === "horarios" && (
            <div style={{ marginTop: 8 }}>
              <HourPicker
                selecionados={new Set(d.horarios_selecionados ?? [])}
                onChange={(next) => setD({ ...d, horarios_selecionados: next.size ? [...next].sort() : null })}
              />
              <span className="hint">1 post por horário/dia, com offset aleatório de ±15min.</span>
            </div>
          )}
        </div>
        <p className="hint">
          Cada conta pode escolher o próprio modo de agendamento — o que estiver aqui vale como padrão
          (janela, timezone e modo) para as contas sem override.
        </p>
          </>
        )}
      </div>
    </div>
  );
}

export default function Accounts() {
  const [tab, setTab] = useState<"contas" | "proxies" | "global" | "legendas">("contas");
  const [accounts, setAccounts] = useState<PubAccount[]>([]);
  const [proxies, setProxies] = useState<Proxy[]>([]);
  const [captions, setCaptions] = useState<CaptionTemplate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [formFor, setFormFor] = useState<PubAccount | "new" | null>(null);
  const [toDelete, setToDelete] = useState<PubAccount | null>(null);
  const [verifPara, setVerifPara] = useState<PubAccount | null>(null);
  const [connecting, setConnecting] = useState<number | null>(null);
  const [verifying, setVerifying] = useState<number | null>(null);

  function refreshAll() {
    listAccounts().then(setAccounts).catch((e) => setError(String(e)));
    listProxies().then(setProxies).catch((e) => setError(String(e)));
    listCaptions().then(setCaptions).catch((e) => setError(String(e)));
  }

  useEffect(refreshAll, []);

  async function saveAccount(body: AccountBody, storiesEnabled: boolean, gerarFingerprint: boolean) {
    try {
      let acc: PubAccount;
      if (formFor && formFor !== "new") {
        acc = await updateAccount(formFor.id, body);
      } else {
        acc = await createAccount(body);
      }
      if (gerarFingerprint) {
        acc = await regenerateFingerprint(acc.id);
      }
      // sincroniza o check com o StoryConfig da conta (sem tocar nos plans)
      await updateStoryConfig(acc.id, { enabled: storiesEnabled });
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
      // 2FA/desafio: abre o modal de código de verificação e tenta de novo (login real)
      if (/challenge|twofactor|two-factor|verifica|2fa|recaptcha/i.test(msg)) {
        setVerifPara(a);
      } else {
        setError(msg);
      }
      refreshAll();
    } finally {
      setConnecting(null);
    }
  }

  async function confirmarCodigo(codigo: string) {
    if (!verifPara) return;
    await connectAccount(verifPara.id, codigo); // erro rejeita e o modal mostra
    setVerifPara(null);
    setError(null);
    refreshAll();
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

      <nav className="tabs">
        <button type="button" className={tab === "contas" ? "tab active" : "tab"} onClick={() => setTab("contas")}>
          📱 Contas ({accounts.length})
        </button>
        <button type="button" className={tab === "proxies" ? "tab active" : "tab"} onClick={() => setTab("proxies")}>
          🛡️ Proxies ({proxies.length})
        </button>
        <button type="button" className={tab === "global" ? "tab active" : "tab"} onClick={() => setTab("global")}>
          ⚙️ Config global
        </button>
        <button type="button" className={tab === "legendas" ? "tab active" : "tab"} onClick={() => setTab("legendas")}>
          ✍️ Legendas ({captions.length})
        </button>
      </nav>

      {tab === "proxies" && <ProxyManager proxies={proxies} onChange={refreshAll} />}
      {tab === "global" && <DefaultsManager onChange={refreshAll} />}
      {tab === "legendas" && <CaptionsManager captions={captions} accounts={accounts} onChange={refreshAll} />}

      {tab === "contas" && (
        <>
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
                {!a.ativa && <> · ⛔ Conta desativada</>}
                {a.automation_status === "pausada" && a.status === "pronta" && <> · ⏸️ Automação pausada</>}
                {" · "}
                {a.senha_configurada ? "🔒 Senha configurada" : "⚠ Sem senha"}
                {a.sessionid_configurada && <> · 🍪 Cookie de sessão configurado</>}
                {" · "}
                {a.session_configurada ? "🔑 Sessão salva" : "⚠ Sem sessão"}
                {a.proxy && <> · {PROXY_DOT[a.proxy.status]} {a.proxy.nome_interno}</>}
                {" · "}
                {a.horarios_selecionados?.length
                  ? `⏰ ${a.horarios_selecionados.length} horário(s) fixo(s)`
                  : a.posts_por_ciclo && a.horas_por_ciclo
                    ? `${a.posts_por_ciclo} posts a cada ${a.horas_por_ciclo}h`
                    : `${a.posts_por_hora ?? "padrão"} posts/h`}{" · "}
                {a.janela_inicio ?? "—"}→{a.janela_fim ?? "—"}
                {a.stories_enabled && <> · 📖 Stories ativo</>}
                {a.fingerprint_resumo && <> · 🎭 {a.fingerprint_resumo}</>}
              </div>
              {a.ultimo_erro && <div className="meta" style={{ color: "var(--danger)" }}>⚠ {a.ultimo_erro}</div>}
            </div>
            <div className="card-actions" style={{ flexWrap: "wrap" }}>
              <button className="btn primary sm" onClick={() => conectar(a)} disabled={connecting === a.id}>
                {connecting === a.id ? "Conectando…" : "🔗 Conectar"}
              </button>
              <button
                className={a.ativa ? "btn sm" : "btn primary sm"}
                onClick={() => updateAccount(a.id, { ativa: !a.ativa }).then(refreshAll)}
                title={
                  a.ativa
                    ? "Desativar a conta: ela não participa de distribuição, não agenda e não publica nada (nem story, nem reel) enquanto desativada"
                    : "Reativar a conta: volta a participar de distribuição, agendamento e publicação"
                }
              >
                {a.ativa ? "⛔ Desativar" : "✅ Ativar"}
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
        </>
      )}

      {formFor && (
        <AccountForm
          proxies={proxies}
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
      {verifPara && (
        <VerificationModal
          account={verifPara}
          onClose={() => setVerifPara(null)}
          onConfirm={confirmarCodigo}
        />
      )}
    </>
  );
}
