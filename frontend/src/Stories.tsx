import { useEffect, useMemo, useState } from "react";
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
        {modelo.texto && <div className="story-preview-texto">{modelo.texto}</div>}
        {modelo.texto_extra && <div className="story-preview-extra">{modelo.texto_extra}</div>}
        {modelo.link && <div className={`story-preview-link pos-${modelo.link_posicao || "inferior"}`}>🔗 Link</div>}
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

  function moverFrame(mIdx: number, fIdx: number, delta: number) {
    setModelos((prev) =>
      prev.map((m, i) => {
        if (i !== mIdx) return m;
        const frames = [...m.frames];
        const j = fIdx + delta;
        if (j < 0 || j >= frames.length) return m;
        [frames[fIdx], frames[j]] = [frames[j], frames[fIdx]];
        return { ...m, frames };
      })
    );
  }

  function atualizarHistorico() {
    if (accountId !== "") listStoryHistory(accountId).then(setHistorico).catch(() => {});
  }

  async function cancelarStory(id: number) {
    if (!confirm("Cancelar este story? Ele sai do histórico e não será postado.")) return;
    try {
      await cancelPublications([id]);
      atualizarHistorico();
    } catch (e) {
      setError(String(e));
    }
  }

  async function cancelarTodosStories() {
    const ids = historico.filter((h) => h.status !== "PUBLISHED").map((h) => h.id);
    if (ids.length === 0) return;
    if (!confirm(`Cancelar ${ids.length} story(s) ainda não postados?`)) return;
    try {
      await cancelPublications(ids);
      atualizarHistorico();
    } catch (e) {
      setError(String(e));
    }
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
    if (!confirm(`Publicar este story agora na @${acc.username}?`)) return;
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
        Monte os stories automáticos de cada conta: busque as imagens no banco, escolha a pasta e atribua a um
        modelo (horário + texto + link + posição do link + texto extra). O check de ativar/desativar fica em
        Publicação → Contas.
      </p>
      {error && <div className="error">⚠️ {error}</div>}

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
              <div className="meta">
                {acc.stories_enabled
                  ? "📖 Automação de stories ativa"
                  : "⚠ Automação de stories desativada — ligue o check em Contas (Publicação → Contas)."}
              </div>
            )}
          </div>
        </div>
      </div>

      {accountId !== "" && acc && (
        <>
          <div className="card" style={{ marginTop: 12 }}>
            <div className="card-main" style={{ width: "100%" }}>
              <strong>Imagens do banco</strong>
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
            </div>
          </div>

          <div className="card" style={{ marginTop: 12 }}>
            <div className="card-main" style={{ width: "100%" }}>
              <strong>Modelos de story — @{acc.username}</strong>
              <p className="hint">
                Cada modelo vira 1 story por dia, no horário dele, com a sequência de imagens na ordem abaixo.
              </p>

              {modelos.map((m, i) => (
                <div key={m.key} className="card" style={{ padding: 12, marginTop: 10 }}>
                  <div className="smodel-row">
                    <div className="card-main" style={{ flex: 1, minWidth: 0 }}>
                      <strong>
                        Modelo {i + 1} · {m.frames.length} imagem(ns)
                      </strong>
                    <div className="checkrow" style={{ gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                      <label className="field" style={{ width: 110 }}>
                        Horário
                        <input
                          type="time"
                          value={m.horario}
                          onChange={(e) => editarModelo(i, { horario: e.target.value })}
                        />
                      </label>
                      <label className="field" style={{ flex: 2, minWidth: 160 }}>
                        Texto
                        <input
                          value={m.texto}
                          onChange={(e) => editarModelo(i, { texto: e.target.value })}
                          placeholder="Confere aí 👇"
                        />
                      </label>
                      <label className="field" style={{ flex: 2, minWidth: 160 }}>
                        Link (opcional)
                        <input
                          value={m.link}
                          onChange={(e) => editarModelo(i, { link: e.target.value })}
                          placeholder="https://…"
                        />
                      </label>
                      <label className="field" style={{ width: 110 }}>
                        Posição do link
                        <select
                          value={m.link_posicao}
                          onChange={(e) => editarModelo(i, { link_posicao: e.target.value })}
                        >
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
                          value={m.texto_extra}
                          onChange={(e) => editarModelo(i, { texto_extra: e.target.value })}
                          placeholder="Ex.: Só hoje!"
                        />
                      </label>
                    </div>

                    <div className="sframes">
                      {m.frames.map((id, j) => {
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
                            <button
                              className="btn sm"
                              title="Mover para cima"
                              disabled={j === 0}
                              onClick={() => moverFrame(i, j, -1)}
                            >
                              ▲
                            </button>
                            <button
                              className="btn sm"
                              title="Mover para baixo"
                              disabled={j === m.frames.length - 1}
                              onClick={() => moverFrame(i, j, 1)}
                            >
                              ▼
                            </button>
                            <button
                              className="btn danger sm"
                              title="Remover"
                              onClick={() => editarModelo(i, { frames: m.frames.filter((_, k) => k !== j) })}
                            >
                              ✕
                            </button>
                          </div>
                        );
                      })}
                      {m.frames.length === 0 && (
                        <div className="empty">Sem imagens ainda — selecione acima e clique em “＋ Adicionar”.</div>
                      )}
                    </div>
                    <div className="card-actions">
                      {m.planId != null && (
                        <button
                          className="btn primary sm"
                          onClick={() => postarAgora(m)}
                          disabled={postando === m.planId}
                          title="Publica este story imediatamente"
                        >
                          {postando === m.planId ? "Publicando…" : "▶ Postar agora"}
                        </button>
                      )}
                      <button className="btn danger sm" onClick={() => removerModelo(i)}>
                        Excluir modelo
                      </button>
                    </div>
                  </div>
                  <StoryPreview modelo={m} mediaMap={mediaMap} />
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

          <div className="card" style={{ marginTop: 12 }}>
            <div className="card-main" style={{ width: "100%" }}>
              <div className="checkrow" style={{ gap: 8, alignItems: "center", justifyContent: "space-between" }}>
                <strong>📖 Histórico de stories — @{acc.username}</strong>
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn sm" onClick={atualizarHistorico}>
                    ↻ Atualizar
                  </button>
                  <button className="btn danger sm" onClick={cancelarTodosStories} disabled={!historico.some((h) => h.status !== "PUBLISHED")}>
                    ✕ Cancelar todos
                  </button>
                </div>
              </div>
              <ul className="list" style={{ marginTop: 10, maxHeight: 480, overflowY: "auto" }}>
                {historico.map((h) => (
                  <li key={h.id} className="card" style={{ padding: 10 }}>
                    <div className="card-main" style={{ width: "100%" }}>
                      <strong>
                        {STORY_STATUS_ICON[h.status] ?? "·"} {new Date(h.scheduled_at).toLocaleString("pt-BR")}
                        <span className="badge" style={{ marginLeft: 8 }}>
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
                      <button className="btn danger sm" onClick={() => cancelarStory(h.id)} title="Cancelar story">
                        ✕
                      </button>
                    )}
                  </li>
                ))}
                {historico.length === 0 && (
                  <li className="empty">
                    Nenhum story gerado ainda — os stories do dia aparecem aqui depois de gerados pelo scheduler.
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
    </div>
  );
}
