import { useEffect, useState } from "react";
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

export default function Phrases() {
  const [types, setTypes] = useState<PhraseType[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [phrases, setPhrases] = useState<Phrase[]>([]);
  const [error, setError] = useState<string | null>(null);

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

  async function novoTipo() {
    const nome = window.prompt("Nome do novo tipo de frase (ex.: FLIRT, SARCASMIC):");
    if (!nome?.trim()) return;
    setError(null);
    try {
      const t = await createPhraseType(nome.trim().toUpperCase());
      await loadTypes(t.id);
    } catch (e) {
      setError(String(e));
    }
  }

  async function removerTipo(t: PhraseType) {
    if (!window.confirm(`Excluir o tipo "${t.nome}" e todas as suas frases?`)) return;
    await deletePhraseType(t.id);
    setSelected(null);
    setTypes([]);
    await loadTypes();
  }

  async function compartilhar(t: PhraseType) {
    setError(null);
    try {
      const res = await sharePhraseType(t.id);
      await navigator.clipboard?.writeText(res.slug).catch(() => {});
      window.prompt(
        `Código para compartilhar o tipo "${t.nome}" (${res.total_frases} frase(s)).\n` +
          `Copiado! Envie este código para o outro usuário importar:`,
        res.slug
      );
    } catch (e) {
      setError(String(e));
    }
  }

  async function importar() {
    const slug = window.prompt("Cole o código do tipo de frase compartilhado:");
    if (!slug?.trim()) return;
    setError(null);
    try {
      const t = await importPhraseType(slug.trim());
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

      {/* tipos como chips + botão de criar */}
      <div className="folderbar">
        {types.map((t) => (
          <span key={t.id} className={t.id === selected ? "fchip active" : "fchip"}>
            <button className="fchip-name" onClick={() => setSelected(t.id)}>
              {t.nome}
            </button>
            <button className="fchip-share" title="Compartilhar / exportar este tipo" onClick={() => compartilhar(t)}>
              🔗 Compartilhar
            </button>
            <button className="fchip-x" title="Excluir tipo" onClick={() => removerTipo(t)}>
              ×
            </button>
          </span>
        ))}
        <button className="fchip new" onClick={novoTipo}>
          + Novo tipo
        </button>
        <button className="fchip new" onClick={importar}>
          ⬇ Importar
        </button>
      </div>

      {error && <div className="error">⚠️ {error}</div>}

      {types.length === 0 && (
        <div className="empty">Crie um tipo de frase para começar (botão “+ Novo tipo”).</div>
      )}

      {selected != null && tipoAtual && (
        <>
          {/* adicionar frase manual */}
          <div className="uploader" style={{ flexDirection: "row", alignItems: "center" }}>
            <input
              placeholder={`Escreva uma frase de ${tipoAtual.nome} e tecle Enter…`}
              value={newPhrase}
              onChange={(e) => setNewPhrase(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && onAddPhrase()}
              style={{ flex: 1 }}
            />
            <button className="btn" onClick={onAddPhrase}>
              + Frase
            </button>
          </div>

          {/* IA recolhida por padrão */}
          {!aiOpen ? (
            <button className="btn" style={{ marginBottom: 16 }} onClick={() => setAiOpen(true)}>
              🤖 Gerar frases com IA (opcional)
            </button>
          ) : (
            <div className="ai-box">
              <div className="ai-head">
                🤖 Gerar com IA <button className="fchip-x" onClick={() => setAiOpen(false)}>×</button>
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
    </>
  );
}
