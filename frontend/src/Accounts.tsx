import { useEffect, useRef, useState } from "react";
import { MoreVertical, Pause, Pencil, Play, Plus, Save, ShieldCheck, Trash2, Wifi } from "lucide-react";
import { DropdownMenu, MenuItem, Modal, ConfirmDialog, ErrorBanner } from "./Dialog";
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
 *   - Invertido:  "host:porta@usuario:senha"  (ex.: 62.93.164.201:50000@user:pass)
 */
function parseProxyUrl(raw: string): { protocolo: string; host: string; porta: number; usuario?: string; senha?: string } | null {
  let value = raw.trim();
  if (!value) return null;
  {
    // formato invertido: [protocolo://]host:porta@usuario:senha (senha pode conter ":" e "@")
    const m = value.match(/^(?:([a-zA-Z][a-zA-Z0-9+.-]*):\/\/)?([^\s:@/]+):(\d+)@([^:]*)(?::(.*))?$/);
    if (m && !/:\d+$/.test(value.slice(value.indexOf("@") + 1))) {
      const [, proto, host, porta, usuario, senha] = m;
      return {
        protocolo: (proto || "socks5").toLowerCase(),
        host,
        porta: Number(porta),
        ...(usuario ? { usuario } : {}),
        ...(senha ? { senha } : {}),
      };
    }
  }
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
  const [editUrl, setEditUrl] = useState("");
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
    const auth = p.usuario
      ? `${encodeURIComponent(p.usuario)}${p.senha ? `:${encodeURIComponent(p.senha)}` : ""}@`
      : "";
    setEditUrl(`${p.protocolo}://${auth}${p.host}:${p.porta}`);
    setEditError(null);
  }

  async function saveEdit() {
    if (editando === null) return;
    const parsed = parseProxyUrl(editUrl);
    if (!parsed || !Number.isInteger(parsed.porta) || parsed.porta <= 0 || parsed.porta > 65535) {
      setEditError("URL inválida — use o formato socks5://usuario:senha@host:porta");
      return;
    }
    try {
      await updateProxy(editando.id, {
        ...(editNome.trim() ? { nome_interno: editNome.trim() } : {}),
        protocolo: parsed.protocolo,
        host: parsed.host,
        porta: parsed.porta,
        usuario: parsed.usuario ?? null,
        senha: parsed.senha ?? null,
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
                  {p.tipo_ip && p.tipo_ip !== "desconhecido" && (
                    <>
                      {" · "}
                      {TIPO_IP_LABEL[p.tipo_ip]}
                      {p.provedor_ip ? ` (${p.provedor_ip})` : ""}
                    </>
                  )}
                  {p.ultimo_erro && <> · {p.ultimo_erro}</>}
                </div>
                {p.tipo_ip === "datacenter" && (
                  <div className="meta" style={{ color: "var(--danger)" }}>
                    ⚠ IP de data center: o Instagram costuma bloquear o login por senha (429) vindo desse tipo de IP.
                    Use proxy residencial ou móvel (4G) — ou conecte a conta pelo cookie sessionid.
                  </div>
                )}
              </div>
              <div className="card-actions">
                <button className="btn ghost sm" onClick={() => checkProxy(p.id).then(onChange)}>
                  <Wifi size={14} /> Testar
                </button>
                <button className="btn ghost sm" onClick={() => startEdit(p)}>
                  <Pencil size={14} /> Editar
                </button>
                <button className="btn danger sm" onClick={() => deleteProxy(p.id).then(onChange)}>
                  <Trash2 size={14} /> Excluir
                </button>
              </div>
            </li>
          ))}
          {proxies.length === 0 && <li className="empty">Nenhum proxy cadastrado — contas sem proxy publicam direto.</li>}
        </ul>

        <div className="checkrow" style={{ justifyContent: "flex-end", marginTop: 12 }}>
          <button className="btn primary sm" onClick={() => setNovo(true)}>
            <Plus size={14} /> Novo proxy
          </button>
        </div>
      </div>

      {novo && (
        <Modal title="Novo proxy" onClose={() => setNovo(false)}>
          <div className="form">
            <ErrorBanner error={error} onClose={() => setError(null)} />
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
                placeholder="socks5://usuario:senha@host:porta — ou — host:porta:usuario:senha — ou — host:porta@usuario:senha"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                style={{ flex: 1 }}
                onKeyDown={(e) => e.key === "Enter" && add()}
              />
              <button className="btn primary" onClick={add}>
                <Plus size={14} /> Adicionar proxy
              </button>
            </div>
            <div className="hint" style={{ marginTop: 6 }}>
              Uma linha só. Formatos aceitos: <code>socks5://usuario:senha@host:porta</code> ou o formato de
              provider <code>host:porta:usuario:senha</code> ou <code>host:porta@usuario:senha</code> (protocolo e porta opcionais — padrão socks5 e 1080).
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
            <ErrorBanner error={editError} onClose={() => setEditError(null)} />
            <label className="field">
              Nome interno
              <input
                value={editNome}
                onChange={(e) => setEditNome(e.target.value)}
                placeholder="Ex.: Proxy EUA"
                onKeyDown={(e) => e.key === "Enter" && saveEdit()}
              />
            </label>
            <input
              placeholder="socks5://usuario:senha@host:porta — ou — host:porta:usuario:senha — ou — host:porta@usuario:senha"
              value={editUrl}
              onChange={(e) => setEditUrl(e.target.value)}
              autoComplete="off"
              onKeyDown={(e) => e.key === "Enter" && saveEdit()}
            />
            <div className="hint" style={{ marginTop: 6 }}>
              Uma linha só, nos mesmos formatos do cadastro: <code>socks5://usuario:senha@host:porta</code> ou{" "}
              <code>host:porta:usuario:senha</code> ou <code>host:porta@usuario:senha</code>.
            </div>
            <div className="modal-actions">
              <button className="btn ghost sm" onClick={() => setEditando(null)}>
                Cancelar
              </button>
              <button className="btn primary sm" onClick={saveEdit}>
                <Save size={14} /> Salvar
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
  // forma de conectar: cookie de sessão (recomendado — não envia senha, não leva 429) ou senha
  const [metodo, setMetodo] = useState<"cookie" | "senha">(
    initial?.senha_configurada && !initial?.sessionid_configurada ? "senha" : "cookie",
  );
  const [janelaInicio, setJanelaInicio] = useState(initial?.janela_inicio ?? "");
  const [janelaFim, setJanelaFim] = useState(initial?.janela_fim ?? "");
  const [captionMode, setCaptionMode] = useState<AccountBody["caption_mode"]>(initial?.caption_mode ?? "automatica");
  const [audioMode, setAudioMode] = useState<AccountBody["audio_mode"]>(initial?.audio_mode ?? "nenhum");
  const [idioma, setIdioma] = useState(initial?.idioma ?? "");
  const [gerarFingerprint, setGerarFingerprint] = useState(false);
  const [storiesEnabled, setStoriesEnabled] = useState(initial?.stories_enabled ?? false);

  function submit() {
    if (!nomeInterno.trim() || !username.trim()) return;
    if (!USERNAME_OK.test(username.trim().replace(/^@/, ""))) {
      setFormError("O usuário do Instagram (@) só pode ter letras, números, ponto e _ — sem espaços. Ex.: perfil01");
      return;
    }
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
      username: username.trim().replace(/^@/, ""),
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
    <Modal title={initial ? `Editar ${initial.nome_interno}` : "Nova conta"} onClose={onClose} wide scroll>
      <div className="form">
        <label className="field">
          Nome interno
          <input value={nomeInterno} onChange={(e) => setNomeInterno(e.target.value)} placeholder="Ex.: Perfil 01" />
        </label>
        <label className="field">
          Username (Instagram)
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Ex.: perfil01" />
        </label>
        <div className="field">
          Como conectar a conta
          <div className="seg" role="tablist" style={{ marginTop: 6 }}>
            <button
              type="button"
              role="tab"
              aria-selected={metodo === "cookie"}
              className={`seg-btn${metodo === "cookie" ? " active" : ""}`}
              onClick={() => setMetodo("cookie")}
            >
              Cookie de sessão (recomendado)
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={metodo === "senha"}
              className={`seg-btn${metodo === "senha" ? " active" : ""}`}
              onClick={() => setMetodo("senha")}
            >
              Usuário e senha
            </button>
          </div>
        </div>
        {metodo === "cookie" ? (
          <label className="field">
            Cookie sessionid{" "}
            {initial?.sessionid_configurada ? "(já configurado — deixe em branco para manter)" : ""}
            <input
              type="password"
              value={sessionid}
              onChange={(e) => setSessionid(e.target.value)}
              placeholder={initial?.sessionid_configurada ? "••••••••" : "Cole aqui o valor do cookie sessionid"}
              autoComplete="new-password"
            />
            <span className="hint">
              Não envia senha ao Instagram, então não sofre o bloqueio 429 e a sessão dura meses. Como pegar:
            </span>
            <ol className="hint" style={{ margin: "4px 0 0", paddingLeft: 18 }}>
              <li>No computador, entre nessa conta em instagram.com (de preferência onde a pessoa já costuma entrar).</li>
              <li>
                Aperte <strong>F12</strong> → aba <strong>Application</strong> (no Firefox: <strong>Armazenamento</strong>) →{" "}
                <strong>Cookies</strong> → <code>https://www.instagram.com</code>.
              </li>
              <li>
                Copie o <strong>valor</strong> da linha <code>sessionid</code>, cole acima, salve e clique em{" "}
                <strong>Conectar</strong>.
              </li>
              <li>Não clique em “Sair” nesse navegador depois — isso encerra a sessão copiada.</li>
            </ol>
          </label>
        ) : (
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
              Guardada criptografada. Funciona melhor com proxy <strong>residencial ou móvel</strong>: com IP de data
              center o Instagram costuma responder 429. Se der 429, espere e use o cookie de sessão.
            </span>
          </label>
        )}
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
                O que não couber hoje vai para o dia seguinte. Os horários valem mesmo fora da janela, e
                salvar reagenda os posts já programados.
              </span>
            </>
          )}
        </div>
        <ErrorBanner error={formError} onClose={() => setFormError(null)} />
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
            {initial ? (
              <>
                <Save size={14} /> Salvar
              </>
            ) : (
              <>
                <Plus size={14} /> Criar conta
              </>
            )}
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
        <p className="hint">A legenda específica da conta tem prioridade sobre a global.</p>
        <ErrorBanner error={error} onClose={() => setError(null)} />
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
                <button className="btn ghost sm" onClick={() => updateCaption(c.id, { ativo: !c.ativo }).then(onChange)}>
                  {c.ativo ? "Desativar" : "Ativar"}
                </button>
                <button className="btn danger sm" onClick={() => deleteCaption(c.id).then(onChange)}>
                  <Trash2 size={14} /> Excluir
                </button>
              </div>
            </li>
          ))}
          {captions.length === 0 && <li className="empty">Nenhuma legenda cadastrada.</li>}
        </ul>

        <div className="field" style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
          <strong style={{ color: "var(--text)" }}>Nova legenda</strong>
          <div className="checkrow" style={{ gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
            <label className="field" style={{ flex: 1, minWidth: 180 }}>
              Título
              <input placeholder="Ex.: Chamada padrão" value={titulo} onChange={(e) => setTitulo(e.target.value)} />
            </label>
            <label className="field" style={{ flex: 1, minWidth: 180 }}>
              Conta
              <select value={accountId} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : "")}>
                <option value="">Global (todas)</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    @{a.username}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="field">
            Texto da legenda
            <textarea
              rows={2}
              placeholder="Ex.: Bom dia, {{username}}! {{random_emoji}}"
              value={texto}
              onChange={(e) => setTexto(e.target.value)}
            />
            <span className="hint">Variáveis disponíveis: {"{{username}} {{date}} {{number}} {{random_emoji}}"}</span>
          </label>
          <div className="checkrow" style={{ justifyContent: "flex-end" }}>
            <button className="btn primary sm" onClick={add} disabled={!titulo.trim() || !texto.trim()}>
              <Plus size={14} /> Adicionar legenda
            </button>
          </div>
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
      <ErrorBanner error={erro} onClose={() => setErro(null)} />
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
              <span className="hint">1 post por horário/dia, com offset aleatório de ±15min. Salvar reagenda os posts já programados.</span>
            </div>
          )}
        </div>
        <p className="hint">
          Cada conta pode escolher o próprio modo de agendamento — o que estiver aqui vale como padrão
          (janela, timezone e modo) para as contas sem override.
        </p>
        <div className="checkrow" style={{ justifyContent: "flex-end", marginTop: 4, paddingTop: 14, borderTop: "1px solid var(--border)" }}>
          <button className="btn primary" onClick={salvar}>
            <Save size={14} /> Salvar global
          </button>
        </div>
          </>
        )}
      </div>
    </div>
  );
}

