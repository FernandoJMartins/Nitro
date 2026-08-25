import { useEffect, useState } from "react";
import { clearToken, getToken } from "./api";
import Auth from "./Auth";
import MediaLibrary from "./MediaLibrary";
import Phrases from "./Phrases";
import Create from "./Create";
import History from "./History";
import ApiKeys from "./ApiKeys";

type Section = "midias" | "frases" | "criar" | "historico" | "api";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "midias", label: "Mídias" },
  { id: "frases", label: "Frases" },
  { id: "criar", label: "Criar" },
  { id: "historico", label: "Histórico" },
  { id: "api", label: "API" },
];

export default function App() {
  const [logged, setLogged] = useState<boolean>(!!getToken());
  const [section, setSection] = useState<Section>("midias");

  // se qualquer chamada retornar 401, o api.ts dispara este evento
  useEffect(() => {
    const onUnauth = () => setLogged(false);
    window.addEventListener("nitro-unauth", onUnauth);
    return () => window.removeEventListener("nitro-unauth", onUnauth);
  }, []);

  if (!logged) return <Auth onAuth={() => setLogged(true)} />;

  function logout() {
    clearToken();
    setLogged(false);
  }

  return (
    <div className="app">
      <header className="apphead">
        <h1>🎬 Nitro</h1>
        <button className="linkbtn" onClick={logout}>
          Sair
        </button>
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
      {section === "api" && <ApiKeys />}
    </div>
  );
}
