import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { irPara } from "./nav";
import { PUB_STATUS_LABEL } from "./labels";
import {
  AlertTriangle,
  BookImage,
  Check,
  ChevronDown,
  ChevronUp,
  Clock,
  ImagePlus,
  Library,
  Link as LinkIcon,
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
  User,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { ConfirmDialog, ErrorBanner, Modal } from "./Dialog";
import {
  cancelPublications,
  createSharedStory,
  deleteSharedStory,
  downloadUrl,
  getStoryConfig,
  listAccounts,
  listFolders,
  listMedia,
  listSharedStories,
  listStoryHistory,
  postSharedStoryNow,
  postStoryNow,
  updateSharedStory,
  updateStoryConfig,
  type Folder,
  type Media,
  type PubAccount,
  type SharedStoryBody,
  type SharedStoryOut,
  type StoryConfig,
  type StoryHistory,
} from "./api";

/**
 * Tab "Stories": monta os stories automáticos.
 *
 * Três abas fixas, sempre no mesmo lugar: "Por conta" (1 story = 1 conta),
 * "Várias contas" (story compartilhado: cadastrado 1 vez, postado em várias
 * contas) e "Histórico". O check "Stories automáticos" continua em Contas.
 *
 * Princípio de UX: UM jeito de salvar. Cada story é editado num editor (modal)
 * com UM botão "Salvar story" no rodapé, que já grava no servidor. Nada fica
 * "pendente de salvar" na lista, e excluir pede confirmação e grava na hora.
 */

const LINK_POSICOES = [
  { value: "superior", label: "Topo" },
  { value: "meio", label: "Meio" },
  { value: "inferior", label: "Baixo" },
];
const LINK_POSICAO_LABEL: Record<string, string> = Object.fromEntries(LINK_POSICOES.map((p) => [p.value, p.label]));

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

const STORY_STATUS_LABEL = PUB_STATUS_LABEL;

/** Campos editáveis de um story — comuns aos dois modos (por conta e compartilhado). */
interface StoryDraft {
  horario: string;
  texto: string;
  link: string;
  link_posicao: string;
  texto_extra: string;
  // posição PRÓPRIA do texto extra — independente da do link: o texto extra
  // nunca concatena com o texto principal. TOTALMENTE livre (fração da tela
  // 0..1), arrastada no preview — não presa a topo/meio/baixo como o link.
  texto_extra_x: number;
  texto_extra_y: number;
  frames: number[]; // ids de Media, na ordem da sequência
  // só no modo compartilhado:
  enabled?: boolean;
  account_ids?: number[];
}

interface Modelo extends StoryDraft {
  key: number;
  planId: number; // id no servidor — habilita "Publicar agora"
}

// ---- Story COMPARTILHADO: cadastrado 1 vez, postado em várias contas (evita
// recadastrar o mesmo story conta por conta — editar e salvar atualiza em
// todas as contas-alvo de uma vez). Mesmos campos do Modelo + as contas-alvo. ----
interface SharedModelo extends StoryDraft {
  id: number;
  key: number;
  enabled: boolean;
  account_ids: number[];
}

function novoDraft(compartilhado: boolean): StoryDraft {
  return {
    horario: "18:00",
    texto: "",
    link: "",
    link_posicao: "inferior",
    texto_extra: "",
    texto_extra_x: 0.5,
    texto_extra_y: 0.5,
    frames: [],
    ...(compartilhado ? { enabled: true, account_ids: [] } : {}),
  };
}

function mapearShared(s: SharedStoryOut): SharedModelo {
  return {
    id: s.id,
    key: s.id,
    enabled: s.enabled,
    horario: s.horario,
    texto: s.texto ?? "",
    link: s.link ?? "",
    link_posicao: s.link_posicao ?? "inferior",
    texto_extra: s.texto_extra ?? "",
    texto_extra_x: s.texto_extra_x ?? 0.5,
    texto_extra_y: s.texto_extra_y ?? 0.5,
    account_ids: s.account_ids,
    frames: s.media_ids,
  };
}

function mapearConfig(cfg: StoryConfig): Modelo[] {
  return (cfg.plans ?? []).map((p) => ({
    key: p.id,
    planId: p.id,
    horario: p.horario,
    texto: p.texto ?? "",
    link: p.link ?? "",
    link_posicao: p.link_posicao ?? "inferior",
    texto_extra: p.texto_extra ?? "",
    texto_extra_x: p.texto_extra_x ?? 0.5,
    texto_extra_y: p.texto_extra_y ?? 0.5,
    frames: p.media_ids,
  }));
}

/** Converte um draft no formato de plano da API de story-config. */
function planoDoDraft(m: StoryDraft) {
  return {
    horario: m.horario,
    texto: m.texto.trim() || null,
    link: m.link.trim() || null,
    link_posicao: m.link_posicao,
    texto_extra: m.texto_extra.trim() || null,
    texto_extra_x: m.texto_extra_x,
    texto_extra_y: m.texto_extra_y,
    frames: m.frames.map((id) => ({ media_id: id })),
  };
}

function plural(n: number, um: string, varios: string) {
  return `${n} ${n === 1 ? um : varios}`;
}

function Secao({ n, titulo, dica }: { n: number; titulo: string; dica?: string }) {
  return (
    <h2 className="section-title">
      <span className="step" aria-hidden="true">
        {n}
      </span>
      {titulo}
      {dica && <span className="hint">{dica}</span>}
    </h2>
  );
}

/** Sem texto, o botão mostra o domínio do link (igual ao envio no Instagram). */
function hostDoLink(link: string): string {
  try {
    return new URL(link.trim()).host || "Link";
  } catch {
    return "Link";
  }
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Prévia 9:16 do story — mesma ideia do preview de "Criar". Quando
 * `onExtraPosChange` é passado, o texto extra fica ARRASTÁVEL no preview
 * (posição totalmente livre) e também pode ser movido pelas setas do teclado. */
function StoryPreview({
  modelo,
  mediaMap,
  onExtraPosChange,
}: {
  modelo: StoryDraft;
  mediaMap: Map<number, Media>;
  onExtraPosChange?: (p: { x: number; y: number }) => void;
}) {
  const [frameIdx, setFrameIdx] = useState(0);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const n = modelo.frames.length;
  const idxAtual = Math.min(frameIdx, Math.max(0, n - 1));
  const atual = n > 0 ? mediaMap.get(modelo.frames[idxAtual]) : undefined;
  const isVideo = atual ? VIDEO_RE.test(atual.caminho) : false;
  const posRef = useRef({ x: modelo.texto_extra_x, y: modelo.texto_extra_y });
  posRef.current = { x: modelo.texto_extra_x, y: modelo.texto_extra_y };

  useEffect(() => {
    if (!onExtraPosChange) return;
    function move(e: PointerEvent) {
      if (!dragging.current || !canvasRef.current) return;
      const r = canvasRef.current.getBoundingClientRect();
      onExtraPosChange!({
        x: clamp01((e.clientX - r.left) / r.width),
        y: clamp01((e.clientY - r.top) / r.height),
      });
    }
    function up() {
      dragging.current = false;
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [onExtraPosChange]);

  function onExtraKey(e: React.KeyboardEvent) {
    if (!onExtraPosChange) return;
    const passo = e.shiftKey ? 0.1 : 0.02;
    const { x, y } = posRef.current;
    const mov: Record<string, [number, number]> = {
      ArrowLeft: [-passo, 0],
      ArrowRight: [passo, 0],
      ArrowUp: [0, -passo],
      ArrowDown: [0, passo],
    };
    const d = mov[e.key];
    if (!d) return;
    e.preventDefault();
    onExtraPosChange({ x: clamp01(x + d[0]), y: clamp01(y + d[1]) });
  }

  return (
    <div className="preview story-preview">
      <div
        className="preview-canvas"
        ref={canvasRef}
        role="img"
        aria-label={n === 0 ? "Prévia do story — sem imagem ainda" : `Prévia do story, imagem ${idxAtual + 1} de ${n}`}
      >
        {atual ? (
          isVideo ? (
            <video className="preview-bg" src={downloadUrl(atual.id)} muted playsInline autoPlay loop preload="metadata" />
          ) : (
            <img className="preview-bg" src={downloadUrl(atual.id)} alt="" />
          )
        ) : (
          <div className="preview-bg preview-bg-empty">
            <ImagePlus size={28} aria-hidden="true" />
            <span>Sem imagem</span>
          </div>
        )}
        {!modelo.link && modelo.texto && <div className="story-preview-texto">{modelo.texto}</div>}
        {/* texto extra é INDEPENDENTE do texto principal e do link: nunca concatena,
            sempre aparece (com ou sem link), na posição TOTALMENTE livre dele. */}
        {modelo.texto_extra && (
          <div
            className={onExtraPosChange ? "story-preview-extra draggable" : "story-preview-extra"}
            style={{ left: `${modelo.texto_extra_x * 100}%`, top: `${modelo.texto_extra_y * 100}%` }}
            {...(onExtraPosChange
              ? {
                  role: "button",
                  tabIndex: 0,
                  "aria-label": "Texto extra. Arraste com o mouse ou use as setas do teclado para mover.",
                  onPointerDown: (e: React.PointerEvent) => {
                    e.preventDefault();
                    dragging.current = true;
                  },
                  onKeyDown: onExtraKey,
                }
              : {})}
          >
            {modelo.texto_extra}
          </div>
        )}
        {modelo.link && (
          <div className={`story-preview-link pos-${modelo.link_posicao || "inferior"}`}>
            <LinkIcon className="story-preview-link-icon" strokeWidth={2.6} aria-hidden="true" />
            <span className="story-preview-link-label">{modelo.texto.trim() || hostDoLink(modelo.link)}</span>
          </div>
        )}
      </div>
      {n > 1 && (
        <div className="spreview-pager" role="group" aria-label="Ver imagem da sequência">
          {modelo.frames.map((_, j) => (
            <button
              key={j}
              type="button"
              className={`btn sm ${j === idxAtual ? "primary" : ""}`}
              aria-label={`Ver imagem ${j + 1}`}
              aria-pressed={j === idxAtual}
              onClick={() => setFrameIdx(j)}
            >
              {j + 1}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Biblioteca de mídias em MODAL — escolhe imagens para o story em edição. */
function BibliotecaModal({
  folders,
  library,
  jaNoStory,
  folderNome,
  onConfirm,
  onClose,
}: {
  folders: Folder[];
  library: Media[];
  jaNoStory: number[];
  folderNome: (id: number | null) => string;
  onConfirm: (ids: number[]) => void;
  onClose: () => void;
}) {
  const [folderFilter, setFolderFilter] = useState<number | "all" | "none">("all");
  // a ordem de clique vira a ordem da sequência
  const [selected, setSelected] = useState<number[]>([]);

  const filtradas = useMemo(() => {
    let lista = library;
    if (folderFilter === "none") lista = lista.filter((m) => m.folder_id == null);
    else if (folderFilter !== "all") lista = lista.filter((m) => m.folder_id === folderFilter);
    return lista;
  }, [library, folderFilter]);

  function toggleSel(id: number) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  return (
    <Modal
      title="Escolher imagens da biblioteca"
      onClose={onClose}
      wide
      scroll
      top
      footer={
        <>
          <span className="modal-foot-status" aria-live="polite">
            {selected.length > 0 ? plural(selected.length, "imagem escolhida", "imagens escolhidas") : "Nenhuma imagem escolhida"}
          </span>
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="btn primary" disabled={selected.length === 0} onClick={() => onConfirm(selected)}>
            <Plus size={14} aria-hidden="true" /> Adicionar ao story
          </button>
        </>
      }
    >
      <div className="checkrow" style={{ gap: 12, flexWrap: "wrap", marginBottom: 12, alignItems: "flex-end" }}>
        <label className="field" style={{ width: 240 }}>
          Mostrar imagens da pasta
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
                {f.nome}
              </option>
            ))}
          </select>
        </label>
        <p className="hint" style={{ margin: 0 }}>
          Clique numa imagem para escolher. Clique de novo para desmarcar. O número mostra a ordem no story.
        </p>
      </div>
      <div className="sgrid">
        {filtradas.map((m) => {
          const isVideo = VIDEO_RE.test(m.caminho);
          const ordem = selected.indexOf(m.id);
          const jaTem = jaNoStory.includes(m.id);
          return (
            <button
              type="button"
              key={m.id}
              aria-pressed={ordem >= 0}
              disabled={jaTem}
              title={jaTem ? "Essa imagem já está no story" : m.nome_original}
              className={ordem >= 0 ? "scard selected" : "scard"}
              onClick={() => toggleSel(m.id)}
            >
              {isVideo ? (
                <video className="thumb" src={downloadUrl(m.id)} preload="metadata" muted />
              ) : (
                <img className="thumb" src={downloadUrl(m.id)} alt="" />
              )}
              <span className="scard-nome">{m.nome_original}</span>
              <span className="scard-pasta">{folderNome(m.folder_id)}</span>
              {ordem >= 0 && <span className="scard-check">{ordem + 1}</span>}
              {jaTem && <span className="scard-ja">Já no story</span>}
            </button>
          );
        })}
        {filtradas.length === 0 && <div className="empty">Nenhuma imagem nessa pasta.</div>}
      </div>
    </Modal>
  );
}

/** Um passo numerado dentro do editor. */
function Passo({ n, titulo, children }: { n: number; titulo: string; children: ReactNode }) {
  return (
    <section className="seditor-step" aria-labelledby={`seditor-step-${n}`}>
      <h4 id={`seditor-step-${n}`} className="seditor-step-title">
        <span className="step" aria-hidden="true">
          {n}
        </span>
        {titulo}
      </h4>
      {children}
    </section>
  );
}

/** Editor ÚNICO de story (por conta e compartilhado). Tem UM botão de salvar, no
 * rodapé fixo, que grava direto no servidor. `accounts` presente = modo compartilhado. */
function StoryEditorModal({
  inicial,
  novo,
  accounts,
  contaNome,
  mediaMap,
  folders,
  library,
  folderNome,
  onSave,
  onClose,
}: {
  inicial: StoryDraft;
  novo: boolean;
  accounts?: PubAccount[];
  contaNome?: string;
  mediaMap: Map<number, Media>;
  folders: Folder[];
  library: Media[];
  folderNome: (id: number | null) => string;
  /** Grava no servidor. Devolve null se deu certo, ou a mensagem de erro. */
  onSave: (d: StoryDraft) => Promise<string | null>;
  onClose: () => void;
}) {
  const [d, setD] = useState<StoryDraft>(inicial);
  const [bibliotecaAberta, setBibliotecaAberta] = useState(false);
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [confirmaSair, setConfirmaSair] = useState(false);
  const compartilhado = accounts != null;
  const alterado = JSON.stringify(d) !== JSON.stringify(inicial);
  const temLink = d.link.trim() !== "";
  const contasSel = d.account_ids ?? [];

  const faltando: string[] = [];
  if (d.frames.length === 0) faltando.push("escolher pelo menos 1 imagem (passo 1)");
  if (!d.horario) faltando.push("escolher o horário (passo 2)");
  if (compartilhado && contasSel.length === 0) faltando.push("marcar pelo menos 1 conta (passo 5)");
  const podeSalvar = faltando.length === 0 && !salvando;

  function pedirFechar() {
    if (salvando) return;
    if (alterado) setConfirmaSair(true);
    else onClose();
  }

  async function salvar() {
    if (!podeSalvar) return;
    setSalvando(true);
    setErro(null);
    const r = await onSave(d);
    setSalvando(false);
    if (r) setErro(r);
  }

  function moverFrame(fIdx: number, delta: number) {
    setD((prev) => {
      const frames = [...prev.frames];
      const j = fIdx + delta;
      if (j < 0 || j >= frames.length) return prev;
      [frames[fIdx], frames[j]] = [frames[j], frames[fIdx]];
      return { ...prev, frames };
    });
  }

  function toggleAccount(id: number) {
    setD((prev) => {
      const ids = prev.account_ids ?? [];
      return { ...prev, account_ids: ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id] };
    });
  }

  const titulo = novo
    ? compartilhado
      ? "Novo story para várias contas"
      : `Novo story${contaNome ? ` — @${contaNome}` : ""}`
    : compartilhado
      ? "Editar story de várias contas"
      : `Editar story${contaNome ? ` — @${contaNome}` : ""}`;

  return (
    <Modal
      title={titulo}
      onClose={pedirFechar}
      wide
      scroll
      footer={
        <>
          <div className="modal-foot-status" aria-live="polite">
            {erro ? (
              <span className="st-danger">
                <AlertTriangle size={14} aria-hidden="true" /> Não foi possível salvar: {erro}
              </span>
            ) : faltando.length > 0 ? (
              <span>
                <AlertTriangle size={14} aria-hidden="true" className="st-warn" /> Para salvar, falta: {faltando.join(" e ")}.
              </span>
            ) : alterado || novo ? (
              <span className="st-ok">
                <Check size={14} aria-hidden="true" /> Tudo pronto para salvar.
              </span>
            ) : (
              <span>Nenhuma alteração.</span>
            )}
          </div>
          <button type="button" className="btn ghost" onClick={pedirFechar} disabled={salvando}>
            Cancelar
          </button>
          <button type="button" className="btn primary" onClick={salvar} disabled={!podeSalvar}>
            <Save size={14} aria-hidden="true" /> {salvando ? "Salvando…" : "Salvar story"}
          </button>
        </>
      }
    >
      <div className="seditor">
        <div className="seditor-form">
          <Passo n={1} titulo="Imagens">
            <p className="field-help">A ordem da lista é a ordem em que as imagens aparecem no story.</p>
            {d.frames.length > 0 && (
              <ol className="sframes">
                {d.frames.map((id, j) => {
                  const media = mediaMap.get(id);
                  const nome = media?.nome_original ?? `mídia #${id} (removida)`;
                  return (
                    <li className="sframe" key={`${id}-${j}`}>
                      <span className="sframe-num" aria-hidden="true">
                        {j + 1}
                      </span>
                      {media ? (
                        <img className="mini-thumb" src={downloadUrl(id)} alt="" />
                      ) : (
                        <div className="mini-thumb">❓</div>
                      )}
                      <span className="sframe-nome" title={nome}>
                        {nome}
                      </span>
                      <button
                        type="button"
                        className="btn ghost sm"
                        aria-label={`Subir imagem ${j + 1}`}
                        title="Subir"
                        disabled={j === 0}
                        onClick={() => moverFrame(j, -1)}
                      >
                        <ChevronUp size={14} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="btn ghost sm"
                        aria-label={`Descer imagem ${j + 1}`}
                        title="Descer"
                        disabled={j === d.frames.length - 1}
                        onClick={() => moverFrame(j, 1)}
                      >
                        <ChevronDown size={14} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="btn danger sm"
                        aria-label={`Tirar imagem ${j + 1} do story`}
                        onClick={() => setD({ ...d, frames: d.frames.filter((_, k) => k !== j) })}
                      >
                        <X size={14} aria-hidden="true" /> Tirar
                      </button>
                    </li>
                  );
                })}
              </ol>
            )}
            {d.frames.length === 0 ? (
              <button type="button" className="sframes-empty" onClick={() => setBibliotecaAberta(true)}>
                <ImagePlus size={24} aria-hidden="true" />
                Escolher imagens da biblioteca
              </button>
            ) : (
              <button type="button" className="btn" style={{ marginTop: 8 }} onClick={() => setBibliotecaAberta(true)}>
                <ImagePlus size={14} aria-hidden="true" /> Adicionar mais imagens
              </button>
            )}
          </Passo>

          <Passo n={2} titulo="Quando publicar">
            <div className="checkrow" style={{ gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
              <label className="field" style={{ width: 170 }}>
                Todo dia, às
                <input type="time" value={d.horario} onChange={(e) => setD({ ...d, horario: e.target.value })} />
              </label>
              {compartilhado && (
                <label className="switch-row">
                  <input
                    type="checkbox"
                    checked={d.enabled ?? true}
                    onChange={(e) => setD({ ...d, enabled: e.target.checked })}
                  />
                  <span>
                    <strong>{d.enabled ?? true ? "Ativo" : "Pausado"}</strong>
                    <span className="field-help">
                      {d.enabled ?? true ? "Será publicado todo dia." : "Não será publicado até você ativar de novo."}
                    </span>
                  </span>
                </label>
              )}
            </div>
          </Passo>

          <Passo n={3} titulo="Link e texto principal">
            <label className="field">
              <span>
                Link <span className="field-opt">(opcional)</span>
              </span>
              <input
                type="url"
                inputMode="url"
                value={d.link}
                onChange={(e) => setD({ ...d, link: e.target.value })}
                placeholder="https://…"
              />
            </label>
            <div className="field" role="group" aria-labelledby="pos-link-label" style={{ marginTop: 10 }}>
              <span id="pos-link-label">Onde fica o botão do link</span>
              <div className="seg seg-sm" style={{ maxWidth: 300 }}>
                {LINK_POSICOES.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    className={d.link_posicao === p.value ? "seg-btn active" : "seg-btn"}
                    aria-pressed={d.link_posicao === p.value}
                    disabled={!temLink}
                    onClick={() => setD({ ...d, link_posicao: p.value })}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              {!temLink && <span className="field-help">Preencha o link para escolher a posição do botão.</span>}
            </div>
            <label className="field" style={{ marginTop: 10 }}>
              <span>
                Texto principal <span className="field-opt">(opcional)</span>
              </span>
              <input value={d.texto} onChange={(e) => setD({ ...d, texto: e.target.value })} placeholder="Ex.: Confere aí 👇" />
              <span className="field-help">
                {temLink
                  ? "Com link: este texto aparece dentro do botão do link."
                  : "Sem link: este texto aparece como legenda do story."}
              </span>
            </label>
          </Passo>

          <Passo n={4} titulo="Texto extra">
            <label className="field">
              <span>
                Texto extra <span className="field-opt">(opcional)</span>
              </span>
              <input
                value={d.texto_extra}
                onChange={(e) => setD({ ...d, texto_extra: e.target.value })}
                placeholder="Ex.: Só hoje!"
              />
              <span className="field-help">
                Aparece separado do texto principal. Para mudar o lugar, arraste o texto na prévia (ou clique nele e use as
                setas do teclado).
              </span>
            </label>
            {d.texto_extra.trim() !== "" && (
              <button
                type="button"
                className="btn sm"
                style={{ marginTop: 8 }}
                onClick={() => setD({ ...d, texto_extra_x: 0.5, texto_extra_y: 0.5 })}
              >
                Voltar o texto extra para o centro
              </button>
            )}
          </Passo>

          {compartilhado && (
            <Passo n={5} titulo="Contas que recebem este story">
              <div className="checkrow" style={{ gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 6 }}>
                <span className="field-help" style={{ margin: 0 }}>
                  {plural(contasSel.length, "conta marcada", "contas marcadas")} de {accounts!.length}
                </span>
                <button type="button" className="btn sm" onClick={() => setD({ ...d, account_ids: accounts!.map((a) => a.id) })}>
                  Marcar todas
                </button>
                <button type="button" className="btn sm" onClick={() => setD({ ...d, account_ids: [] })}>
                  Desmarcar todas
                </button>
              </div>
              <div className="checklist">
                {accounts!.map((a) => (
                  <label key={a.id} className={contasSel.includes(a.id) ? "chk picked" : "chk"}>
                    <input type="checkbox" checked={contasSel.includes(a.id)} onChange={() => toggleAccount(a.id)} />
                    <span className="chk-name">@{a.username}</span>
                  </label>
                ))}
                {accounts!.length === 0 && <div className="hint">Nenhuma conta cadastrada ainda — crie uma em Contas.</div>}
              </div>
            </Passo>
          )}
        </div>

        <aside className="seditor-preview" aria-label="Prévia">
          <div className="seditor-preview-title">Prévia</div>
          <StoryPreview
            modelo={d}
            mediaMap={mediaMap}
            onExtraPosChange={(p) => setD((prev) => ({ ...prev, texto_extra_x: p.x, texto_extra_y: p.y }))}
          />
        </aside>
      </div>

      {bibliotecaAberta && (
        <BibliotecaModal
          folders={folders}
          library={library}
          jaNoStory={d.frames}
          folderNome={folderNome}
          onConfirm={(ids) => {
            setD((prev) => ({ ...prev, frames: [...prev.frames, ...ids.filter((id) => !prev.frames.includes(id))] }));
            setBibliotecaAberta(false);
          }}
          onClose={() => setBibliotecaAberta(false)}
        />
      )}
      {confirmaSair && (
        <ConfirmDialog
          title="Sair sem salvar?"
          message="Você fez alterações neste story que ainda não foram salvas. Se sair agora, elas serão perdidas."
          cancelLabel="Continuar editando"
          confirmLabel="Sair sem salvar"
          onConfirm={() => {
            setConfirmaSair(false);
            onClose();
          }}
          onClose={() => setConfirmaSair(false)}
        />
      )}
    </Modal>
  );
}

/** Cartão-resumo de um story na lista (mesmo layout nos dois modos). */
function StoryCard({
  m,
  mediaMap,
  contas,
  pausado,
  publicando,
  podePublicar,
  onEditar,
  onPublicar,
  onExcluir,
}: {
  m: StoryDraft;
  mediaMap: Map<number, Media>;
  contas?: string[];
  pausado?: boolean;
  publicando: boolean;
  podePublicar: boolean;
  onEditar: () => void;
  onPublicar: () => void;
  onExcluir: () => void;
}) {
  return (
    <li className={`card smodel-card${pausado ? " paused" : ""}`}>
      <StoryPreview modelo={m} mediaMap={mediaMap} />
      <div className="smodel-info">
        <div className="smodel-time">
          <Clock size={15} aria-hidden="true" /> Todo dia às {m.horario}
          {pausado && <span className="pill pill-muted">Pausado</span>}
        </div>
        <ul className="smodel-facts">
          <li>{plural(m.frames.length, "imagem", "imagens")}</li>
          <li>
            {m.link.trim() !== ""
              ? `Com link · botão no ${LINK_POSICAO_LABEL[m.link_posicao]?.toLowerCase() ?? "baixo"}`
              : "Sem link"}
          </li>
          {m.texto.trim() !== "" && <li className="smodel-text">“{m.texto.trim()}”</li>}
          {contas && (
            <li>
              <Users size={12} aria-hidden="true" />{" "}
              {contas.length === 0 ? <span className="st-danger">Nenhuma conta marcada</span> : contas.join(", ")}
            </li>
          )}
        </ul>
      </div>
      <div className="smodel-actions">
        <button type="button" className="btn primary" onClick={onEditar}>
          <Pencil size={14} aria-hidden="true" /> Editar
        </button>
        <button
          type="button"
          className="btn"
          onClick={onPublicar}
          disabled={publicando || !podePublicar}
          title="Publica este story agora, sem esperar o horário"
        >
          <Play size={14} aria-hidden="true" /> {publicando ? "Publicando…" : "Publicar agora"}
        </button>
        <button type="button" className="btn danger" onClick={onExcluir}>
          <Trash2 size={14} aria-hidden="true" /> Excluir
        </button>
      </div>
    </li>
  );
}

interface HistoryItem extends StoryHistory {
  account_id: number;
  account_username: string;
}

type Aba = "conta" | "compartilhado" | "historico";
const ABAS: { id: Aba; label: string; icon: LucideIcon; desc: string }[] = [
  { id: "conta", label: "Por conta", icon: User, desc: "Stories de uma conta só. Escolha a conta e crie ou edite os stories dela." },
  {
    id: "compartilhado",
    label: "Várias contas",
    icon: Users,
    desc: "Um story criado uma vez e publicado em todas as contas que você marcar.",
  },
  { id: "historico", label: "Histórico", icon: Library, desc: "O que já foi publicado, o que está agendado e o que deu erro." },
];
const ABA_KEY = "nitro.stories.aba";

export default function Stories() {
  const [accounts, setAccounts] = useState<PubAccount[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [library, setLibrary] = useState<Media[]>([]);
  const [aba, setAbaState] = useState<Aba>(() => {
    const salvo = localStorage.getItem(ABA_KEY);
    return salvo === "conta" || salvo === "compartilhado" || salvo === "historico" ? salvo : "conta";
  });
  const [accountId, setAccountId] = useState<number | "">("");
  const [modelos, setModelos] = useState<Modelo[]>([]);
  const [carregandoConta, setCarregandoConta] = useState(false);
  const [sharedModelos, setSharedModelos] = useState<SharedModelo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [postando, setPostando] = useState<string | null>(null);
  const [historico, setHistorico] = useState<HistoryItem[]>([]);
  const [histFiltro, setHistFiltro] = useState<"todos" | "PENDING" | "PUBLISHED" | "erro">("todos");
  // story aberto no editor: idx null = story novo
  const [editor, setEditor] = useState<null | { modo: "conta" | "compartilhado"; idx: number | null }>(null);
  const [confirma, setConfirma] = useState<null | {
    titulo: string;
    mensagem: ReactNode;
    rotulo: string;
    tone?: "danger" | "primary";
    acao: () => void;
  }>(null);

  function setAba(a: Aba) {
    setAbaState(a);
    localStorage.setItem(ABA_KEY, a);
  }

  // mensagem de sucesso some sozinha depois de alguns segundos
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 7000);
    return () => clearTimeout(t);
  }, [msg]);

  // carrega contas, pastas e TODAS as imagens do banco uma vez (a pasta filtra em memória)
  useEffect(() => {
    listAccounts().then(setAccounts).catch((e) => setError(String(e)));
    listFolders().then(setFolders).catch(() => {});
    Promise.all([listMedia("photo"), listMedia("photo_hot")])
      .then(([a, b]) => setLibrary([...a, ...b]))
      .catch((e) => setError(String(e)));
    listSharedStories()
      .then((list) => setSharedModelos(list.map(mapearShared)))
      .catch((e) => setError(String(e)));
  }, []);

  // com uma conta só, já deixa ela escolhida
  useEffect(() => {
    if (accountId === "" && accounts.length === 1) setAccountId(accounts[0].id);
  }, [accounts, accountId]);

  const acc = accountId === "" ? undefined : accounts.find((a) => a.id === accountId);

  // ao trocar de conta, carrega os stories dela
  useEffect(() => {
    if (accountId === "") {
      setModelos([]);
      return;
    }
    setCarregandoConta(true);
    getStoryConfig(accountId)
      .then((cfg) => setModelos(mapearConfig(cfg)))
      .catch((e) => setError(String(e)))
      .finally(() => setCarregandoConta(false));
  }, [accountId]);

  function atualizarHistorico() {
    if (accounts.length === 0) return;
    Promise.all(
      accounts.map((a) =>
        listStoryHistory(a.id).then((xs) => xs.map((x) => ({ ...x, account_id: a.id, account_username: a.username })))
      )
    )
      .then((xs) => setHistorico(xs.flat().sort((a, b) => +new Date(b.scheduled_at) - +new Date(a.scheduled_at))))
      .catch((e) => setError(String(e)));
  }

  // histórico de TODAS as contas (uma chamada por conta, mesclado)
  useEffect(atualizarHistorico, [accounts]);

  const mediaMap = useMemo(() => new Map(library.map((m) => [m.id, m])), [library]);

  const historicoFiltrado = historico.filter((h) =>
    histFiltro === "todos"
      ? true
      : histFiltro === "erro"
        ? h.status === "FAILED" || h.status === "RETRYING" || Boolean(h.erro)
        : h.status === histFiltro
  );
  const pendentes = historico.filter((h) => h.status !== "PUBLISHED" && h.status !== "CANCELLED");

  function folderNome(folderId: number | null): string {
    if (folderId == null) return "Sem pasta";
    return folders.find((f) => f.id === folderId)?.nome ?? "Sem pasta";
  }

  function nomesContas(ids: number[]) {
    return accounts.filter((a) => ids.includes(a.id)).map((a) => `@${a.username}`);
  }

  // ---------- por conta: cada ação grava a lista inteira de planos da conta ----------
  async function gravarPlanosConta(lista: StoryDraft[]) {
    if (!acc) throw new Error("Escolha a conta primeiro.");
    const cfg = await updateStoryConfig(acc.id, {
      // o check em Contas controla a automação; aqui só a configuração é salva
      enabled: acc.stories_enabled,
      plans: lista.filter((m) => m.frames.length > 0).map(planoDoDraft),
    });
    setModelos(mapearConfig(cfg));
  }

  async function salvarConta(idx: number | null, d: StoryDraft): Promise<string | null> {
    const lista: StoryDraft[] = idx === null ? [...modelos, d] : modelos.map((m, i) => (i === idx ? d : m));
    try {
      await gravarPlanosConta(lista);
      setEditor(null);
      setMsg(`Story salvo. Será publicado todo dia às ${d.horario} em @${acc?.username}.`);
      return null;
    } catch (e) {
      return String(e);
    }
  }

  function pedirExcluirConta(idx: number) {
    const m = modelos[idx];
    setConfirma({
      titulo: "Excluir story",
      mensagem: (
        <>
          Excluir o story das <strong>{m.horario}</strong> da <strong>@{acc?.username}</strong>? Ele deixa de ser publicado.
          Isso não pode ser desfeito.
        </>
      ),
      rotulo: "Excluir story",
      acao: async () => {
        try {
          await gravarPlanosConta(modelos.filter((_, i) => i !== idx));
          setMsg("Story excluído.");
        } catch (e) {
          setError(String(e));
        }
      },
    });
  }

  function pedirPostarConta(m: Modelo) {
    setConfirma({
      titulo: "Publicar agora?",
      mensagem: (
        <>
          O story das <strong>{m.horario}</strong> será publicado <strong>agora</strong> na <strong>@{acc?.username}</strong>.
          O horário de todo dia continua valendo.
        </>
      ),
      rotulo: "Publicar agora",
      tone: "primary",
      acao: () => postarAgoraConta(m),
    });
  }

  async function postarAgoraConta(m: Modelo) {
    if (!acc) return;
    setError(null);
    setPostando(`c${m.planId}`);
    try {
      const r = await postStoryNow(acc.id, m.planId);
      if (r.status === "PUBLISHED") setMsg("Story publicado e confirmado no Instagram.");
      else if (r.status === "RETRYING") setMsg(`O Instagram falhou, vamos tentar de novo sozinhos (${r.erro ?? "falha temporária"}).`);
      else setError(`Story não publicado (${STORY_STATUS_LABEL[r.status] ?? r.status})${r.erro ? `: ${r.erro}` : ""}`);
      atualizarHistorico();
    } catch (e) {
      setError(String(e));
    } finally {
      setPostando(null);
    }
  }

  // ---------- compartilhado: cada story é uma entidade própria no servidor ----------
  async function salvarCompartilhado(idx: number | null, d: StoryDraft): Promise<string | null> {
    const atual = idx === null ? undefined : sharedModelos[idx];
    const body: SharedStoryBody = {
      enabled: d.enabled ?? true,
      horario: d.horario,
      texto: d.texto.trim() || null,
      link: d.link.trim() || null,
      link_posicao: d.link_posicao,
      texto_extra: d.texto_extra.trim() || null,
      texto_extra_x: d.texto_extra_x,
      texto_extra_y: d.texto_extra_y,
      account_ids: d.account_ids ?? [],
      frames: d.frames.map((id) => ({ media_id: id })),
    };
    try {
      const salvo = atual ? await updateSharedStory(atual.id, body) : await createSharedStory(body);
      setSharedModelos((prev) => (atual ? prev.map((m, i) => (i === idx ? mapearShared(salvo) : m)) : [...prev, mapearShared(salvo)]));
      setEditor(null);
      const n = body.account_ids.length;
      setMsg(
        body.enabled
          ? `Story salvo. Será publicado todo dia às ${d.horario} em ${plural(n, "conta", "contas")}.`
          : "Story salvo. Ele está pausado e não será publicado até você ativar."
      );
      return null;
    } catch (e) {
      return String(e);
    }
  }

  function pedirExcluirCompartilhado(idx: number) {
    const m = sharedModelos[idx];
    setConfirma({
      titulo: "Excluir story",
      mensagem: (
        <>
          Excluir o story das <strong>{m.horario}</strong>? Ele deixa de ser publicado em{" "}
          <strong>{plural(m.account_ids.length, "conta", "contas")}</strong>. Isso não pode ser desfeito.
        </>
      ),
      rotulo: "Excluir story",
      acao: async () => {
        try {
          await deleteSharedStory(m.id);
          setSharedModelos((prev) => prev.filter((x) => x.id !== m.id));
          setMsg("Story excluído.");
        } catch (e) {
          setError(String(e));
        }
      },
    });
  }

  function pedirPostarCompartilhado(m: SharedModelo) {
    setConfirma({
      titulo: "Publicar agora?",
      mensagem: (
        <>
          O story das <strong>{m.horario}</strong> será publicado <strong>agora</strong> em{" "}
          <strong>{plural(m.account_ids.length, "conta", "contas")}</strong>: {nomesContas(m.account_ids).join(", ")}. O
          horário de todo dia continua valendo.
        </>
      ),
      rotulo: "Publicar agora",
      tone: "primary",
      acao: () => postarAgoraCompartilhado(m),
    });
  }

  async function postarAgoraCompartilhado(m: SharedModelo) {
    setPostando(`s${m.id}`);
    setError(null);
    try {
      await postSharedStoryNow(m.id);
      setMsg(`Story enviado para ${plural(m.account_ids.length, "conta", "contas")}. Acompanhe na aba Histórico.`);
      atualizarHistorico();
    } catch (e) {
      setError(String(e));
    } finally {
      setPostando(null);
    }
  }

  // ---------- histórico ----------
  function pedirCancelarStory(h: HistoryItem) {
    setConfirma({
      titulo: "Cancelar este story?",
      mensagem: (
        <>
          O story de <strong>{new Date(h.scheduled_at).toLocaleString("pt-BR")}</strong> na{" "}
          <strong>@{h.account_username}</strong> não será publicado.
        </>
      ),
      rotulo: "Cancelar story",
      acao: async () => {
        try {
          await cancelPublications([h.id]);
          atualizarHistorico();
          setMsg("Story cancelado.");
        } catch (e) {
          setError(String(e));
        }
      },
    });
  }

  function pedirCancelarPendentes() {
    const ids = pendentes.map((h) => h.id);
    if (ids.length === 0) return;
    setConfirma({
      titulo: "Cancelar todos os pendentes?",
      mensagem: <>{plural(ids.length, "story ainda não publicado será cancelado", "stories ainda não publicados serão cancelados")}.</>,
      rotulo: "Cancelar todos",
      acao: async () => {
        try {
          await cancelPublications(ids);
          atualizarHistorico();
          setMsg("Stories pendentes cancelados.");
        } catch (e) {
          setError(String(e));
        }
      },
    });
  }

  const abaAtual = ABAS.find((a) => a.id === aba)!;
  const editorInicial: StoryDraft | null = !editor
    ? null
    : editor.idx === null
      ? novoDraft(editor.modo === "compartilhado")
      : editor.modo === "compartilhado"
        ? sharedModelos[editor.idx] ?? null
        : modelos[editor.idx] ?? null;

  return (
    <div className="stories-page">
      <div className="stabs" role="tablist" aria-label="Seções de stories">
        {ABAS.map((a) => {
          const Icon = a.icon;
          return (
            <button
              key={a.id}
              type="button"
              role="tab"
              id={`stab-${a.id}`}
              aria-selected={aba === a.id}
              aria-controls="stab-panel"
              className={aba === a.id ? "stab active" : "stab"}
              onClick={() => setAba(a.id)}
            >
              <Icon size={16} aria-hidden="true" /> {a.label}
            </button>
          );
        })}
      </div>
      <p className="stabs-desc">{abaAtual.desc}</p>

      {msg && (
        <div className="notice-ok" role="status">
          <Check size={16} aria-hidden="true" />
          <span>{msg}</span>
          <button type="button" className="notice-x" aria-label="Fechar aviso" onClick={() => setMsg(null)}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
      <ErrorBanner error={error} onClose={() => setError(null)} />

      <div id="stab-panel" role="tabpanel" aria-labelledby={`stab-${aba}`}>
        {accounts.length === 0 && (
          <div className="empty">
            <p style={{ margin: "0 0 12px" }}>Nenhuma conta cadastrada ainda. Cadastre uma conta para criar stories.</p>
            <button type="button" className="btn primary" onClick={() => irPara("/contas")}>
              Ir para Contas
            </button>
          </div>
        )}

        {aba === "conta" && accounts.length > 0 && (
          <>
            <Secao n={1} titulo="Escolha a conta" />
            <div className="card">
              <div className="card-main" style={{ width: "100%" }}>
                <label className="field" style={{ maxWidth: 420 }}>
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
                  <p className={`sauto ${acc.stories_enabled ? "on" : "off"}`}>
                    {acc.stories_enabled ? (
                      <>
                        <BookImage size={15} aria-hidden="true" /> Stories automáticos <strong>ligados</strong> nesta conta.
                      </>
                    ) : (
                      <>
                        <AlertTriangle size={15} aria-hidden="true" /> Stories automáticos <strong>desligados</strong> nesta
                        conta: nada será publicado sozinho. Para ligar, vá em Contas e marque “Stories automáticos”.{" "}
                        <button type="button" className="linkbtn" onClick={() => irPara("/contas")}>
                          Ir para Contas
                        </button>
                      </>
                    )}
                  </p>
                )}
              </div>
            </div>

            {acc && (
              <>
                <Secao n={2} titulo={`Stories da @${acc.username}`} />
                {carregandoConta ? (
                  <div className="loading">Carregando stories…</div>
                ) : (
                  <ul className="smodels-grid">
                    <li>
                      <button type="button" className="smodel-add" onClick={() => setEditor({ modo: "conta", idx: null })}>
                        <Plus size={26} aria-hidden="true" />
                        Criar story novo
                      </button>
                    </li>
                    {modelos.map((m, i) => (
                      <StoryCard
                        key={m.key}
                        m={m}
                        mediaMap={mediaMap}
                        publicando={postando === `c${m.planId}`}
                        podePublicar
                        onEditar={() => setEditor({ modo: "conta", idx: i })}
                        onPublicar={() => pedirPostarConta(m)}
                        onExcluir={() => pedirExcluirConta(i)}
                      />
                    ))}
                  </ul>
                )}
              </>
            )}
          </>
        )}

        {aba === "compartilhado" && accounts.length > 0 && (
          <ul className="smodels-grid">
            <li>
              <button type="button" className="smodel-add" onClick={() => setEditor({ modo: "compartilhado", idx: null })}>
                <Plus size={26} aria-hidden="true" />
                Criar story novo
              </button>
            </li>
            {sharedModelos.map((m, i) => (
              <StoryCard
                key={m.key}
                m={m}
                mediaMap={mediaMap}
                contas={nomesContas(m.account_ids)}
                pausado={!m.enabled}
                publicando={postando === `s${m.id}`}
                podePublicar={m.account_ids.length > 0}
                onEditar={() => setEditor({ modo: "compartilhado", idx: i })}
                onPublicar={() => pedirPostarCompartilhado(m)}
                onExcluir={() => pedirExcluirCompartilhado(i)}
              />
            ))}
          </ul>
        )}

        {aba === "historico" && accounts.length > 0 && (
          <div className="card">
            <div className="card-main" style={{ width: "100%" }}>
              <div className="checkrow" style={{ gap: 8, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
                <div className="checkrow" style={{ gap: 6, flexWrap: "wrap" }} role="group" aria-label="Filtrar histórico">
                  {(
                    [
                      ["todos", "Todos", null],
                      ["PENDING", "Agendados", Clock],
                      ["PUBLISHED", "Publicados", Check],
                      ["erro", "Com erro", AlertTriangle],
                    ] as const
                  ).map(([f, label, Icon]) => (
                    <button
                      key={f}
                      type="button"
                      aria-pressed={histFiltro === f}
                      className={histFiltro === f ? "chip active" : "chip"}
                      onClick={() => setHistFiltro(f)}
                    >
                      {Icon && <Icon size={12} aria-hidden="true" />} {label}
                    </button>
                  ))}
                </div>
                <div className="checkrow" style={{ gap: 6 }}>
                  <button type="button" className="btn sm" onClick={atualizarHistorico}>
                    <RefreshCw size={13} aria-hidden="true" /> Atualizar lista
                  </button>
                  <button type="button" className="btn danger sm" onClick={pedirCancelarPendentes} disabled={pendentes.length === 0}>
                    <Trash2 size={13} aria-hidden="true" /> Cancelar todos os pendentes
                  </button>
                </div>
              </div>
              <ul className="list" style={{ marginTop: 12, maxHeight: 560, overflowY: "auto" }}>
                {historicoFiltrado.map((h) => {
                  const StatusIcon = STORY_STATUS_ICON[h.status] ?? Clock;
                  const cor = STORY_STATUS_COLOR[h.status] ?? "st-muted";
                  return (
                    <li key={h.id} className="card" style={{ padding: 12 }}>
                      <div className="card-main" style={{ width: "100%" }}>
                        <div className="shist-head">
                          <span className={`pill ${cor}`}>
                            <StatusIcon size={13} aria-hidden="true" /> {STORY_STATUS_LABEL[h.status] ?? h.status}
                          </span>
                          <span>{new Date(h.scheduled_at).toLocaleString("pt-BR")}</span>
                          <span className="pill pill-muted">@{h.account_username}</span>
                        </div>
                        {h.legenda && (
                          <div className="meta">
                            <MessageSquare size={12} aria-hidden="true" /> {h.legenda}
                          </div>
                        )}
                        {h.link && (
                          <div className="meta">
                            <Link2 size={12} aria-hidden="true" /> {h.link}
                          </div>
                        )}
                        {h.confirmado_em && (
                          <div className="meta">Confirmado no Instagram em {new Date(h.confirmado_em).toLocaleString("pt-BR")}</div>
                        )}
                        {h.erro && (
                          <div className="error" style={{ marginTop: 6, marginBottom: 0 }}>
                            {h.erro}
                          </div>
                        )}
                      </div>
                      {h.status !== "PUBLISHED" && h.status !== "CANCELLED" && (
                        <button type="button" className="btn danger sm" onClick={() => pedirCancelarStory(h)}>
                          <X size={14} aria-hidden="true" /> Cancelar
                        </button>
                      )}
                    </li>
                  );
                })}
                {historicoFiltrado.length === 0 && (
                  <li className="empty">
                    {historico.length === 0
                      ? "Nenhum story ainda. Eles aparecem aqui no horário de cada um, ou quando você usa “Publicar agora”."
                      : "Nenhum story com esse filtro."}
                  </li>
                )}
              </ul>
            </div>
          </div>
        )}
      </div>

      {editor && editorInicial && (
        <StoryEditorModal
          key={`${editor.modo}-${editor.idx}`}
          inicial={editorInicial}
          novo={editor.idx === null}
          accounts={editor.modo === "compartilhado" ? accounts : undefined}
          contaNome={editor.modo === "conta" ? acc?.username : undefined}
          mediaMap={mediaMap}
          folders={folders}
          library={library}
          folderNome={folderNome}
          onSave={(d) => (editor.modo === "compartilhado" ? salvarCompartilhado(editor.idx, d) : salvarConta(editor.idx, d))}
          onClose={() => setEditor(null)}
        />
      )}
      {confirma && (
        <ConfirmDialog
          title={confirma.titulo}
          message={confirma.mensagem}
          confirmLabel={confirma.rotulo}
          cancelLabel="Voltar"
          tone={confirma.tone}
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
