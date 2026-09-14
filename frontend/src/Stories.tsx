import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ConfirmDialog, Modal } from "./Dialog";
import {
  cancelPublications,
  downloadUrl,
  getStoryConfig,
  listAccounts,
  listFolders,
  listMedia,
  listStoryHistory,
  postStoryNow,
  updateStoryConfig,
  type Folder,
  type Media,
  type PubAccount,
  type StoryConfig,
  type StoryHistory,
} from "./api";

/**
 * Tab "Stories": monta os stories automáticos DE CADA CONTA.
 *
 * O check "Stories automáticos" continua em Contas (Publicação → Contas) — lá só
 * liga/desliga a automação. Aqui o usuário procura as imagens no banco (por pasta
 * e busca), e as atribui a "modelos": cada modelo = 1 story no dia, com horário,
 * texto, link, posição do link e texto extra opcional, e uma sequência de imagens.
 */

const LINK_POSICOES = [
  { value: "superior", label: "Topo" },
  { value: "meio", label: "Meio" },
  { value: "inferior", label: "Baixo" },
];

const VIDEO_RE = /\.(mp4|mov|mkv|webm|avi)$/i;

const STORY_STATUS_ICON: Record<string, string> = {
  PENDING: "⏰",
  UPLOADING: "⏳",
  PROCESSING: "⏳",
  PUBLISHED: "✓",
  FAILED: "⚠",
  RETRYING: "↻",
  CANCELLED: "✕",
};

const STORY_STATUS_COLOR: Record<string, string> = {
  PENDING: "st-warn",
  UPLOADING: "st-warn",
  PROCESSING: "st-warn",
  PUBLISHED: "st-ok",
  FAILED: "st-danger",
  RETRYING: "st-warn",
  CANCELLED: "st-muted",
};

interface Modelo {
  key: number;
  planId?: number; // id no servidor (presente após salvar/carregar) — habilita "Postar agora"
  horario: string;
  texto: string;
  link: string;
  link_posicao: string;
  texto_extra: string;
  frames: number[]; // ids de Media, na ordem da sequência
}

