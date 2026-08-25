import { useEffect, useState } from "react";
import {
  bulkSavePhrases,
  createPhrase,
  createPhraseType,
  deletePhrase,
  deletePhraseType,
  generateAI,
  listPhraseTypes,
  listPhrases,
  type Phrase,
  type PhraseType,
} from "./api";

export default function Phrases() {
  const [types, setTypes] = useState<PhraseType[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [phrases, setPhrases] = useState<Phrase[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [newType, setNewType] = useState("");
  const [newPhrase, setNewPhrase] = useState("");

  // IA
  const [aiQty, setAiQty] = useState(5);
  const [aiExtra, setAiExtra] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [aiInfo, setAiInfo] = useState<string | null>(null);

  async function loadTypes() {
    try {
      const t = await listPhraseTypes();
      setTypes(t);
      if (selected == null && t.length > 0) setSelected(t[0].id);
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
  }, [selected]);

  async function onAddType() {
    if (!newType.trim()) return;
    setError(null);
    try {
      const t = await createPhraseType(newType.trim().toUpperCase());
      setNewType("");
      await loadTypes();
      setSelected(t.id);
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
      setPicked(new Set(res.frases.map((_, i) => i))); // todas marcadas por padrão
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

  return (
    <>
      <p className="sub">
        Frases que aparecem <strong>dentro</strong> do vídeo. A IA gera novas baseada nas suas.
      </p>

      {/* tipos */}
      <div className="row">
        <div className="tabs" style={{ flexWrap: "wrap" }}>
          {types.map((t) => (
            <button
              key={t.id}
              className={t.id === selected ? "tab active" : "tab"}
              onClick={() => setSelected(t.id)}
            >
              {t.nome}
            </button>
          ))}
        </div>
      </div>

      <div className="uploader" style={{ flexDirection: "row", alignItems: "center" }}>
        <input
          placeholder="Novo tipo (ex.: FLIRT, SARCASMIC)"
          value={newType}
          onChange={(e) => setNewType(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onAddType()}
        />
        <button className="btn" onClick={onAddType}>
          + Tipo
        </button>
        {selected != null && (
          <button
            className="btn danger"
            onClick={async () => {
              if (confirm("Excluir este tipo e todas as suas frases?")) {
                await deletePhraseType(selected);
                setSelected(null);
                await loadTypes();
              }
            }}
          >
            Excluir tipo
          </button>
        )}
      </div>

      {error && <div className="error">⚠️ {error}</div>}

      {selected != null && (
        <>
          {/* adicionar frase manual */}
          <div className="uploader" style={{ flexDirection: "row", alignItems: "center" }}>
            <input
              placeholder="Escreva uma frase e Enter…"
              value={newPhrase}
              onChange={(e) => setNewPhrase(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && onAddPhrase()}
              style={{ flex: 1 }}
            />
            <button className="btn" onClick={onAddPhrase}>
              + Frase
            </button>
          </div>

          {/* gerador IA */}
          <div className="ai-box">
            <div className="ai-head">🤖 Gerar com IA (opcional)</div>
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
                    className="btn danger"
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

      {types.length === 0 && <div className="empty">Crie um tipo de frase para começar.</div>}
    </>
  );
}
