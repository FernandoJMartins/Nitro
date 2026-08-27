import { useState } from "react";
import Upscale from "./Upscale";

type UtilId = "upscale";

// Lista de utilitários. Cresce aqui conforme novos forem adicionados.
const UTILS: { id: UtilId; icon: string; nome: string; desc: string }[] = [
  {
    id: "upscale",
    icon: "🔍",
    nome: "Upscaling de imagens",
    desc: "Amplie imagens em massa 2x ou 4x. Envie direto ou escolha a pasta de uma modelo.",
  },
];

export default function Utils() {
  const [aberto, setAberto] = useState<UtilId | null>(null);

  if (aberto === "upscale") {
    return (
      <>
        <div className="folder-head">
          <button className="btn sm" onClick={() => setAberto(null)}>
            ← Utilitários
          </button>
          <h2>🔍 Upscaling de imagens</h2>
        </div>
        <Upscale />
      </>
    );
  }

  return (
    <>
      <p className="sub">Ferramentas extras para o seu fluxo de trabalho.</p>
      <div className="folder-grid">
        {UTILS.map((u) => (
          <button key={u.id} className="folder-card" onClick={() => setAberto(u.id)}>
            <div className="folder-icon">{u.icon}</div>
            <div className="folder-name">{u.nome}</div>
          </button>
        ))}
      </div>
    </>
  );
}