function novoModelo(): Modelo {
  return {
    key: Date.now() + Math.random(),
    horario: "18:00",
    texto: "",
    link: "",
    link_posicao: "inferior",
    texto_extra: "",
    frames: [],
  };
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

/** Prévia 9:16 do story do modelo — mesma ideia do preview de "Criar". */
function StoryPreview({ modelo, mediaMap }: { modelo: Modelo; mediaMap: Map<number, Media> }) {
  const [frameIdx, setFrameIdx] = useState(0);
  const n = modelo.frames.length;
  const atual = n > 0 ? mediaMap.get(modelo.frames[Math.min(frameIdx, n - 1)]) : undefined;
  const isVideo = atual ? VIDEO_RE.test(atual.caminho) : false;
  return (
    <div className="preview story-preview">
      <div className="preview-canvas">
        {atual ? (
          isVideo ? (
            <video className="preview-bg" src={downloadUrl(atual.id)} muted playsInline autoPlay loop preload="metadata" />
          ) : (
            <img className="preview-bg" src={downloadUrl(atual.id)} alt={atual.nome_original} />
          )
        ) : (
          <div className="preview-bg preview-bg-empty">9:16</div>
        )}
        {!modelo.link && modelo.texto && <div className="story-preview-texto">{modelo.texto}</div>}
        {!modelo.link && modelo.texto_extra && <div className="story-preview-extra">{modelo.texto_extra}</div>}
        {modelo.link && (
          <div className={`story-preview-link pos-${modelo.link_posicao || "inferior"}`}>
            {modelo.texto.trim() || "Link"}
          </div>
        )}
      </div>
      {n > 1 && (
        <div className="checkrow" style={{ gap: 4, marginTop: 6, justifyContent: "center", flexWrap: "wrap" }}>
          {modelo.frames.map((_, j) => (
            <button key={j} className={`btn sm ${j === frameIdx ? "primary" : ""}`} onClick={() => setFrameIdx(j)}>
              {j + 1}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Editor de um modelo do dia — abre em MODAL (a lista fica só com linhas-resumo). */
function ModelEditorModal({
  modelo,
  mediaMap,
  onSave,
  onClose,
}: {
  modelo: Modelo;
  mediaMap: Map<number, Media>;
  onSave: (patch: Partial<Modelo>) => void;
  onClose: () => void;
}) {
  const [d, setD] = useState<Modelo>(modelo);

  function moverFrame(fIdx: number, delta: number) {
    setD((prev) => {
      const frames = [...prev.frames];
      const j = fIdx + delta;
      if (j < 0 || j >= frames.length) return prev;
      [frames[fIdx], frames[j]] = [frames[j], frames[fIdx]];
      return { ...prev, frames };
    });
  }

  return (
    <Modal title={`Editar modelo — story das ${d.horario}`} onClose={onClose} wide scroll>
      <div className="smodel-row" style={{ width: "100%" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="checkrow" style={{ gap: 8, flexWrap: "wrap" }}>
            <label className="field" style={{ width: 110 }}>
              Horário
              <input type="time" value={d.horario} onChange={(e) => setD({ ...d, horario: e.target.value })} />
            </label>
            <label className="field" style={{ flex: 2, minWidth: 160 }}>
              Texto
              <input value={d.texto} onChange={(e) => setD({ ...d, texto: e.target.value })} placeholder="Confere aí 👇" />
            </label>
          </div>
          <div className="checkrow" style={{ gap: 8, flexWrap: "wrap" }}>
            <label className="field" style={{ flex: 2, minWidth: 160 }}>
              Link (opcional)
              <input value={d.link} onChange={(e) => setD({ ...d, link: e.target.value })} placeholder="https://…" />
            </label>
            <label className="field" style={{ width: 110 }}>
              Posição do link
              <select value={d.link_posicao} onChange={(e) => setD({ ...d, link_posicao: e.target.value })}>
                {LINK_POSICOES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="field" style={{ flex: 1, minWidth: 160 }}>
              Texto extra (opcional)
              <input
                value={d.texto_extra}
                onChange={(e) => setD({ ...d, texto_extra: e.target.value })}
                placeholder="Ex.: Só hoje!"
              />
            </label>
          </div>
          <p className="hint" style={{ marginTop: 6 }}>
            O texto é o rótulo do botão do link. Sem link (opcional), o texto vira a legenda nativa do story.
          </p>

          <p className="hint" style={{ marginTop: 10 }}>
            Sequência do story — a ordem abaixo é a ordem da publicação:
          </p>
          <div className="sframes">
            {d.frames.map((id, j) => {
              const media = mediaMap.get(id);
              return (
                <div className="sframe" key={`${id}-${j}`}>
                  {media ? (
                    <img className="mini-thumb" src={downloadUrl(id)} alt={media.nome_original} />
                  ) : (
                    <div className="mini-thumb">❓</div>
                  )}
                  <span className="sframe-nome" title={media?.nome_original}>
                    {j + 1}. {media?.nome_original ?? `mídia #${id} (removida)`}
                  </span>
                  <button className="btn sm" title="Mover para cima" disabled={j === 0} onClick={() => moverFrame(j, -1)}>
                    ▲
                  </button>
                  <button
                    className="btn sm"
                    title="Mover para baixo"
                    disabled={j === d.frames.length - 1}
                    onClick={() => moverFrame(j, 1)}
                  >
                    ▼
                  </button>
                  <button
                    className="btn danger sm"
                    title="Remover"
                    onClick={() => setD({ ...d, frames: d.frames.filter((_, k) => k !== j) })}
                  >
                    ✕
                  </button>
                </div>
              );
            })}
            {d.frames.length === 0 && (
              <div className="empty">
                Sem imagens ainda — feche este modal, escolha na biblioteca e clique em “＋ Adicionar”.
              </div>
            )}
          </div>
        </div>
        <StoryPreview modelo={d} mediaMap={mediaMap} />
      </div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Cancelar
        </button>
        <button
          className="btn primary"
          onClick={() =>
            onSave({
              horario: d.horario,
              texto: d.texto,
              link: d.link,
              link_posicao: d.link_posicao,
              texto_extra: d.texto_extra,
              frames: d.frames,
            })
          }
        >
          Salvar modelo
        </button>
      </div>
    </Modal>
  );
}

export default function Stories() {
  const [accounts, setAccounts] = useState<PubAccount[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [library, setLibrary] = useState<Media[]>([]);
  const [accountId, setAccountId] = useState<number | "">("");
  const [modelos, setModelos] = useState<Modelo[]>([]);
  const [folderFilter, setFolderFilter] = useState<number | "all" | "none">("all");
  const [busca, setBusca] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [target, setTarget] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [postando, setPostando] = useState<number | null>(null);
  const [historico, setHistorico] = useState<StoryHistory[]>([]);
  const [bibliotecaAberta, setBibliotecaAberta] = useState(true);
  const [histFiltro, setHistFiltro] = useState<"todos" | "PENDING" | "PUBLISHED" | "erro">("todos");
  // índice do modelo sendo editado em MODAL (a lista fica só com linhas-resumo)
  const [editModelo, setEditModelo] = useState<number | null>(null);
  const [confirma, setConfirma] = useState<null | {
    titulo: string;
    mensagem: ReactNode;
    rotulo: string;
    acao: () => void;
  }>(null);

  // carrega contas, pastas e TODAS as imagens do banco uma vez (a busca/pasta filtram em memória)
  useEffect(() => {
    listAccounts().then(setAccounts).catch((e) => setError(String(e)));
    listFolders().then(setFolders).catch(() => {});
    Promise.all([listMedia("photo"), listMedia("photo_hot")])
      .then(([a, b]) => setLibrary([...a, ...b]))
      .catch((e) => setError(String(e)));
  }, []);

  const acc = accountId === "" ? undefined : accounts.find((a) => a.id === accountId);

  function mapearConfig(cfg: StoryConfig): Modelo[] {
    let carregados: Modelo[] = (cfg.plans ?? []).map((p) => ({
      key: p.id,
      planId: p.id,
      horario: p.horario,
      texto: p.texto ?? "",
      link: p.link ?? "",
      link_posicao: p.link_posicao ?? "inferior",
      texto_extra: p.texto_extra ?? "",
      frames: p.media_ids,
    }));
    // config legada (1 imagem / 1 horário) vira um modelo com 1 imagem
    if (carregados.length === 0 && cfg.imagem_media_id) {
      carregados = [
        {
          key: Date.now(),
          horario: cfg.horario ?? "18:00",
          texto: cfg.texto ?? "",
          link: cfg.link ?? "",
          link_posicao: "inferior",
          texto_extra: "",
          frames: [cfg.imagem_media_id],
        },
      ];
    }
    if (carregados.length === 0) carregados = [novoModelo()];
    return carregados;
  }

  // ao trocar de conta, carrega a configuração de stories dela
  useEffect(() => {
    if (accountId === "") {
      setModelos([]);
      setTarget(0);
      setHistorico([]);
      return;
    }
    setMsg(null);
    listStoryHistory(accountId).then(setHistorico).catch(() => {});
    getStoryConfig(accountId)
      .then((cfg) => {
        setModelos(mapearConfig(cfg));
        setTarget(0);
        setSelected(new Set());
      })
      .catch((e) => setError(String(e)));
  }, [accountId]);

  const mediaMap = useMemo(() => new Map(library.map((m) => [m.id, m])), [library]);

  const historicoFiltrado = historico.filter((h) =>
    histFiltro === "todos"
      ? true
      : histFiltro === "erro"
        ? h.status === "FAILED" || h.status === "RETRYING" || Boolean(h.erro)
        : h.status === histFiltro
  );

  const filtradas = useMemo(() => {
    let lista = library;
    if (folderFilter === "none") lista = lista.filter((m) => m.folder_id == null);
    else if (folderFilter !== "all") lista = lista.filter((m) => m.folder_id === folderFilter);
    const q = busca.trim().toLowerCase();
    if (q) lista = lista.filter((m) => m.nome_original.toLowerCase().includes(q));
    return lista;
  }, [library, folderFilter, busca]);

  function folderNome(folderId: number | null): string {
    if (folderId == null) return "Sem pasta";
    return folders.find((f) => f.id === folderId)?.nome ?? "Sem pasta";
  }

  function toggleSel(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function addSelecionadas() {
    if (selected.size === 0 || modelos.length === 0) return;
    const ids = [...selected];
    setModelos((prev) =>
      prev.map((m, i) =>
        i === target ? { ...m, frames: [...m.frames, ...ids.filter((id) => !m.frames.includes(id))] } : m
      )
    );
    setSelected(new Set());
  }

  function removerModelo(idx: number) {
    setModelos((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      return next.length > 0 ? next : [novoModelo()];
    });
    setTarget((t) => Math.min(t, Math.max(modelos.length - 2, 0)));
  }

  function editarModelo(idx: number, patch: Partial<Modelo>) {
    setModelos((prev) => prev.map((m, i) => (i === idx ? { ...m, ...patch } : m)));
  }

  function atualizarHistorico() {
    if (accountId !== "") listStoryHistory(accountId).then(setHistorico).catch(() => {});
  }

  async function cancelarStory(id: number) {
    try {
      await cancelPublications([id]);
      atualizarHistorico();
    } catch (e) {
      setError(String(e));
    }
  }

  async function cancelarTodosStories(ids: number[]) {
    if (ids.length === 0) return;
    try {
      await cancelPublications(ids);
      atualizarHistorico();
    } catch (e) {
      setError(String(e));
    }
  }

  function pedirPostar(m: Modelo) {
    setConfirma({
      titulo: "Publicar story agora",
      mensagem: (
        <>
          Publicar este story agora na <strong>@{acc?.username}</strong>?
        </>
      ),
      rotulo: "Publicar agora",
      acao: () => postarAgora(m),
    });
  }

  function pedirCancelarStory(id: number) {
    setConfirma({
      titulo: "Cancelar story",
      mensagem: <>Cancelar este story? Ele sai do histórico e não será postado.</>,
      rotulo: "Cancelar story",
      acao: () => cancelarStory(id),
    });
  }

  function pedirCancelarTodos() {
    const ids = historico.filter((h) => h.status !== "PUBLISHED").map((h) => h.id);
    if (ids.length === 0) return;
    setConfirma({
      titulo: "Cancelar todos os stories",
      mensagem: <>Cancelar {ids.length} story(s) ainda não postados?</>,
      rotulo: "Cancelar todos",
      acao: () => cancelarTodosStories(ids),
    });
  }

  async function salvar() {
    if (accountId === "" || !acc) return;
    setError(null);
    setMsg(null);
    setSaving(true);
    try {
      const cfg = await updateStoryConfig(acc.id, {
        // o check em Contas controla a automação; aqui só a configuração é salva
        enabled: acc.stories_enabled,
        plans: modelos
          .filter((m) => m.frames.length > 0)
          .map((m) => ({
            horario: m.horario,
            texto: m.texto.trim() || null,
            link: m.link.trim() || null,
            link_posicao: m.link_posicao,
            texto_extra: m.texto_extra.trim() || null,
            frames: m.frames.map((id) => ({ media_id: id })),
          })),
      });
      // remapeia com os ids devolvidos pelo servidor — habilita "Postar agora"
      setModelos(mapearConfig(cfg));
      setMsg("Stories da conta salvos.");
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function postarAgora(m: Modelo) {
    if (accountId === "" || m.planId == null || !acc) return;
    setError(null);
    setMsg(null);
    setPostando(m.planId);
    try {
      const r = await postStoryNow(acc.id, m.planId);
      if (r.status === "PUBLISHED") {
        setMsg("Story publicado e confirmado ✓");
      } else if (r.status === "RETRYING") {
        setMsg(`Story em nova tentativa (${r.erro ?? "falha temporária"})`);
      } else {
        setMsg(`Story não publicado (${r.status})${r.erro ? `: ${r.erro}` : ""}`);
      }
      atualizarHistorico();
    } catch (e) {
      setError(String(e));
    } finally {
      setPostando(null);
    }
  }

  return (
    <div>
      <p className="sub">
        Stories em 3 passos: escolha a conta, monte os modelos do dia (cada modelo vira 1 story no horário
        dele) e acompanhe o histórico. O check de ativar/desativar a automação fica em Publicação → Contas.
      </p>
      {error && <div className="error">⚠️ {error}</div>}

      <Secao n={1} titulo="Conta" dica="de qual perfil saem os stories" />
      <div className="card">
        <div className="card-main" style={{ width: "100%" }}>
          <div className="checkrow" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <label className="field" style={{ flex: 1, minWidth: 220 }}>
              Conta
              <select value={accountId} onChange={(e) => setAccountId(e.target.value ? Number(e.target.value) : "")}>
                <option value="">— Escolha a conta —</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    @{a.username} · {a.nome_interno}
                  </option>
                ))}
              </select>
            </label>
            {acc && (
              <span className={`badge ${acc.stories_enabled ? "st-ok" : "st-danger"}`}>
                {acc.stories_enabled
                  ? "📖 Automação de stories ativa"
                  : "⚠ Automação desativada — ligue o check em Contas (Publicação → Contas)."}
              </span>
            )}
          </div>
        </div>
      </div>

      {accountId !== "" && acc && (
        <>
          <Secao n={2} titulo="Modelos do dia" dica={`cada modelo vira 1 story por dia em @${acc.username}`} />

          <div className="card">
            <div className="card-main" style={{ width: "100%" }}>
              <div
                className={`panel-head${bibliotecaAberta ? " open" : ""}`}
                onClick={() => setBibliotecaAberta((v) => !v)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setBibliotecaAberta((v) => !v);
                  }
                }}
              >
                <strong>📚 Biblioteca de mídias — escolha as imagens dos modelos</strong>
                <span className="caret">▶</span>
              </div>
              {bibliotecaAberta && (
                <>
                  <div className="checkrow" style={{ gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                <input
                  type="search"
                  placeholder="🔎 Buscar imagem…"
                  value={busca}
                  onChange={(e) => setBusca(e.target.value)}
                  style={{ flex: 2, minWidth: 180 }}
                />
                <select
                  value={folderFilter}
                  onChange={(e) =>
                    setFolderFilter(e.target.value === "all" || e.target.value === "none" ? e.target.value : Number(e.target.value))
                  }
                  style={{ flex: 1, minWidth: 150 }}
                >
                  <option value="all">Todas as pastas</option>
                  <option value="none">Sem pasta</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      📁 {f.nome}
                    </option>
                  ))}
                </select>
                <label className="field" style={{ width: 220 }}>
                  Adicionar ao modelo
                  <select value={target} onChange={(e) => setTarget(Number(e.target.value))}>
                    {modelos.map((m, i) => (
                      <option key={m.key} value={i}>
                        Modelo {i + 1} · {m.horario} ({m.frames.length} img)
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  className="btn primary sm"
                  onClick={addSelecionadas}
                  disabled={selected.size === 0}
                  style={{ alignSelf: "flex-end" }}
                >
                  ＋ Adicionar {selected.size > 0 ? `${selected.size}` : ""}
                </button>
              </div>

              <div className="sgrid">
                {filtradas.map((m) => {
                  const isVideo = VIDEO_RE.test(m.caminho);
                  return (
                    <div
                      key={m.id}
                      role="button"
                      tabIndex={0}
                      className={selected.has(m.id) ? "scard selected" : "scard"}
                      onClick={() => toggleSel(m.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          toggleSel(m.id);
                        }
                      }}
                    >
                      {isVideo ? (
                        <video className="thumb" src={downloadUrl(m.id)} preload="metadata" muted />
                      ) : (
                        <img className="thumb" src={downloadUrl(m.id)} alt={m.nome_original} />
                      )}
                      <div className="scard-nome" title={m.nome_original}>
                        {m.nome_original}
                      </div>
                      <div className="scard-pasta">📁 {folderNome(m.folder_id)}</div>
                      {selected.has(m.id) && <span className="scard-check">✓</span>}
                    </div>
                  );
                })}
                {filtradas.length === 0 && <div className="empty">Nenhuma imagem encontrada para esse filtro.</div>}
              </div>
                </>
              )}
            </div>
          </div>

          <div className="card" style={{ marginTop: 12 }}>
            <div className="card-main" style={{ width: "100%" }}>
              <div className="checkrow" style={{ gap: 8, justifyContent: "space-between", flexWrap: "wrap" }}>
                <strong>🕒 {modelos.length} modelo(s) do dia</strong>
                <span className="hint">clique em ✏️ Editar para abrir o modelo</span>
              </div>
              {modelos.map((m, i) => (
                <div key={m.key} className="card" style={{ padding: 12, marginTop: 10 }}>
                  <div className="card-main" style={{ flex: 1, minWidth: 0 }}>
                    <div className="checkrow" style={{ gap: 8, flexWrap: "wrap" }}>
                      <strong>🕒 {m.horario} — {m.texto.trim() || `Modelo ${i + 1}`}</strong>
                      <span className="badge st-ok">{m.frames.length} img</span>
                      {m.link.trim() !== "" && (
                        <span className="badge" style={{ color: "var(--blue)" }}>🔗 com link</span>
                      )}
                    </div>
                    <p className="hint" style={{ margin: "2px 0 0" }}>
                      Publica todo dia às {m.horario}
                      {m.link.trim() !== ""
                        ? ` · o texto vira o botão do link (posição: ${m.link_posicao})`
                        : " · sem link — o texto vira a legenda do story"}
                    </p>
                  </div>
                  <div className="card-actions" style={{ flexWrap: "wrap" }}>
                    {m.planId != null && (
                      <button
                        className="btn primary sm"
                        onClick={() => pedirPostar(m)}
                        disabled={postando === m.planId}
                        title="Publica este story imediatamente"
                      >
                        {postando === m.planId ? "Publicando…" : "▶ Postar agora"}
                      </button>
                    )}
                    <button className="btn sm" onClick={() => setEditModelo(i)}>
                      ✏️ Editar
                    </button>
                    <button className="btn danger sm" onClick={() => removerModelo(i)}>
                      Excluir
                    </button>
                  </div>
                </div>
              ))}

              <div className="card-actions" style={{ marginTop: 10 }}>
                <button className="btn sm" onClick={() => setModelos((prev) => [...prev, novoModelo()])}>
                  ＋ Novo modelo
                </button>
                <button className="btn primary" onClick={salvar} disabled={saving}>
                  {saving ? "Salvando…" : "Salvar stories"}
                </button>
                {msg && <span className="hint">{msg}</span>}
              </div>
            </div>
          </div>

          <Secao n={3} titulo="Histórico" dica="stories gerados e o resultado de cada publicação" />
          <div className="card">
            <div className="card-main" style={{ width: "100%" }}>
              <div className="checkrow" style={{ gap: 8, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
                <strong>📖 Histórico — @{acc.username}</strong>
                <div className="checkrow" style={{ gap: 6 }}>
                  <button className="btn sm" onClick={atualizarHistorico}>
                    ↻ Atualizar
                  </button>
                  <button className="btn danger sm" onClick={pedirCancelarTodos} disabled={!historico.some((h) => h.status !== "PUBLISHED")}>
                    ✕ Cancelar todos
                  </button>
                </div>
              </div>
              <div className="checkrow" style={{ gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                {(
                  [
                    ["todos", "Todos"],
                    ["PENDING", "⏰ Pendentes"],
                    ["PUBLISHED", "✓ Publicados"],
                    ["erro", "⚠ Com erro"],
                  ] as const
                ).map(([f, label]) => (
                  <button
                    key={f}
                    className={histFiltro === f ? "chip active" : "chip"}
                    onClick={() => setHistFiltro(f)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <ul className="list" style={{ marginTop: 10, maxHeight: 480, overflowY: "auto" }}>
                {historicoFiltrado.map((h) => (
                  <li key={h.id} className="card" style={{ padding: 10 }}>
                    <div className="card-main" style={{ width: "100%" }}>
                      <strong>
                        {STORY_STATUS_ICON[h.status] ?? "·"} {new Date(h.scheduled_at).toLocaleString("pt-BR")}
                        <span className={`badge ${STORY_STATUS_COLOR[h.status] ?? "st-muted"}`} style={{ marginLeft: 8 }}>
                          {h.status}
                        </span>
                      </strong>
                      {h.legenda && <div className="meta">💬 {h.legenda}</div>}
                      {h.link && <div className="meta">🔗 {h.link}</div>}
                      {h.confirmado_em && (
                        <div className="meta">
                          Postado e confirmado em {new Date(h.confirmado_em).toLocaleString("pt-BR")}
                        </div>
                      )}
                      {h.erro && <div className="error" style={{ marginTop: 4 }}>{h.erro}</div>}
                    </div>
                    {h.status !== "PUBLISHED" && (
                      <button className="btn danger sm" onClick={() => pedirCancelarStory(h.id)} title="Cancelar story">
                        ✕
                      </button>
                    )}
                  </li>
                ))}
                {historicoFiltrado.length === 0 && (
                  <li className="empty">
                    {historico.length === 0
                      ? "Nenhum story gerado ainda — os stories do dia aparecem aqui depois de gerados pelo scheduler (ou use ▶ Postar agora)."
                      : "Nenhum story nesse filtro."}
                  </li>
                )}
              </ul>
            </div>
          </div>
        </>
      )}

      {accounts.length === 0 && (
        <div className="empty">Nenhuma conta cadastrada ainda — crie uma em Publicação → Contas.</div>
      )}

      {editModelo !== null && modelos[editModelo] && (
        <ModelEditorModal
          modelo={modelos[editModelo]}
          mediaMap={mediaMap}
          onSave={(patch) => {
            editarModelo(editModelo, patch);
            setEditModelo(null);
          }}
          onClose={() => setEditModelo(null)}
        />
      )}
      {confirma && (
        <ConfirmDialog
          title={confirma.titulo}
          message={confirma.mensagem}
          confirmLabel={confirma.rotulo}
          onConfirm={() => {
            confirma.acao();
            setConfirma(null);
          }}
          onClose={() => setConfirma(null)}
        />
      )}
    </div>
  );
}
