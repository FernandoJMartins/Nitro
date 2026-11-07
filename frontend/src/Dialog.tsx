import { useEffect, useRef, useState, type ReactNode } from "react";

/* ---------- Modal genérico (substitui prompt/confirm nativos) ---------- */

// Pilha de modais abertos: o Esc fecha SÓ o modal do topo (ex.: biblioteca aberta
// sobre o editor de story) — antes cada modal ouvia o Esc e fechava todos juntos.
const modalStack: number[] = [];
let nextModalId = 1;

export function Modal({
  title,
  children,
  onClose,
  wide,
  scroll,
  top,
  footer,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
  scroll?: boolean;
  /** Modal aberto por cima de outro modal (ex.: biblioteca sobre o editor de story) — precisa de z-index bem maior. */
  top?: boolean;
  /** Rodapé FIXO (fora da área que rola) — os botões de ação ficam sempre visíveis. */
  footer?: React.ReactNode;
}) {
  const [id] = useState(() => nextModalId++);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    modalStack.push(id);
    const anterior = document.activeElement as HTMLElement | null;
    boxRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && modalStack[modalStack.length - 1] === id) {
        e.stopImmediatePropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const i = modalStack.indexOf(id);
      if (i >= 0) modalStack.splice(i, 1);
      anterior?.focus?.();
    };
  }, [id]);

  const cls = `modal${wide ? " wide" : ""}${scroll ? " scroll" : ""}`;
  const titleId = `modal-title-${id}`;
  return (
    <div className={`modal-backdrop${top ? " modal-backdrop--top" : ""}`} onMouseDown={onClose}>
      <div
        ref={boxRef}
        tabIndex={-1}
        className={cls}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h3 id={titleId}>{title}</h3>
          <button className="modal-close" aria-label="Fechar" title="Fechar" onClick={onClose}>
            ×
          </button>
        </div>
        {scroll ? <div className="modal-body">{children}</div> : children}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/* Modal de texto: cria/renomeia com Enter para confirmar. */
export function NameDialog({
  title,
  initial,
  confirmLabel,
  placeholder,
  taken,
  transform,
  onConfirm,
  onClose,
}: {
  title: string;
  initial: string;
  confirmLabel: string;
  placeholder?: string;
  taken?: string[];
  transform?: (raw: string) => string;
  onConfirm: (nome: string) => void;
  onClose: () => void;
}) {
  const [nome, setNome] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const limpo = transform ? transform(nome.trim()) : nome.trim();
  const duplicado =
    limpo.length > 0 &&
    limpo !== initial &&
    (taken ?? []).some((t) => t.toLowerCase() === limpo.toLowerCase());
  const podeSalvar = limpo.length > 0 && !duplicado;

  return (
    <Modal title={title} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (podeSalvar) onConfirm(limpo);
        }}
      >
        <input
          ref={ref}
          className="modal-input"
          value={nome}
          maxLength={80}
          placeholder={placeholder}
          onChange={(e) => setNome(e.target.value)}
        />
        {duplicado && <div className="modal-warn">Já existe um item com esse nome.</div>}
        <div className="modal-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn primary" disabled={!podeSalvar}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* Modal de confirmação (ações destrutivas). */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel = "Cancelar",
  tone = "danger",
  onConfirm,
  onClose,
}: {
  title: string;
  message: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** "danger" (vermelho) só para ações destrutivas; "primary" (azul) para as demais. */
  tone?: "danger" | "primary";
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <p className="modal-text">{message}</p>
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          {cancelLabel}
        </button>
        <button type="button" className={`btn ${tone}`} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

/* Menu de ações "⋯" (overflow) — esconde ações secundárias de uma linha/card,
 * abre em popover com z-index bem acima do resto da página. */
export function DropdownMenu({
  trigger,
  children,
  align = "right",
}: {
  trigger: (opts: { toggle: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="menu-wrap" ref={ref}>
      {trigger({ toggle: () => setOpen((o) => !o) })}
      {open && <div className={`menu-dropdown menu-${align}`}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

export function MenuItem({
  children,
  onClick,
  danger,
  disabled,
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button type="button" className={`menu-item${danger ? " danger" : ""}`} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  );
}

/** Texto de erro amigável: tira o "Error:" do começo e traduz falhas de rede. */
export function erroMsg(e: unknown): string {
  const t = String(e instanceof Error ? e.message : e).replace(/^(Type)?Error:\s*/, "");
  if (/failed to fetch|networkerror|load failed/i.test(t))
    return "Sem conexão com o servidor. Confira a internet e tente de novo.";
  return t;
}

/* Faixa de erro padrão: mesmo visual em todas as telas, com botão de fechar
 * e anunciada por leitores de tela (role="alert"). */
export function ErrorBanner({ error, onClose }: { error: unknown; onClose?: () => void }) {
  if (!error) return null;
  return (
    <div className="error" role="alert">
      <span className="error-icon" aria-hidden="true">
        ⚠️
      </span>{" "}
      {erroMsg(error)}
      {onClose && (
        <button type="button" className="error-x" aria-label="Fechar aviso de erro" title="Fechar" onClick={onClose}>
          ×
        </button>
      )}
    </div>
  );
}

/* ---------- confirmar(): substitui o window.confirm nativo ----------
 * `if (await confirmar({...}))` abre o MESMO diálogo do app (visual, botões e
 * Esc iguais em todas as telas). O <ConfirmHost/> fica montado uma vez no App. */
interface ConfirmReq {
  title: string;
  message: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "danger" | "primary";
  resolve: (ok: boolean) => void;
}
let pushConfirm: ((r: ConfirmReq) => void) | null = null;

export function confirmar(opts: Omit<ConfirmReq, "resolve">): Promise<boolean> {
  if (!pushConfirm) return Promise.resolve(window.confirm(String(opts.message)));
  return new Promise((resolve) => pushConfirm!({ ...opts, resolve }));
}

export function ConfirmHost() {
  const [req, setReq] = useState<ConfirmReq | null>(null);
  useEffect(() => {
    pushConfirm = setReq;
    return () => {
      pushConfirm = null;
    };
  }, []);
  if (!req) return null;
  const fechar = (ok: boolean) => {
    req.resolve(ok);
    setReq(null);
  };
  return (
    <ConfirmDialog
      title={req.title}
      message={req.message}
      confirmLabel={req.confirmLabel}
      cancelLabel={req.cancelLabel}
      tone={req.tone}
      onConfirm={() => fechar(true)}
      onClose={() => fechar(false)}
    />
  );
}
