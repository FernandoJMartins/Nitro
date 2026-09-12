import { useEffect, useRef, useState } from "react";

/* ---------- Modal genérico (substitui prompt/confirm nativos) ---------- */
export function Modal({
  title,
  children,
  onClose,
  wide,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className={wide ? "modal wide" : "modal"} role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="modal-close" aria-label="Fechar" onClick={onClose}>
            ×
          </button>
        </div>
        {children}
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
