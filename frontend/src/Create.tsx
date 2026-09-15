import { useEffect, useRef, useState } from "react";
import {
  bulkGenerate,
  downloadUrl,
  downloadVideoZip,
  getHistory,
  getJob,
  listFolders,
  listFonts,
  listMedia,
  listPhraseTypes,
  videoDownloadUrl,
  type Folder,
  type Font,
  type GeneratedVideo,
  type Job,
  type Media,
  type PhraseType,
} from "./api";

const VIDEO_RE = /\.(mp4|mov|mkv|webm|avi)$/i;

function ItemThumb({ m }: { m: Media }) {
  const src = downloadUrl(m.id);
  const isVideo = m.tipo === "video" || VIDEO_RE.test(m.caminho);
  if (isVideo) return <video className="mini-thumb" src={src} preload="metadata" muted />;
  return <img className="mini-thumb" src={src} alt="" />;
}

// Seletor: uma pasta -> "pasta inteira" ou "escolher itens"
function FolderPicker({
  label,
  folders,
  folderId,
  setFolderId,
  mode,
  setMode,
  items,
  sel,
  toggle,
  setSel,
}: {
  label: string;
  folders: Folder[];
  folderId: number | null;
  setFolderId: (id: number | null) => void;
  mode: "whole" | "items";
  setMode: (m: "whole" | "items") => void;
  items: Media[];
  sel: Set<number>;
  toggle: (id: number) => void;
  setSel: React.Dispatch<React.SetStateAction<Set<number>>>;
}) {
  const selCount = items.filter((m) => sel.has(m.id)).length;
  const chosen = folders.find((f) => f.id === folderId);

  return (
    <div className="picker">
      <div className="picker-label">{label}</div>
      <select
        className="picker-select"
        value={folderId ?? ""}
        onChange={(e) => setFolderId(e.target.value ? Number(e.target.value) : null)}
      >
        <option value="">📁 Escolha uma pasta…</option>
        {folders.map((f) => (
          <option key={f.id} value={f.id}>
            📁 {f.nome}
          </option>
        ))}
      </select>

      {folderId != null && (
        <>
          {/* controle segmentado: usar tudo x escolher a dedo */}
          <div className="seg">
            <button
              type="button"
              className={mode === "whole" ? "seg-btn active" : "seg-btn"}
              onClick={() => setMode("whole")}
            >
              Usar pasta inteira
              <span className="seg-count">{items.length}</span>
            </button>
            <button
              type="button"
              className={mode === "items" ? "seg-btn active" : "seg-btn"}
              onClick={() => setMode("items")}
            >
              Escolher itens
              {mode === "items" && selCount > 0 && <span className="seg-count">{selCount}</span>}
            </button>
          </div>

          {mode === "whole" && (
            <div className="picker-note">
              {items.length > 0
                ? `Todos os ${items.length} itens de ${chosen?.nome ?? "esta pasta"} serão sorteados por vídeo.`
                : "Esta pasta está vazia deste tipo. Envie mídias em Mídias → Pastas."}
            </div>
          )}

          {mode === "items" && (
            <>
              {items.length > 0 && (
                <div className="picker-toolbar">
                  <span>
                    {selCount} de {items.length} selecionada(s)
                  </span>
                  <div className="picker-toolbar-actions">
                    <button
                      type="button"
                      className="linkbtn"
                      onClick={() => setSel(new Set(items.map((m) => m.id)))}
                    >
                      Selecionar todas
                    </button>
                    <button type="button" className="linkbtn" onClick={() => setSel(new Set())}>
                      Limpar
                    </button>
                  </div>
                </div>
              )}
              <div className="checklist items-grid">
                {items.map((m) => (
                  <label key={m.id} className={sel.has(m.id) ? "chk picked" : "chk"}>
                    <input type="checkbox" checked={sel.has(m.id)} onChange={() => toggle(m.id)} />
                    <ItemThumb m={m} />
                    <span className="chk-name">{m.nome_original}</span>
                  </label>
                ))}
                {items.length === 0 && (
                  <div className="picker-note">Pasta vazia deste tipo. Envie mídias em Mídias → Pastas.</div>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

// Card de um tipo de vídeo: checkbox + painel revelado quando marcado.
function TypeCard({
  icon,
  title,
  desc,
  checked,
  onToggle,
  children,
}: {
  icon: string;
  title: string;
  desc: string;
  checked: boolean;
  onToggle: (v: boolean) => void;
  children?: React.ReactNode;
}) {
  return (
    <div className={checked ? "typecard active" : "typecard"}>
      <label className="typecard-head">
        <input type="checkbox" checked={checked} onChange={(e) => onToggle(e.target.checked)} />
        <span className="typecard-title">
          {icon} {title}
        </span>
        <span className="typecard-desc">{desc}</span>
      </label>
      {checked && <div className="typecard-body">{children}</div>}
    </div>
  );
}

// Seletor de tipo de frase (textos) para UM tipo de vídeo.
function PhraseSelect({
  types,
  value,
  onChange,
  required,
}: {
  types: PhraseType[];
  value: number | null;
  onChange: (v: number | null) => void;
  required?: boolean;
}) {
  return (
    <label className="field">
      <span>Textos deste tipo — tipo de frase{required ? " (obrigatório)" : ""}</span>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}>
        <option value="">{required ? "— escolha um tipo de frase —" : "— nenhum (sem texto) —"}</option>
        {types.map((t) => (
          <option key={t.id} value={t.id}>
            {t.nome}
          </option>
        ))}
      </select>
    </label>
  );
}

// Controle de tamanho da fonte (aumentar/diminuir) — usado dentro de cada tipo de vídeo.
const FONT_MIN = 24;
const FONT_MAX = 140;
const FONT_STEP = 4;

function FontSizeControl({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <label className="field">
      <span>Tamanho da fonte do texto: {value}px</span>
      <div className="fontsize-row">
        <button
          type="button"
          className="btn sm"
          onClick={() => onChange(Math.max(FONT_MIN, value - FONT_STEP))}
          disabled={value <= FONT_MIN}
          aria-label="Diminuir fonte"
        >
          A−
        </button>
        <span className="fontsize-value">{value}px</span>
        <button
          type="button"
          className="btn sm"
          onClick={() => onChange(Math.min(FONT_MAX, value + FONT_STEP))}
          disabled={value >= FONT_MAX}
          aria-label="Aumentar fonte"
        >
          A+
        </button>
      </div>
    </label>
  );
}

type Pos = { x: number; y: number };
type Size = { w: number; h: number };

// ---- Distorção de texto estilo "Fisheye" (Instagram Edits, opcional) ----
type FisheyeId = "fisheye" | "curve" | "bulge" | "warp" | "wave" | "stretch";

const FISHEYE_OPTIONS: { id: FisheyeId; label: string }[] = [
  { id: "fisheye", label: "Fisheye" },
  { id: "curve", label: "Curve" },
  { id: "bulge", label: "Bulge" },
  { id: "warp", label: "Warp" },
  { id: "wave", label: "Wave" },
  { id: "stretch", label: "Stretch" },
];

// MESMOS valores do backend (TEXT_FISHEYE_PRESETS em video.py). O preview renderiza
// o texto num canvas e aplica EXATAMENTE as mesmas fórmulas do render/export.
interface FisheyeCfg {
  kx: number; sx: number; sy: number; cy: number; vs: number; vb: number;
  wave: number; wave_cycles: number; wx: number; wx_cycles: number; jitter: number;
}
const FISHEYE_PRESETS: Record<FisheyeId, FisheyeCfg> = {
  fisheye: { kx: 0.28, sx: 1.0, sy: 1.0,  cy: 0.18, vs: 0.0, vb: 0.2,  wave: 0.0, wave_cycles: 1.0, wx: 0.0, wx_cycles: 1.0, jitter: 0.0 },
  curve:   { kx: 0.0,  sx: 1.0, sy: 1.0,  cy: 0.26, vs: 0.0, vb: 0.0,  wave: 0.0, wave_cycles: 1.0, wx: 0.0, wx_cycles: 1.0, jitter: 0.0 },
  bulge:   { kx: 0.18, sx: 1.0, sy: 1.0,  cy: 0.0,  vs: 0.0, vb: 0.35, wave: 0.0, wave_cycles: 1.0, wx: 0.0, wx_cycles: 1.0, jitter: 0.0 },
  warp:    { kx: 0.1,  sx: 1.0, sy: 1.0,  cy: 0.06, vs: 0.0, vb: 0.0,  wave: 0.0, wave_cycles: 1.0, wx: 0.0, wx_cycles: 1.0, jitter: 0.06 },
  wave:    { kx: 0.0,  sx: 1.0, sy: 1.0,  cy: 0.0,  vs: 0.0, vb: 0.0,  wave: 0.16, wave_cycles: 1.6, wx: 0.008, wx_cycles: 1.5, jitter: 0.0 },
  stretch: { kx: 0.0,  sx: 0.62, sy: 1.45, cy: 0.0, vs: 0.0, vb: 0.0, wave: 0.0, wave_cycles: 1.0, wx: 0.0, wx_cycles: 1.0, jitter: 0.0 },
};

// ============ renderizador em canvas (mesma transformação do backend) ============
const SS = 2; // supersampling — igual ao backend (video.py)

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

function scaleCanvas(src: HTMLCanvasElement, w: number, h: number): HTMLCanvasElement {
  const out = makeCanvas(w, h);
  const ctx = out.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, out.width, out.height);
  return out;
}

function downscaleCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const out = makeCanvas(src.width / SS, src.height / SS);
  const ctx = out.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, out.width, out.height);
  return out;
}

function drawTextCanvas(text: string, family: string, sizePx: number): HTMLCanvasElement {
  const probe = makeCanvas(8, 8);
  const pctx = probe.getContext("2d")!;
  pctx.font = `800 ${sizePx}px ${family}`;
  const m = pctx.measureText(text);
  const asc = m.actualBoundingBoxAscent ?? sizePx * 0.95;
  const desc = m.actualBoundingBoxDescent ?? sizePx * 0.25;
  const pad = 4;
  const c = makeCanvas(Math.ceil(m.width) + pad * 2, Math.ceil(asc + desc) + pad * 2);
  const ctx = c.getContext("2d")!;
  ctx.font = `800 ${sizePx}px ${family}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(1, 3 * (sizePx / 64)); // STROKE do backend proporcional ao tamanho
  ctx.strokeStyle = "rgba(0,0,0,0.9)";
  ctx.strokeText(text, pad, pad);
  ctx.fillStyle = "#fff";
  ctx.fillText(text, pad, pad);
  return c;
}

// réplica exata de _apply_fisheye (video.py): remapeamento NÃO-LINEAR por coluna
function fisheyePassCanvas(src: HTMLCanvasElement, cfg: FisheyeCfg): HTMLCanvasElement {
  const w0 = src.width, h0 = src.height;
  const W = Math.max(1, w0 * SS), H = Math.max(1, h0 * SS);
  const big = scaleCanvas(src, W, H);
  const out_w = Math.max(1, Math.round(w0 * cfg.sx * SS));
  const out_h = Math.max(1, Math.round(h0 * cfg.sy * SS));
  const maxVs = 1 + Math.max(cfg.vs, cfg.vb);
  const maxDisp = (Math.abs(cfg.cy) + Math.abs(cfg.wave) + cfg.jitter) * out_h;
  const canvasH = Math.max(1, Math.round(out_h * maxVs)) + 2 * (Math.max(1, Math.round(maxDisp)) + SS);
  const out = makeCanvas(out_w, canvasH);
  const ctx = out.getContext("2d")!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  let walk = 0;
  let seed = 11; // jitter DETERMINÍSTICO (estável entre renders do preview)
  // LCG com mul/inc escolhidos para o produto ficar < 2^53 (exato em double)
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  for (let x = 0; x < out_w; x++) {
    const u = (x / Math.max(1, out_w - 1)) * 2 - 1;
    let us = u * (1 - cfg.kx + cfg.kx * u * u) + cfg.wx * Math.sin(cfg.wx_cycles * Math.PI * u);
    us = Math.max(-1, Math.min(1, us));
    const xs = ((us + 1) / 2) * (W - 1);
    let vscale = 1 - cfg.vs * u * u + cfg.vb * (1 - u * u);
    vscale = Math.max(0.1, Math.min(2, vscale));
    const colH = Math.max(1, Math.round(out_h * vscale));
    let disp = cfg.cy * out_h * u * u + cfg.wave * out_h * Math.sin(cfg.wave_cycles * Math.PI * u);
    if (cfg.jitter) {
      walk = Math.max(-1, Math.min(1, walk + (rnd() * 0.8 - 0.4)));
      disp += walk * cfg.jitter * out_h;
    }
    const yTop = Math.round(canvasH / 2 + disp - colH / 2);
    ctx.drawImage(big, xs, 0, 1, H, x, yTop, 1, colH);
  }
  return downscaleCanvas(out);
}

// Preview da "Distorção de texto": canvas com o MESMO remapeamento do backend
function DistortedTextCanvas({
  text,
  fontCss,
  fontSize,
  fisheye,
}: {
  text: string;
  fontCss: string;
  fontSize: number;
  fisheye: FisheyeId;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [css, setCss] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const sizePx = 13 * (fontSize / 64);
    // Supersampling do texto (2x): os glifos são rasterizados MAIORES e reduzidos
    // no final — mantém o texto nítido após o remapeamento do fisheye (rasterizar
    // no tamanho exibido deixaria os contornos borrados).
    const PREVIEW_SS = 2;
    let cur = drawTextCanvas(text, fontCss, sizePx * PREVIEW_SS);
    cur = fisheyePassCanvas(cur, FISHEYE_PRESETS[fisheye]);
    const cv = ref.current;
    if (cv) {
      // o resultado já está em PREVIEW_SS (2x o tamanho exibido) → backing nítido
      cv.width = cur.width;
      cv.height = cur.height;
      cv.getContext("2d")?.drawImage(cur, 0, 0);
    }
    setCss({ w: Math.round(cur.width / PREVIEW_SS), h: Math.round(cur.height / PREVIEW_SS) });
  }, [text, fontCss, fontSize, fisheye]);

  return <canvas ref={ref} className="dist-canvas" style={{ width: `${css.w}px`, height: `${css.h}px` }} />;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const SNAP = 0.025; // distância (fração) para "grudar" no centro
const CENTERED = 0.004; // tolerância para considerar centralizado

// Empurra o ponto `p` (elemento arrastado, com tamanho `d`) para fora do outro
// elemento (centro `o`, tamanho `os`) pelo eixo de menor penetração — impede overlap.
function avoidOverlap(p: Pos, d: Size, o: Pos, os: Size): Pos {
  const combW = (d.w + os.w) / 2 + 0.008;
  const combH = (d.h + os.h) / 2 + 0.008;
  const dx = p.x - o.x;
  const dy = p.y - o.y;
  const ox = combW - Math.abs(dx);
  const oy = combH - Math.abs(dy);
  if (ox > 0 && oy > 0) {
    if (ox <= oy) return { x: clamp01(o.x + (dx < 0 ? -combW : combW)), y: p.y };
    return { x: p.x, y: clamp01(o.y + (dy < 0 ? -combH : combH)) };
  }
  return p;
}

// Preview 9:16 com elementos arrastáveis (texto e imagem estática).
// Funciona no desktop e no mobile via Pointer Events. As posições são frações 0..1.
// Mostra guias de centralização (com snap) e nunca deixa texto e imagem se sobreporem.
function PreviewCanvas({
  bg,
  sampleText,
  fontCss,
  fontSize,
  hasText,
  textPos,
  setTextPos,
  showOverlay,
  overlayMedia,
  ovPos,
  setOvPos,
  ovScale,
  fisheye,
}: {
  bg: Media | undefined;
  sampleText: string;
  fontCss: string;
  fontSize: number;
  hasText: boolean;
  textPos: Pos;
  setTextPos: (p: Pos) => void;
  showOverlay: boolean;
  overlayMedia: Media | undefined;
  ovPos: Pos;
  setOvPos: (p: Pos) => void;
  ovScale: number;
  fisheye: FisheyeId | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const textElRef = useRef<HTMLDivElement>(null);
  const ovElRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<null | "text" | "overlay">(null);
  const [active, setActive] = useState<null | "text" | "overlay">(null);
  const [ovNat, setOvNat] = useState<Size | null>(null);

  useEffect(() => setOvNat(null), [overlayMedia?.id]);

  // largura da imagem (fração da tela) reproduzindo o backend: cabe na caixa
  // 0.85 x 0.45 preservando o aspecto, ampliando no máximo OVERLAY_SCALE do nativo.
  const BOX_W = 0.85, BOX_H = 0.45, VW = 1080, VH = 1920, OVERLAY_SCALE = 1.75;
  let ovW = 0.55 * ovScale; // fallback enquanto a imagem carrega
  if (ovNat && ovNat.w > 0 && ovNat.h > 0) {
    const nfw = ovNat.w / VW, nfh = ovNat.h / VH;
    const scale = Math.min(BOX_W / nfw, BOX_H / nfh, OVERLAY_SCALE) * ovScale;
    ovW = nfw * scale;
  }

  function sizeFrac(el: HTMLElement | null): Size {
    const c = ref.current;
    if (!el || !c) return { w: 0, h: 0 };
    const cr = c.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    return { w: er.width / cr.width, h: er.height / cr.height };
  }

  // Segurança: se texto e imagem se sobrepuserem SEM estar arrastando (imagem trocou,
  // carregou maior, ou o tipo foi ligado), empurra o texto para fora da imagem.
  useEffect(() => {
    if (!hasText || !showOverlay || dragging.current) return;
    const fixed = avoidOverlap(textPos, sizeFrac(textElRef.current), ovPos, sizeFrac(ovElRef.current));
    if (fixed.x !== textPos.x || fixed.y !== textPos.y) setTextPos(fixed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [textPos, ovPos, ovNat, hasText, showOverlay, ovScale]);

  useEffect(() => {
    function move(e: PointerEvent) {
      if (!dragging.current || !ref.current) return;
      const r = ref.current.getBoundingClientRect();
      let p: Pos = {
        x: clamp01((e.clientX - r.left) / r.width),
        y: clamp01((e.clientY - r.top) / r.height),
      };
      // snap ao centro
      if (Math.abs(p.x - 0.5) < SNAP) p.x = 0.5;
      if (Math.abs(p.y - 0.5) < SNAP) p.y = 0.5;
      // impede sobreposição entre texto e imagem (só quando ambos existem)
      if (hasText && showOverlay) {
        const isText = dragging.current === "text";
        const dSize = sizeFrac(isText ? textElRef.current : ovElRef.current);
        const other = isText ? ovPos : textPos;
        const oSize = sizeFrac(isText ? ovElRef.current : textElRef.current);
        p = avoidOverlap(p, dSize, other, oSize);
      }
      (dragging.current === "text" ? setTextPos : setOvPos)(p);
    }
    function up() {
      dragging.current = null;
      setActive(null);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [hasText, showOverlay, ovPos, textPos, setTextPos, setOvPos]);

  const start = (t: "text" | "overlay") => (e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = t;
    setActive(t);
  };

  const bgSrc = bg ? downloadUrl(bg.id) : null;
  const bgIsVideo = bg && (bg.tipo === "video" || VIDEO_RE.test(bg.caminho));

  // centralização do elemento ativo (para as guias)
  const activePos = active === "text" ? textPos : active === "overlay" ? ovPos : null;
  const cX = !!activePos && Math.abs(activePos.x - 0.5) < CENTERED;
  const cY = !!activePos && Math.abs(activePos.y - 0.5) < CENTERED;
  const centerLabel = cX && cY ? "⊹ centralizado" : cX ? "↕ centro horizontal" : cY ? "↔ centro vertical" : null;

  return (
    <div className="preview">
      <div className="preview-canvas" ref={ref}>
        {bgSrc ? (
          bgIsVideo ? (
            <video className="preview-bg" src={bgSrc} muted playsInline autoPlay loop preload="metadata" />
          ) : (
            <img className="preview-bg" src={bgSrc} alt="" />
          )
        ) : (
          <div className="preview-bg preview-bg-empty">9:16</div>
        )}

        {active && (
          <>
            <div className={cX ? "guide guide-v on" : "guide guide-v"} />
            <div className={cY ? "guide guide-h on" : "guide guide-h"} />
            {centerLabel && <div className="center-badge">{centerLabel}</div>}
          </>
        )}

        {showOverlay && (
          <div
            ref={ovElRef}
            className="drag-el ov"
            style={{ left: `${ovPos.x * 100}%`, top: `${ovPos.y * 100}%`, width: `${ovW * 100}%` }}
            onPointerDown={start("overlay")}
          >
            {overlayMedia ? (
              <img
                src={downloadUrl(overlayMedia.id)}
                alt=""
                draggable={false}
                onLoad={(e) => setOvNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
              />
            ) : (
              <div className="ov-ph">imagem</div>
            )}
          </div>
        )}

        {hasText && (
          <div
            ref={textElRef}
            className={fisheye ? "drag-el txt distorted" : "drag-el txt"}
            style={{ left: `${textPos.x * 100}%`, top: `${textPos.y * 100}%` }}
            onPointerDown={start("text")}
          >
            {fisheye ? (
              <DistortedTextCanvas text={sampleText} fontCss={fontCss} fontSize={fontSize} fisheye={fisheye} />
            ) : (
              <span style={{ fontFamily: fontCss, fontSize: `${13 * (fontSize / 64)}px` }}>{sampleText}</span>
            )}
          </div>
        )}
      </div>
      <div className="preview-hint">
        {hasText || showOverlay
          ? `Arraste ${[hasText && "o texto", showOverlay && "a imagem"].filter(Boolean).join(" e ")} para posicionar. Vale para todo o lote.`
          : "Escolha um tipo de frase (ou a imagem estática) para posicionar aqui."}
      </div>
    </div>
  );
}

export default function Create() {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [musics, setMusics] = useState<Media[]>([]);
  const [types, setTypes] = useState<PhraseType[]>([]);
  const [fonts, setFonts] = useState<Font[]>([]);

  // base (vídeos + fotos de uma pasta)
  const [baseFolderId, setBaseFolderId] = useState<number | null>(null);
  const [baseMode, setBaseMode] = useState<"whole" | "items">("whole");
  const [baseItems, setBaseItems] = useState<Media[]>([]);
  const [baseSel, setBaseSel] = useState<Set<number>>(new Set());

  // ---- tipos de vídeo (marque 1 ou vários) ----
  const [typePause, setTypePause] = useState(false);
  const [typeImagem, setTypeImagem] = useState(false);
  const [typeFinal, setTypeFinal] = useState(false);
  const [typeTexto, setTypeTexto] = useState(false);

  // pool do "pause" (fotos hot)
  const [hotFolderId, setHotFolderId] = useState<number | null>(null);
  const [hotMode, setHotMode] = useState<"whole" | "items">("whole");
  const [hotItems, setHotItems] = useState<Media[]>([]);
  const [hotSel, setHotSel] = useState<Set<number>>(new Set());

  // pool da "imagem estática" (overlay)
  const [ovFolderId, setOvFolderId] = useState<number | null>(null);
  const [ovMode, setOvMode] = useState<"whole" | "items">("whole");
  const [ovItems, setOvItems] = useState<Media[]>([]);
  const [ovSel, setOvSel] = useState<Set<number>>(new Set());

  // posições (centro, fração 0..1) definidas arrastando no preview 9:16
  const [textPos, setTextPos] = useState({ x: 0.5, y: 0.72 });
  const [ovPos, setOvPos] = useState({ x: 0.5, y: 0.22 });
  const [ovScale, setOvScale] = useState(1); // tamanho da imagem estática (multiplicador)

  // pool do "clipe final"
  const [finFolderId, setFinFolderId] = useState<number | null>(null);
  const [finMode, setFinMode] = useState<"whole" | "items">("whole");
  const [finItems, setFinItems] = useState<Media[]>([]);
  const [finSel, setFinSel] = useState<Set<number>>(new Set());

  const [musicSel, setMusicSel] = useState<Set<number>>(new Set());
  const [quantidade, setQuantidade] = useState(5);
  const [durMin, setDurMin] = useState(5);
  const [durMax, setDurMax] = useState(8);
  // tipo de frase POR tipo de vídeo (cada tipo tem seus próprios textos)
  const [ptPause, setPtPause] = useState<number | null>(null);
  const [ptImagem, setPtImagem] = useState<number | null>(null);
  const [ptFinal, setPtFinal] = useState<number | null>(null);
  const [ptTexto, setPtTexto] = useState<number | null>(null);
  const [fontId, setFontId] = useState<string | null>(null);
  // tamanho da fonte (px) POR tipo de vídeo
  const [fsPause, setFsPause] = useState(64);
  const [fsImagem, setFsImagem] = useState(64);
  const [fsFinal, setFsFinal] = useState(64);
  const [fsTexto, setFsTexto] = useState(64);
  const [useIaTexto, setUseIaTexto] = useState(false);
  const [legendaIa, setLegendaIa] = useState(false);
  // Distorção de texto estilo "Fisheye" (Instagram Edits, opcional)
  const [fisheyeOn, setFisheyeOn] = useState(false);
  const [fisheyePreset, setFisheyePreset] = useState<FisheyeId>("fisheye");

  const [job, setJob] = useState<Job | null>(null);
  const [results, setResults] = useState<GeneratedVideo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [fs, m, t, fo] = await Promise.all([listFolders(), listMedia("music"), listPhraseTypes(), listFonts()]);
        setFolders(fs);
        setMusics(m);
        setTypes(t);
        setFonts(fo);
        if (fo.length > 0) setFontId(fo[0].id);
      } catch (e) {
        setError(String(e));
      }
    })();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // carrega itens da pasta base (vídeos + fotos)
  useEffect(() => {
    setBaseSel(new Set());
    if (baseFolderId == null) return setBaseItems([]);
    Promise.all([listMedia("video", baseFolderId), listMedia("photo", baseFolderId)])
      .then(([v, p]) => setBaseItems([...v, ...p]))
      .catch((e) => setError(String(e)));
  }, [baseFolderId]);

  // pools dos tipos de vídeo
  useEffect(() => {
    setHotSel(new Set());
    if (hotFolderId == null) return setHotItems([]);
    listMedia("photo_hot", hotFolderId).then(setHotItems).catch((e) => setError(String(e)));
  }, [hotFolderId]);

  useEffect(() => {
    setOvSel(new Set());
    if (ovFolderId == null) return setOvItems([]);
    listMedia("overlay", ovFolderId).then(setOvItems).catch((e) => setError(String(e)));
  }, [ovFolderId]);

  useEffect(() => {
    setFinSel(new Set());
    if (finFolderId == null) return setFinItems([]);
    listMedia("final_clip", finFolderId).then(setFinItems).catch((e) => setError(String(e)));
  }, [finFolderId]);

  function toggler(setter: React.Dispatch<React.SetStateAction<Set<number>>>) {
    return (id: number) =>
      setter((prev) => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
      });
  }

  const resolveIds = (mode: "whole" | "items", items: Media[], sel: Set<number>) =>
    mode === "whole" ? items.map((m) => m.id) : [...sel];

  async function onGenerate() {
    setError(null);
    const baseIds = resolveIds(baseMode, baseItems, baseSel);
    if (baseIds.length === 0) return setError("Escolha uma pasta base (ou itens dela) com vídeos/fotos.");

    const hotIds = typePause ? resolveIds(hotMode, hotItems, hotSel) : [];
    const ovIds = typeImagem ? resolveIds(ovMode, ovItems, ovSel) : [];
    const finIds = typeFinal ? resolveIds(finMode, finItems, finSel) : [];

    if (typePause && hotIds.length === 0) return setError('Desafio do pause: escolha fotos hot (pasta ou itens).');
    if (typeImagem && ovIds.length === 0) return setError('Imagem estática: escolha as imagens (pasta ou itens).');
    if (typeImagem && ptImagem == null) return setError('Imagem estática exige um tipo de frase (escolha os textos dentro do tipo).');
    if (typeFinal && finIds.length === 0) return setError('Clipe final: escolha os clipes (pasta ou itens).');
    if (typeTexto && ptTexto == null) return setError('Apenas texto exige um tipo de frase (escolha os textos).');

    // tipo de frase por tipo de vídeo (só dos tipos habilitados)
    const text_types: Record<string, number | null> = {};
    if (typePause) text_types.pause = ptPause;
    if (typeImagem) text_types.imagem = ptImagem;
    if (typeFinal) text_types.final = ptFinal;
    if (typeTexto) text_types.texto = ptTexto;

    if (
      useIaTexto &&
      !(typePause && ptPause) &&
      !(typeImagem && ptImagem) &&
      !(typeFinal && ptFinal) &&
      !(typeTexto && ptTexto)
    )
      return setError("Para a IA de texto, escolha um tipo de frase em algum tipo de vídeo.");

    // tamanho da fonte por tipo de vídeo (só dos tipos habilitados)
    const font_sizes: Record<string, number> = {};
    if (typePause) font_sizes.pause = fsPause;
    if (typeImagem) font_sizes.imagem = fsImagem;
    if (typeFinal) font_sizes.final = fsFinal;
    if (typeTexto) font_sizes.texto = fsTexto;

    const video_types = [
      ...(typePause ? (["pause"] as const) : []),
      ...(typeImagem ? (["imagem"] as const) : []),
      ...(typeFinal ? (["final"] as const) : []),
      ...(typeTexto ? (["texto"] as const) : []),
    ];

    setResults([]);
    try {
      const j = await bulkGenerate({
        quantidade,
        base_media_ids: baseIds,
        music_media_ids: [...musicSel],
        phrase_type_id: null,
        text_types,
        use_ia_texto: useIaTexto,
        gerar_legenda_ia: legendaIa,
        duration_min: Math.min(durMin, durMax),
        duration_max: Math.max(durMin, durMax),
        video_types: [...video_types],
        hot_media_ids: hotIds,
        overlay_media_ids: ovIds,
        final_media_ids: finIds,
        font_id: fontId,
        font_sizes,
        text_x: textPos.x,
        text_y: textPos.y,
        overlay_x: ovPos.x,
        overlay_y: ovPos.y,
        overlay_scale: ovScale,
        text_fisheye: fisheyeOn ? fisheyePreset : null,
      });
      setJob(j);
      startPolling(j.id);
    } catch (e) {
      setError(String(e));
    }
  }

  function startPolling(jobId: number) {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = window.setInterval(async () => {
      try {
        const j = await getJob(jobId);
        setJob(j);
        if (j.status === "concluido" || j.status === "erro") {
          if (pollRef.current) clearInterval(pollRef.current);
          setResults(await getHistory(jobId));
        }
      } catch {
        /* ignora */
      }
    }, 1000);
  }

  async function baixarTodos() {
    // dispara um download por vídeo; o navegador pede "permitir vários" só uma vez
    for (const v of results) {
      const a = document.createElement("a");
      a.href = videoDownloadUrl(v.id);
      a.download = `video_${v.id}.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  const running = job && (job.status === "fila" || job.status === "processando");

  if (folders.length === 0) {
    return (
      <div className="empty">
        Você ainda não tem pastas. Vá em <strong>Mídias → Pastas</strong>, crie uma pasta e envie vídeos/fotos.
      </div>
    );
  }

  const TIPO_BADGE: Record<string, string> = { pause: "⏸️ pause", imagem: "🏷️ imagem", final: "🎞️ final", texto: "🔤 texto" };

  const pickFirst = (mode: "whole" | "items", items: Media[], sel: Set<number>) =>
    mode === "whole" ? items[0] : items.find((m) => sel.has(m.id));
  const bgMedia = pickFirst(baseMode, baseItems, baseSel);
  const ovMedia = pickFirst(ovMode, ovItems, ovSel);
  const sampleText = "Seu texto aparece aqui";
  const selectedFontCss = fonts.find((f) => f.id === fontId)?.css || "inherit";
  // tamanho da fonte do tipo ativo (o primeiro habilitado com texto) para refletir no preview
  const activeFontSize =
    (typePause && ptPause != null) ? fsPause :
    (typeImagem && ptImagem != null) ? fsImagem :
    (typeFinal && ptFinal != null) ? fsFinal :
    (typeTexto && ptTexto != null) ? fsTexto :
    64;

  return (
    <>
      <p className="sub">Gere vários vídeos de uma vez. Escolha uma pasta (inteira ou itens dela) como base.</p>
      {error && <div className="error">⚠️ {error}</div>}

      <div className="create-layout">
        <PreviewCanvas
          bg={bgMedia}
          sampleText={sampleText}
          fontCss={selectedFontCss}
          fontSize={activeFontSize}
          hasText={
            (typePause && ptPause != null) ||
            (typeImagem && ptImagem != null) ||
            (typeFinal && ptFinal != null) ||
            (typeTexto && ptTexto != null)
          }
          textPos={textPos}
          setTextPos={setTextPos}
          showOverlay={typeImagem}
          overlayMedia={ovMedia}
          ovPos={ovPos}
          setOvPos={setOvPos}
          ovScale={ovScale}
          fisheye={fisheyeOn ? fisheyePreset : null}
        />

      <div className="form create-form-col">
        <FolderPicker
          label="Base — vídeos e fotos (sorteados por vídeo)"
          folders={folders}
          folderId={baseFolderId}
          setFolderId={setBaseFolderId}
          mode={baseMode}
          setMode={setBaseMode}
          items={baseItems}
          sel={baseSel}
          toggle={toggler(setBaseSel)}
          setSel={setBaseSel}
        />

        <label className="field">
          <span>Músicas (universais, sorteadas por vídeo)</span>
          <div className="checklist">
            {musics.map((m) => (
              <label key={m.id} className={musicSel.has(m.id) ? "chk picked" : "chk"}>
                <input type="checkbox" checked={musicSel.has(m.id)} onChange={() => toggler(setMusicSel)(m.id)} />
                <span className="chk-name">🎵 {m.nome_original}</span>
              </label>
            ))}
            {musics.length === 0 && <div className="hint">Nenhuma música. Envie em Mídias → Músicas.</div>}
          </div>
        </label>

        <label className="field">
          <span>Fonte do texto</span>
          <select
            value={fontId ?? ""}
            onChange={(e) => setFontId(e.target.value || null)}
            style={{ fontFamily: selectedFontCss, fontWeight: 700 }}
          >
            {fonts.length === 0 && <option value="">— padrão —</option>}
            {fonts.map((f) => (
              <option key={f.id} value={f.id} style={{ fontFamily: f.css, fontWeight: 700 }}>
                {f.nome}
              </option>
            ))}
          </select>
          <div className="hint">Para adicionar fontes (ex.: um .ttf que você tenha), solte o arquivo em <code>storage/fonts</code>.</div>
        </label>

        <div className="field">
          <label className="checkrow">
            <input type="checkbox" checked={fisheyeOn} onChange={(e) => setFisheyeOn(e.target.checked)} />
            <span>Distorção de texto (Fisheye)</span>
          </label>
          {fisheyeOn && (
            <label className="field">
              <span>Preset de distorção</span>
              <select value={fisheyePreset} onChange={(e) => setFisheyePreset(e.target.value as FisheyeId)}>
                {FISHEYE_OPTIONS.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
              <div className="hint">
                Deformação não-linear do texto renderizado (estilo Instagram Edits): o centro fica expandido e
                as pontas comprimidas/curvadas. O preview mostra exatamente a mesma transformação do vídeo.
              </div>
            </label>
          )}
        </div>

        <label className="field checkrow">
          <input type="checkbox" checked={useIaTexto} onChange={(e) => setUseIaTexto(e.target.checked)} />
          <span>Deixar a IA gerar os textos do vídeo (baseada na sua lista)</span>
        </label>
        <label className="field checkrow">
          <input type="checkbox" checked={legendaIa} onChange={(e) => setLegendaIa(e.target.checked)} />
          <span>Gerar legenda da postagem com IA (opcional)</span>
        </label>

        {/* ---------- Tipos de vídeo ---------- */}
        <div className="field">
          <span>Tipos de vídeo — marque 1 ou vários (sorteado por vídeo no lote)</span>
          <div className="typecards">
            <TypeCard
              icon="⏸️"
              title="Desafio do pause"
              desc="Flash subliminar (~0,1s) de uma foto hot no meio do vídeo."
              checked={typePause}
              onToggle={setTypePause}
            >
              <FolderPicker
                label="Fotos hot (sorteadas por vídeo)"
                folders={folders}
                folderId={hotFolderId}
                setFolderId={setHotFolderId}
                mode={hotMode}
                setMode={setHotMode}
                items={hotItems}
                sel={hotSel}
                toggle={toggler(setHotSel)}
                setSel={setHotSel}
              />
              <PhraseSelect types={types} value={ptPause} onChange={setPtPause} />
              <FontSizeControl value={fsPause} onChange={setFsPause} />
            </TypeCard>

            <TypeCard
              icon="🏷️"
              title="Imagem estática"
              desc="Uma imagem fixa no topo ou embaixo, acima do texto. Exige textos."
              checked={typeImagem}
              onToggle={setTypeImagem}
            >
              <div className="hint">👉 Arraste a imagem no preview ao lado para escolher onde ela aparece.</div>
              <label className="field">
                <span>Tamanho da imagem: {Math.round(ovScale * 100)}%</span>
                <input
                  type="range"
                  min={0.3}
                  max={2.5}
                  step={0.05}
                  value={ovScale}
                  onChange={(e) => setOvScale(Number(e.target.value))}
                />
              </label>
              <FolderPicker
                label="Imagens estáticas (sorteadas por vídeo)"
                folders={folders}
                folderId={ovFolderId}
                setFolderId={setOvFolderId}
                mode={ovMode}
                setMode={setOvMode}
                items={ovItems}
                sel={ovSel}
                toggle={toggler(setOvSel)}
                setSel={setOvSel}
              />
              <PhraseSelect types={types} value={ptImagem} onChange={setPtImagem} required />
              <FontSizeControl value={fsImagem} onChange={setFsImagem} />
            </TypeCard>

            <TypeCard
              icon="🎞️"
              title="Clipe final"
              desc="Um vídeo/foto extra no fim do vídeo, com o mesmo texto."
              checked={typeFinal}
              onToggle={setTypeFinal}
            >
              <FolderPicker
                label="Clipes finais — vídeos ou fotos (sorteados por vídeo)"
                folders={folders}
                folderId={finFolderId}
                setFolderId={setFinFolderId}
                mode={finMode}
                setMode={setFinMode}
                items={finItems}
                sel={finSel}
                toggle={toggler(setFinSel)}
                setSel={setFinSel}
              />
              <PhraseSelect types={types} value={ptFinal} onChange={setPtFinal} />
              <FontSizeControl value={fsFinal} onChange={setFsFinal} />
            </TypeCard>

            <TypeCard
              icon="🔤"
              title="Apenas texto"
              desc="Só o vídeo base com o texto por cima — sem foto hot, imagem ou clipe. Exige textos."
              checked={typeTexto}
              onToggle={setTypeTexto}
            >
              <PhraseSelect types={types} value={ptTexto} onChange={setPtTexto} required />
              <FontSizeControl value={fsTexto} onChange={setFsTexto} />
            </TypeCard>
          </div>
        </div>

        <label className="field">
          <span>Quantidade de vídeos: {quantidade}</span>
          <input type="range" min={1} max={50} value={quantidade} onChange={(e) => setQuantidade(Number(e.target.value))} />
        </label>

        <div className="field">
          <span>
            Duração (sorteada): <strong>{Math.min(durMin, durMax)}–{Math.max(durMin, durMax)}s</strong>
          </span>
          <div className="range-row">
            <label>
              mín
              <input type="number" min={1} max={60} value={durMin} onChange={(e) => setDurMin(Number(e.target.value))} />
            </label>
            <label>
              máx
              <input type="number" min={1} max={60} value={durMax} onChange={(e) => setDurMax(Number(e.target.value))} />
            </label>
          </div>
        </div>

        <button className="btn primary big" onClick={onGenerate} disabled={!!running}>
          {running ? "Gerando…" : `🎬 Gerar ${quantidade} vídeos`}
        </button>
      </div>
      </div>

      {job && (
        <div className="progress-box">
          <div>
            Lote #{job.id} — <strong>{job.status}</strong> · {job.concluidos}/{job.total}
          </div>
          <div className="bar">
            <div className="bar-fill" style={{ width: `${(job.concluidos / job.total) * 100}%` }} />
          </div>
          {job.erro && <div className="hint">⚠️ {job.erro}</div>}
        </div>
      )}

      {results.length > 0 && (
        <div className="results-head">
          <strong>{results.length} vídeo(s) gerado(s)</strong>
          <button className="btn primary" onClick={baixarTodos}>
            ⬇️ Baixar todos ({results.length})
          </button>
          <button className="btn" onClick={() => downloadVideoZip(results.map((v) => v.id))}>
            🗜️ ZIP ({results.length})
          </button>
        </div>
      )}

      {results.length > 0 && (
        <ul className="grid">
          {results.map((v) => (
            <li key={v.id} className="vcard">
              <video src={videoDownloadUrl(v.id)} controls />
              <div className="vmeta">
                {v.texto && <div className="vtext">“{v.texto}”</div>}
                {v.tipo_video && <span className="badge">{TIPO_BADGE[v.tipo_video] ?? v.tipo_video}</span>}
                {v.legenda && <div className="vlegenda">📝 {v.legenda}</div>}
                <a href={videoDownloadUrl(v.id)} download className="btn sm">
                  Baixar .mp4
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