const TIPO_IP_LABEL: Record<string, string> = {
  residencial: "🏠 Residencial",
  movel: "📱 Móvel",
  datacenter: "🏢 Data center",
};

/** Minutos que faltam até `ate` (0 se já passou ou não há trava). */
function minutosRestantes(ate: string | null | undefined, agora: number): number {
  if (!ate) return 0;
  const ms = new Date(ate).getTime() - agora;
  return ms > 0 ? Math.ceil(ms / 60000) : 0;
}

/** Regras de @ do Instagram: letras, números, ponto e _ (até 30). */
const USERNAME_OK = /^[A-Za-z0-9._]{1,30}$/;

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
  // relógio para a contagem do "Aguarde N min" (trava após 429)
  const [agora, setAgora] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setAgora(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  function refreshAll() {
    listAccounts().then(setAccounts).catch((e) => setError(String(e)));
    listProxies().then(setProxies).catch((e) => setError(String(e)));
    listCaptions().then(setCaptions).catch((e) => setError(String(e)));
  }

  useEffect(refreshAll, []);

  const salvando = useRef(false);

  async function saveAccount(body: AccountBody, storiesEnabled: boolean, gerarFingerprint: boolean) {
    if (salvando.current) return; // evita clique duplo criando a conta 2x
    salvando.current = true;
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
    } finally {
      salvando.current = false;
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
      <ErrorBanner error={error} onClose={() => setError(null)} />

      <nav className="tabs">
        <button type="button" className={tab === "contas" ? "tab active" : "tab"} onClick={() => setTab("contas")}>
          📱 Contas ({accounts.length})
        </button>
        <button type="button" className={tab === "proxies" ? "tab active" : "tab"} onClick={() => setTab("proxies")}>
          🛡️ Proxies ({proxies.length})
        </button>
        <button type="button" className={tab === "global" ? "tab active" : "tab"} onClick={() => setTab("global")}>
          ⚙️ Configuração geral
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
          <Plus size={14} /> Adicionar conta
        </button>
      </div>

      <ul className="list">
        {accounts.map((a) => (
          <li key={a.id} className="card">
            <div className="card-main">
              <strong>
                @{a.username} <span className="badge">{a.nome_interno}</span>
              </strong>
              {/* 1ª linha: a SITUAÇÃO da conta (o que importa agora). 2ª: a configuração. */}
              <div className="acc-line" aria-label="Situação">
                {!a.ativa ? (
                  <span className="pill st-danger">⛔ Desativada — não publica nada</span>
                ) : a.automation_status === "pausada" && a.status === "pronta" ? (
                  <span className="pill st-warn">⏸️ Pausada</span>
                ) : (
                  <span className="pill">{STATUS_BADGE[a.status]}</span>
                )}
                {a.stories_enabled && <span className="pill">📖 Stories automáticos ligados</span>}
              </div>
              <div className="meta acc-line" aria-label="Configuração">
                <span>{a.senha_configurada ? "✓ Senha salva" : <span className="st-warn">✗ Sem senha</span>}</span>
                <span>{a.session_configurada ? "✓ Sessão salva" : <span className="st-warn">✗ Sem sessão</span>}</span>
                {a.sessionid_configurada && <span>✓ Cookie de sessão</span>}
                {a.proxy && (
                  <span>
                    {PROXY_DOT[a.proxy.status]} Proxy {a.proxy.nome_interno}
                  </span>
                )}
                <span>
                  {a.horarios_selecionados?.length
                    ? `⏰ ${a.horarios_selecionados.length} horário(s) fixo(s) por dia`
                    : a.posts_por_ciclo && a.horas_por_ciclo
                      ? `${a.posts_por_ciclo} post(s) a cada ${a.horas_por_ciclo}h`
                      : a.posts_por_hora
                        ? `${a.posts_por_hora} post(s) por hora`
                        : "Ritmo padrão de posts"}
                </span>
                <span>
                  {a.janela_inicio && a.janela_fim
                    ? `Publica das ${a.janela_inicio} às ${a.janela_fim}`
                    : "Publica em qualquer horário"}
                </span>
                {a.fingerprint_resumo && <span>🎭 {a.fingerprint_resumo}</span>}
              </div>
              {a.ultimo_erro && <div className="meta" style={{ color: "var(--danger)" }}>⚠ {a.ultimo_erro}</div>}
            </div>
            <div className="card-actions" style={{ flexWrap: "wrap" }}>
              {(() => {
                const travado = minutosRestantes(a.login_bloqueado_ate, agora);
                return (
                  <button
                    className="btn primary sm"
                    onClick={() => conectar(a)}
                    disabled={connecting === a.id || travado > 0}
                    title={
                      travado > 0
                        ? "O Instagram limitou as tentativas desta conta. Esperar evita que o bloqueio aumente; para conectar já, use o cookie sessionid."
                        : undefined
                    }
                  >
                    {connecting === a.id ? "Conectando…" : travado > 0 ? `⏳ Aguarde ${travado} min` : "🔗 Conectar"}
                  </button>
                );
              })()}
              <DropdownMenu
                align="right"
                trigger={({ toggle }) => (
                  <button className="btn ghost sm" onClick={toggle} title="Mais ações" aria-label="Mais ações">
                    <MoreVertical size={14} />
                  </button>
                )}
              >
                {(close) => (
                  <>
                    <MenuItem
                      title={
                        a.ativa
                          ? "Desativar a conta: ela não participa de distribuição, não agenda e não publica nada (nem story, nem reel) enquanto desativada"
                          : "Reativar a conta: volta a participar de distribuição, agendamento e publicação"
                      }
                      onClick={() => {
                        updateAccount(a.id, { ativa: !a.ativa }).then(refreshAll);
                        close();
                      }}
                    >
                      {a.ativa ? <>⛔ Desativar</> : <>✅ Ativar</>}
                    </MenuItem>
                    {a.session_configurada && (
                      <MenuItem
                        disabled={verifying === a.id}
                        onClick={() => {
                          verificar(a);
                          close();
                        }}
                      >
                        <ShieldCheck size={14} /> {verifying === a.id ? "Verificando…" : "Verificar sessão"}
                      </MenuItem>
                    )}
                    {a.status === "pronta" && a.automation_status !== "pausada" && (
                      <MenuItem
                        onClick={() => {
                          pauseAccount(a.id).then(refreshAll);
                          close();
                        }}
                      >
                        <Pause size={14} /> Pausar
                      </MenuItem>
                    )}
                    {a.status === "pronta" && a.automation_status === "pausada" && (
                      <MenuItem
                        onClick={() => {
                          resumeAccount(a.id).then(refreshAll);
                          close();
                        }}
                      >
                        <Play size={14} /> Retomar
                      </MenuItem>
                    )}
                    <MenuItem
                      onClick={() => {
                        setFormFor(a);
                        close();
                      }}
                    >
                      <Pencil size={14} /> Editar
                    </MenuItem>
                    <div className="menu-sep" />
                    <MenuItem
                      danger
                      onClick={() => {
                        setToDelete(a);
                        close();
                      }}
                    >
                      <Trash2 size={14} /> Excluir
                    </MenuItem>
                  </>
                )}
              </DropdownMenu>
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
