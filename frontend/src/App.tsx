import { useState } from "react";
import MediaLibrary from "./MediaLibrary";
import Phrases from "./Phrases";
import Create from "./Create";
import History from "./History";

type Section = "midias" | "frases" | "criar" | "historico";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "midias", label: "Mídias" },
  { id: "frases", label: "Frases" },
  { id: "criar", label: "Criar" },
  { id: "historico", label: "Histórico" },
];

export default function App() {
  const [section, setSection] = useState<Section>("midias");

  return (
    <div className="app">
      <header>
        <h1>🎬 Vídeos em Massa</h1>
      </header>

      <nav className="topnav">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            className={section === s.id ? "topbtn active" : "topbtn"}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>

      {section === "midias" && <MediaLibrary />}
      {section === "frases" && <Phrases />}
      {section === "criar" && <Create />}
      {section === "historico" && <History />}
    </div>
  );
}
