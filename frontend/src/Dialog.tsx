import { useEffect, useRef, useState, type ReactNode } from "react";

/* ---------- Modal genérico (substitui prompt/confirm nativos) ---------- */
export function Modal({
  title,
  children,
  onClose,
  wide,
  scroll,
  top,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
  scroll?: boolean;
  /** Modal aberto por cima de outro modal (ex.: biblioteca sobre o editor de story) — precisa de z-index bem maior. */
  top?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const cls = `modal${wide ? " wide" : ""}${scroll ? " scroll" : ""}`;
  return (
    <div className={`modal-backdrop${top ? " modal-backdrop--top" : ""}`} onMouseDown={onClose}>
      <div className={cls} role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="modal-close" aria-label="Fechar" onClick={onClose}>
            ×
          </button>
        </div>
        {scroll ? <div className="modal-body">{children}</div> : children}
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
  onConfirm,
  onClose,
}: {
  title: string;
  message: React.ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose}>
      <p className="modal-text">{message}</p>
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          Cancelar
        </button>
        <button type="button" className="btn danger" onClick={onConfirm}>
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
