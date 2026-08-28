import { useEffect, useState } from "react";
import { ConfirmDialog, Modal, NameDialog } from "./Dialog";
import {
  bulkSavePhrases,
  createPhrase,
  createPhraseType,
  deletePhrase,
  deletePhraseType,
  generateAI,
  importPhraseType,
  listPhraseTypes,
  listPhrases,
  sharePhraseType,
  type Phrase,
  type PhraseType,
} from "./api";

/* Modal que mostra o código de compartilhamento com botão de copiar. */
function ShareDialog({
  nome,
  slug,
  total,
  onClose,
}: {
  nome: string;
  slug: string;
  total: number;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  async function copiar() {
    try {
      await navigator.clipboard?.writeText(slug);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }
  return (
    <Modal title={`Compartilhar “${nome}”`} onClose={onClose}>
      <p className="modal-text">
        Envie este código para outra pessoa importar as {total} frase(s) deste tipo:
      </p>
      <div className="share-code">
        <code>{slug}</code>
        <button className="btn sm primary" onClick={copiar}>
          {copied ? "✓ Copiado" : "Copiar"}
        </button>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onClose}>
          Fechar
        </button>
      </div>
    </Modal>
  );
}

type Dialog =
  | { kind: "novo" }
  | { kind: "importar" }
  | { kind: "apagar"; tipo: PhraseType }
  | { kind: "share"; nome: string; slug: string; total: number }
  | null;

export default function Phrases() {
  const [types, setTypes] = useState<PhraseType[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [phrases, setPhrases] = useState<Phrase[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);

  const [newPhrase, setNewPhrase] = useState("");

  // IA
  const [aiOpen, setAiOpen] = useState(false);
  const [aiQty, setAiQty] = useState(5);
  const [aiExtra, setAiExtra] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [aiInfo, setAiInfo] = useState<string | null>(null);

  async function loadTypes(selectId?: number) {
    try {
      const t = await listPhraseTypes();
      setTypes(t);
      if (selectId != null) setSelected(selectId);
      else if (selected == null && t.length > 0) setSelected(t[0].id);
    } catch (e) {
      setError(String(e));
    }
  }

  async function loadPhrases(id: number) {
    try {
      setPhrases(await listPhrases(id));
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    loadTypes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selected != null) loadPhrases(selected);
    setSuggestions([]);
    setPicked(new Set());
    setAiInfo(null);
    setAiOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  async function novoTipo(nome: string) {
    setError(null);
    try {
      const t = await createPhraseType(nome.toUpperCase());
      setDialog(null);
      await loadTypes(t.id);
    } catch (e) {
      setError(String(e));
    }
  }

  async function removerTipo(t: PhraseType) {
    try {
      await deletePhraseType(t.id);
      setDialog(null);
      setSelected(null);
      setTypes([]);
      await loadTypes();
    } catch (e) {
      setError(String(e));
    }
  }

  async function compartilhar(t: PhraseType) {
    setError(null);
    try {
      const res = await sharePhraseType(t.id);
      setDialog({ kind: "share", nome: t.nome, slug: res.slug, total: res.total_frases });
    } catch (e) {
      setError(String(e));
    }
  }

  async function importar(slug: string) {
    setError(null);
    try {
      const t = await importPhraseType(slug);
      setDialog(null);
      await loadTypes(t.id);
    } catch (e) {
      setError(String(e));
    }
  }

  async function onAddPhrase() {
    if (!newPhrase.trim() || selected == null) return;
    setError(null);
    try {
      await createPhrase(selected, newPhrase.trim());
      setNewPhrase("");
      await loadPhrases(selected);
    } catch (e) {
      setError(String(e));
    }
  }

  async function onGenerate() {
    if (selected == null) return;
    setAiLoading(true);
    setError(null);
    setAiInfo(null);
    try {
      const res = await generateAI(selected, aiQty, aiExtra || undefined);
      setSuggestions(res.frases);
      setPicked(new Set(res.frases.map((_, i) => i)));
      setAiInfo(`Modelo ${res.modelo} · baseado em ${res.baseado_em} frase(s) suas`);
    } catch (e) {
      setError(String(e));
    } finally {
      setAiLoading(false);
    }
  }

  async function onSavePicked() {
    if (selected == null) return;
    const textos = suggestions.filter((_, i) => picked.has(i));
    if (textos.length === 0) return;
    try {
      await bulkSavePhrases(selected, textos);
      setSuggestions([]);
      setPicked(new Set());
      setAiInfo(null);
      await loadPhrases(selected);
    } catch (e) {
      setError(String(e));
    }
  }

  function togglePick(i: number) {
    const next = new Set(picked);
    next.has(i) ? next.delete(i) : next.add(i);
    setPicked(next);
  }

  const tipoAtual = types.find((t) => t.id === selected);

  return (
    <>
      <p className="sub">
        Frases que aparecem <strong>dentro</strong> do vídeo. Escolha um tipo para gerenciar suas frases.
      </p>

      {/* tipos como chips + ações no hover */}
      <div className="typebar">
        {types.map((t) => (
          <span key={t.id} className={t.id === selected ? "tchip active" : "tchip"}>
            <button className="tchip-name" onClick={() => setSelected(t.id)}>
              {t.nome}
            </button>
            <span className="tchip-acts">
              <button
                className="tchip-act"
                title="Compartilhar / exportar este tipo"
                aria-label={`Compartilhar ${t.nome}`}
                onClick={() => compartilhar(t)}
              >
                🔗
              </button>
              <button
                className="tchip-act danger"
                title="Excluir tipo"
                aria-label={`Excluir ${t.nome}`}
                onClick={() => setDialog({ kind: "apagar", tipo: t })}
              >
                🗑️
              </button>
            </span>
          </span>
        ))}
        <button className="tchip new" onClick={() => setDialog({ kind: "novo" })}>
          ＋ Novo tipo
        </button>
        <button className="tchip new" onClick={() => setDialog({ kind: "importar" })}>
          ⬇ Importar
        </button>
      </div>

      {error && <div className="error">⚠️ {error}</div>}

      {types.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-icon">💬</div>
          <p>Nenhum tipo de frase ainda.</p>
          <button className="btn primary" onClick={() => setDialog({ kind: "novo" })}>
            ＋ Criar primeiro tipo
          </button>
        </div>
      )}

      {selected != null && tipoAtual && (
        <>
          {/* adicionar frase manual */}
          <div className="addbar">
            <input
              className="addbar-input"
              placeholder={`Escreva uma frase de ${tipoAtual.nome} e tecle Enter…`}
              value={newPhrase}
              onChange={(e) => setNewPhrase(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && onAddPhrase()}
            />
            <button className="btn primary" onClick={onAddPhrase} disabled={!newPhrase.trim()}>
              ＋ Frase
            </button>
          </div>

          {/* IA recolhida por padrão */}
          {!aiOpen ? (
            <button className="btn ai-toggle" onClick={() => setAiOpen(true)}>
              🤖 Gerar frases com IA (opcional)
            </button>
          ) : (
            <div className="ai-box">
              <div className="ai-head">
                <span>🤖 Gerar com IA</span>
                <button className="modal-close" aria-label="Fechar" onClick={() => setAiOpen(false)}>
                  ×
                </button>
              </div>
              <div className="ai-controls">
                <label>
                  Qtd:
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={aiQty}
                    onChange={(e) => setAiQty(Number(e.target.value))}
                    style={{ width: 60, marginLeft: 6 }}
                  />
                </label>
                <input
                  placeholder="Instrução extra (opcional)"
                  value={aiExtra}
                  onChange={(e) => setAiExtra(e.target.value)}
                  style={{ flex: 1 }}
                />
                <button className="btn primary" onClick={onGenerate} disabled={aiLoading}>
                  {aiLoading ? "Gerando…" : "Gerar"}
                </button>
              </div>
              {aiInfo && <div className="hint">{aiInfo}</div>}

              {suggestions.length > 0 && (
                <div className="suggestions">
                  {suggestions.map((s, i) => (
                    <label key={i} className={picked.has(i) ? "sugg picked" : "sugg"}>
                      <input type="checkbox" checked={picked.has(i)} onChange={() => togglePick(i)} />
                      {s}
                    </label>
                  ))}
                  <button className="btn primary" onClick={onSavePicked}>
                    Salvar selecionadas ({picked.size})
                  </button>
                </div>
              )}
            </div>
          )}

          {/* lista de frases */}
          <ul className="list">
            {phrases.map((p) => (
              <li key={p.id} className="card">
                <div className="card-main">
                  <strong>{p.texto}</strong>
                  <div className="meta">
                    <span className={p.origem === "ia" ? "badge ia" : "badge"}>{p.origem}</span>
                  </div>
                </div>
                <div className="card-actions">
                  <button
                    className="btn danger sm"
                    onClick={async () => {
                      await deletePhrase(p.id);
                      if (selected != null) await loadPhrases(selected);
                    }}
                  >
                    Excluir
                  </button>
                </div>
              </li>
            ))}
            {phrases.length === 0 && <li className="empty">Nenhuma frase neste tipo ainda.</li>}
          </ul>
        </>
      )}

      {/* ---------- Modais ---------- */}
      {dialog?.kind === "novo" && (
        <NameDialog
          title="Novo tipo de frase"
          initial=""
          confirmLabel="Criar tipo"
          placeholder="Ex.: FLIRT, SARCASMIC…"
          taken={types.map((t) => t.nome)}
          transform={(s) => s.toUpperCase()}
          onConfirm={novoTipo}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "importar" && (
        <NameDialog
          title="Importar tipo de frase"
          initial=""
          confirmLabel="Importar"
          placeholder="Cole o código compartilhado…"
          onConfirm={importar}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "apagar" && (
        <ConfirmDialog
          title="Excluir tipo"
          confirmLabel="Excluir tipo"
          message={
            <>
              Excluir o tipo <strong>{dialog.tipo.nome}</strong> e <strong>todas</strong> as suas
              frases? Esta ação não pode ser desfeita.
            </>
          }
          onConfirm={() => removerTipo(dialog.tipo)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "share" && (
        <ShareDialog
          nome={dialog.nome}
          slug={dialog.slug}
          total={dialog.total}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}
