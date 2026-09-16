import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  BookImage,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  ImagePlus,
  Library,
  Link2,
  Loader,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  UploadCloud,
  X,
  type LucideIcon,
} from "lucide-react";
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
 * O check "Stories automáticos" continua em Contas — lá só
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

const STORY_STATUS_ICON: Record<string, LucideIcon> = {
  PENDING: Clock,
  UPLOADING: UploadCloud,
  PROCESSING: Loader,
  PUBLISHED: Check,
  FAILED: AlertTriangle,
  RETRYING: RefreshCw,
  CANCELLED: X,
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

/** Biblioteca de mídias em MODAL (sem barra de pesquisa) — escolhe imagens para
 * criar um story novo ou adicionar a um story existente. */
function BibliotecaModal({
  titulo,
  confirmLabel,
  folders,
  library,
  folderNome,
  onConfirm,
  onClose,
}: {
  titulo: string;
  confirmLabel: string;
  folders: Folder[];
  library: Media[];
  folderNome: (id: number | null) => string;
  onConfirm: (ids: number[]) => void;
  onClose: () => void;
}) {
  const [folderFilter, setFolderFilter] = useState<number | "all" | "none">("all");
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const filtradas = useMemo(() => {
    let lista = library;
    if (folderFilter === "none") lista = lista.filter((m) => m.folder_id == null);
    else if (folderFilter !== "all") lista = lista.filter((m) => m.folder_id === folderFilter);
    return lista;
  }, [library, folderFilter]);

  function toggleSel(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  return (
    <Modal title={titulo} onClose={onClose} wide scroll top>
      <div className="checkrow" style={{ gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        <label className="field" style={{ width: 220 }}>
          Pasta
          <select
            value={folderFilter}
            onChange={(e) =>
              setFolderFilter(e.target.value === "all" || e.target.value === "none" ? e.target.value : Number(e.target.value))
            }
          >
            <option value="all">Todas as pastas</option>
            <option value="none">Sem pasta</option>
            {folders.map((f) => (
              <option key={f.id} value={f.id}>
                📁 {f.nome}
              </option>
            ))}
          </select>
        </label>
        <span className="hint">
          {selected.size > 0 ? `${selected.size} imagem(ns) selecionada(s)` : "Clique nas imagens para selecionar"}
        </span>
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
        {filtradas.length === 0 && <div className="empty">Nenhuma imagem encontrada para essa pasta.</div>}
      </div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Cancelar
        </button>
        <button className="btn primary" disabled={selected.size === 0} onClick={() => onConfirm([...selected])}>
          <Plus size={14} /> {confirmLabel} ({selected.size})
        </button>
      </div>
    </Modal>
  );
}

/** Editor de um modelo do dia — abre em MODAL (a lista fica só com linhas-resumo). */
function ModelEditorModal({
  modelo,
  mediaMap,
  onSave,
  onClose,
  onAddImages,
}: {
  modelo: Modelo;
  mediaMap: Map<number, Media>;
  onSave: (patch: Partial<Modelo>) => void;
  onClose: () => void;
  onAddImages?: () => void;
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

          <div className="checkrow" style={{ gap: 8, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", marginTop: 10 }}>
            <strong style={{ fontSize: 13 }}>
              Sequência do story <span className="hint">— a ordem abaixo é a ordem da publicação</span>
            </strong>
            {onAddImages && d.frames.length > 0 && (
              <button className="btn primary sm" onClick={onAddImages}>
                <ImagePlus size={14} /> Adicionar imagens
              </button>
            )}
          </div>
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
                  <button className="btn ghost sm" title="Mover para cima" disabled={j === 0} onClick={() => moverFrame(j, -1)}>
                    <ChevronUp size={14} />
                  </button>
                  <button
                    className="btn ghost sm"
                    title="Mover para baixo"
                    disabled={j === d.frames.length - 1}
                    onClick={() => moverFrame(j, 1)}
                  >
                    <ChevronDown size={14} />
                  </button>
                  <button
                    className="btn danger sm"
                    title="Remover"
                    onClick={() => setD({ ...d, frames: d.frames.filter((_, k) => k !== j) })}
                  >
                    <X size={14} />
                  </button>
                </div>
              );
            })}
            {d.frames.length === 0 && onAddImages && (
              <button type="button" className="sframes-empty" onClick={onAddImages}>
                <ImagePlus size={22} />
                Nenhuma imagem ainda — clique para escolher na biblioteca
              </button>
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
          <Save size={14} /> Salvar modelo
        </button>
      </div>
    </Modal>
  );
}

interface HistoryItem extends StoryHistory {
  account_id: number;
  account_username: string;
}

export default function Stories() {
  const [accounts, setAccounts] = useState<PubAccount[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [library, setLibrary] = useState<Media[]>([]);
  const [accountId, setAccountId] = useState<number | "">("");
  const [modelos, setModelos] = useState<Modelo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [postando, setPostando] = useState<number | null>(null);
  const [historico, setHistorico] = useState<HistoryItem[]>([]);
  const [histFiltro, setHistFiltro] = useState<"todos" | "PENDING" | "PUBLISHED" | "erro">("todos");
  // fluxo de criação/edição: esconde o histórico e mostra conta → stories ativos → novo/editar
  const [editando, setEditando] = useState(false);
  // modal da biblioteca de mídias: null = criando story novo; número = adicionando ao modelo n
  const [bibliotecaAberta, setBibliotecaAberta] = useState(false);
  const [bibliotecaPara, setBibliotecaPara] = useState<number | null>(null);
  // índice do modelo sendo editado em MODAL
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
      return;
    }
    setMsg(null);
    getStoryConfig(accountId)
      .then((cfg) => {
        setModelos(mapearConfig(cfg));
      })
      .catch((e) => setError(String(e)));
  }, [accountId]);

  // histórico de TODAS as contas, sempre visível (uma chamada por conta, mesclado)
  useEffect(() => {
    if (accounts.length === 0) return;
    Promise.all(
      accounts.map((a) =>
        listStoryHistory(a.id).then((xs) =>
          xs.map((x) => ({ ...x, account_id: a.id, account_username: a.username }))
        )
      )
    )
      .then((xs) =>
        setHistorico(xs.flat().sort((a, b) => +new Date(b.scheduled_at) - +new Date(a.scheduled_at)))
      )
      .catch((e) => setError(String(e)));
  }, [accounts]);

  const mediaMap = useMemo(() => new Map(library.map((m) => [m.id, m])), [library]);

  const historicoFiltrado = historico.filter((h) =>
    histFiltro === "todos"
      ? true
      : histFiltro === "erro"
        ? h.status === "FAILED" || h.status === "RETRYING" || Boolean(h.erro)
        : h.status === histFiltro
  );

  function folderNome(folderId: number | null): string {
    if (folderId == null) return "Sem pasta";
    return folders.find((f) => f.id === folderId)?.nome ?? "Sem pasta";
  }

  function removerModelo(idx: number) {
    setModelos((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      return next.length > 0 ? next : [novoModelo()];
    });
    if (editModelo === idx) setEditModelo(null);
  }

  function editarModelo(idx: number, patch: Partial<Modelo>) {
    setModelos((prev) => prev.map((m, i) => (i === idx ? { ...m, ...patch } : m)));
  }

  // biblioteca confirmou: cria um story NOVO com as imagens escolhidas e já abre
  // o editor dele, ou acrescenta as imagens ao story que estava em edição.
  function confirmarBiblioteca(ids: number[]) {
    if (bibliotecaPara === null) {
      const novo = novoModelo();
      novo.frames = ids;
      const idx = modelos.length;
      setModelos((prev) => [...prev, novo]);
      setEditModelo(idx);
    } else {
      const atual = modelos[bibliotecaPara];
      if (atual) {
        editarModelo(bibliotecaPara, {
          frames: [...atual.frames, ...ids.filter((id) => !atual.frames.includes(id))],
        });
        setEditModelo(bibliotecaPara);
      }
    }
    setBibliotecaAberta(false);
  }

  function atualizarHistorico() {
    if (accounts.length === 0) return;
    Promise.all(
      accounts.map((a) =>
        listStoryHistory(a.id).then((xs) =>
          xs.map((x) => ({ ...x, account_id: a.id, account_username: a.username }))
        )
      )
    )
      .then((xs) =>
        setHistorico(xs.flat().sort((a, b) => +new Date(b.scheduled_at) - +new Date(a.scheduled_at)))
      )
      .catch((e) => setError(String(e)));
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
        Stories de todas as contas em um lugar: crie ou edite o story ativo de cada conta e acompanhe o
        histórico. O check de ativar/desativar a automação fica em Contas.
      </p>
      {error && <div className="error">⚠️ {error}</div>}

      {!editando ? (
        <>
          <div className="selbar" style={{ marginBottom: 12 }}>
            <button className="btn primary" onClick={() => setEditando(true)}>
              <Pencil size={15} /> Criar/editar storie
            </button>
            <span className="hint">Escolha a conta, veja os stories ativos e crie um novo — o histórico some enquanto edita.</span>
          </div>

          <Secao n={1} titulo="Histórico" dica="stories de todas as contas, mais recente primeiro" />
          <div className="card">
            <div className="card-main" style={{ width: "100%" }}>
              <div className="checkrow" style={{ gap: 8, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
                <strong>
                  <Library size={15} /> Histórico — todas as contas ({historico.length})
                </strong>
                <div className="checkrow" style={{ gap: 6 }}>
                  <button className="btn sm" onClick={atualizarHistorico}>
                    <RefreshCw size={13} /> Atualizar
                  </button>
                  <button className="btn danger sm" onClick={pedirCancelarTodos} disabled={!historico.some((h) => h.status !== "PUBLISHED")}>
                    <Trash2 size={13} /> Cancelar todos
                  </button>
                </div>
              </div>
              <div className="checkrow" style={{ gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                {(
                  [
                    ["todos", "Todos", null],
                    ["PENDING", "Pendentes", Clock],
                    ["PUBLISHED", "Publicados", Check],
                    ["erro", "Com erro", AlertTriangle],
                  ] as const
                ).map(([f, label, Icon]) => (
                  <button
                    key={f}
                    className={histFiltro === f ? "chip active" : "chip"}
                    onClick={() => setHistFiltro(f)}
                  >
                    {Icon && <Icon size={12} />} {label}
                  </button>
                ))}
              </div>
              <ul className="list" style={{ marginTop: 10, maxHeight: 480, overflowY: "auto" }}>
                {historicoFiltrado.map((h) => {
                  const StatusIcon = STORY_STATUS_ICON[h.status] ?? Clock;
                  return (
                    <li key={h.id} className="card" style={{ padding: 10 }}>
                      <div className="card-main" style={{ width: "100%" }}>
                        <strong>
                          <span className={STORY_STATUS_COLOR[h.status] ?? "st-muted"}>
                            <StatusIcon size={14} />
                          </span>{" "}
                          {new Date(h.scheduled_at).toLocaleString("pt-BR")}
                          <span className="badge" style={{ marginLeft: 8 }}>
                            @{h.account_username}
                          </span>
                          <span className={`badge ${STORY_STATUS_COLOR[h.status] ?? "st-muted"}`} style={{ marginLeft: 4 }}>
                            {h.status}
                          </span>
                        </strong>
                        {h.legenda && (
                          <div className="meta">
                            <MessageSquare size={12} /> {h.legenda}
                          </div>
                        )}
                        {h.link && (
                          <div className="meta">
                            <Link2 size={12} /> {h.link}
                          </div>
                        )}
                        {h.confirmado_em && (
                          <div className="meta">
                            Postado e confirmado em {new Date(h.confirmado_em).toLocaleString("pt-BR")}
                          </div>
                        )}
                        {h.erro && <div className="error" style={{ marginTop: 4 }}>{h.erro}</div>}
                      </div>
                      {h.status !== "PUBLISHED" && (
                        <button className="btn danger sm" onClick={() => pedirCancelarStory(h.id)} title="Cancelar story">
                          <X size={14} />
                        </button>
                      )}
                    </li>
                  );
                })}
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
      ) : (
        <>
          <div className="selbar" style={{ marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
            <button className="btn ghost sm" onClick={() => setEditando(false)}>
              <ArrowLeft size={14} /> Voltar
            </button>
            <span className="hint">Editor de stories</span>
            {msg && <span className="hint">{msg}</span>}
            {acc && (
              <button className="btn primary" onClick={salvar} disabled={saving} style={{ marginLeft: "auto" }}>
                <Save size={14} /> {saving ? "Salvando…" : "Salvar stories"}
              </button>
            )}
          </div>

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
                    {acc.stories_enabled ? (
                      <>
                        <BookImage size={13} /> Automação de stories ativa
                      </>
                    ) : (
                      <>
                        <AlertTriangle size={13} /> Automação desativada — ligue o check em Contas.
                      </>
                    )}
                  </span>
                )}
              </div>
            </div>
          </div>

          {accountId !== "" && acc && (
            <>
              <Secao n={2} titulo="Stories ativos" dica={`o que já está programado em @${acc.username}`} />
              <div className="card">
                <div className="card-main" style={{ width: "100%" }}>
                  <strong>{modelos.length} story(s) ativo(s)</strong>
                  <div className="smodels-grid">
                    <button
                      type="button"
                      className="smodel-add"
                      onClick={() => {
                        setBibliotecaPara(null);
                        setBibliotecaAberta(true);
                      }}
                    >
                      <Plus size={26} />
                      Novo story
                    </button>
                    {modelos.map((m, i) => (
                      <div key={m.key} className="card smodel-card">
                        <div style={{ display: "flex", justifyContent: "center" }}>
                          <StoryPreview modelo={m} mediaMap={mediaMap} />
                        </div>
                        <div className="card-main" style={{ width: "100%" }}>
                          <strong>
                            <Clock size={14} /> {m.horario} — {m.texto.trim() || `Story ${i + 1}`}
                          </strong>
                          <div className="hint">
                            {m.frames.length} img
                            {m.link.trim() !== ""
                              ? ` · botão do link (posição: ${m.link_posicao})`
                              : " · sem link — texto vira legenda"}
                          </div>
                        </div>
                        <div className="card-actions" style={{ flexWrap: "wrap" }}>
                          {m.planId != null && (
                            <button
                              className="btn primary sm"
                              onClick={() => pedirPostar(m)}
                              disabled={postando === m.planId}
                              title="Publica este story imediatamente"
                            >
                              <Play size={13} /> {postando === m.planId ? "Publicando…" : "Postar agora"}
                            </button>
                          )}
                          <button className="btn sm" onClick={() => setEditModelo(i)}>
                            <Pencil size={13} /> Editar
                          </button>
                          <button className="btn danger sm" onClick={() => removerModelo(i)} title="Excluir story">
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                  {modelos.length === 0 && <div className="empty">Nenhum story ativo — clique em “＋ Novo story”.</div>}
                </div>
              </div>
            </>
          )}
        </>
      )}

      {accounts.length === 0 && (
        <div className="empty">Nenhuma conta cadastrada ainda — crie uma em Contas.</div>
      )}

      {bibliotecaAberta && (
        <BibliotecaModal
          titulo={bibliotecaPara === null ? "Novo story — escolha as imagens" : "Adicionar imagens ao story"}
          confirmLabel={bibliotecaPara === null ? "Criar story" : "Adicionar"}
          folders={folders}
          library={library}
          folderNome={folderNome}
          onConfirm={confirmarBiblioteca}
          onClose={() => setBibliotecaAberta(false)}
        />
      )}

      {editModelo !== null && modelos[editModelo] && (
        <ModelEditorModal
          key={`${editModelo}-${modelos[editModelo].frames.length}`}
          modelo={modelos[editModelo]}
          mediaMap={mediaMap}
          onAddImages={() => {
            setBibliotecaPara(editModelo);
            setBibliotecaAberta(true);
          }}
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
