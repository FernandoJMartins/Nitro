import { useEffect, useState } from "react";
import { clearToken, getToken } from "./api";
import Auth from "./Auth";
import MediaLibrary from "./MediaLibrary";
import Phrases from "./Phrases";
import Create from "./Create";
import History from "./History";
import ApiKeys from "./ApiKeys";
import Utils from "./Utils";

type Section = "midias" | "frases" | "criar" | "historico" | "utilitarios" | "api";

/* ícones de linha, no estilo Instagram (stroke fino, 24px) */
function Icon({ name, active }: { name: Section; active: boolean }) {
  const sw = active ? 2.4 : 2;
  const common = {
    width: 26,
    height: 26,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: sw,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (name) {
    case "midias": // grade / biblioteca
      return (
        <svg {...common}>
          <rect x="3" y="3" width="7" height="7" rx="1.5" fill={active ? "currentColor" : "none"} />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" fill={active ? "currentColor" : "none"} />
        </svg>
      );
    case "frases": // balão de mensagem
      return (
        <svg {...common} fill={active ? "currentColor" : "none"}>
          <path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 9.5 9.5 0 0 1-4-.9L3 21l1.9-5.5A8.5 8.5 0 1 1 21 11.5Z" />
        </svg>
      );
    case "criar": // criar (+)
      return (
        <svg {...common}>
          <rect x="3" y="3" width="18" height="18" rx="5" />
          <line x1="12" y1="8" x2="12" y2="16" />
          <line x1="8" y1="12" x2="16" y2="12" />
        </svg>
      );
    case "historico": // reels / play
      return (
        <svg {...common}>
          <rect x="3" y="3" width="18" height="18" rx="4" />
          <path d="M3 8h18M8 3l2 5M14 3l2 5" />
          <path d="M10.5 11.5v4l3.5-2-3.5-2Z" fill={active ? "currentColor" : "none"} />
        </svg>
      );
    case "utilitarios": // ferramentas / chave inglesa
      return (
        <svg {...common} fill={active ? "currentColor" : "none"}>
          <path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L3 17.8 6.2 21l6.3-6.3a4 4 0 0 0 5.2-5.4l-2.6 2.6-2.3-.3-.3-2.3 2.6-2.6Z" />
        </svg>
      );
    case "api": // perfil / chave
      return (
        <svg {...common} fill={active ? "currentColor" : "none"}>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21c0-4 3.5-6 8-6s8 2 8 6" />
        </svg>
      );
  }
}

const SECTIONS: { id: Section; label: string }[] = [
  { id: "midias", label: "Mídias" },
  { id: "frases", label: "Frases" },
  { id: "criar", label: "Criar" },
  { id: "historico", label: "Histórico" },
  { id: "utilitarios", label: "Utilitários" },
  { id: "api", label: "API" },
];

const TITLES: Record<Section, string> = {
  midias: "Mídias",
  frases: "Frases",
  criar: "Criar",
  historico: "Histórico",
  utilitarios: "Utilitários",
  api: "API",
};

type Theme = "dark" | "light";

export default function App() {
  const [logged, setLogged] = useState<boolean>(!!getToken());
  const [section, setSection] = useState<Section>("midias");
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem("nitro-theme") as Theme) || "dark"
  );

  // Aplica o tema na tag <html> e persiste a escolha.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("nitro-theme", theme);
  }, [theme]);

  function toggleTheme() {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }

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
      <header className="ighead">
        <span className="iglogo">Nitro</span>
        <span className="ightitle">{TITLES[section]}</span>
        <button
          className="igtheme"
          onClick={toggleTheme}
          title={theme === "dark" ? "Tema claro" : "Tema escuro"}
          aria-label="Alternar tema"
        >
          {theme === "dark" ? (
            /* sol */
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
            </svg>
          ) : (
            /* lua */
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
            </svg>
          )}
        </button>
        <button className="iglogout" onClick={logout} title="Sair" aria-label="Sair">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
        </button>
      </header>

      <main className="igmain">
        {section === "midias" && <MediaLibrary />}
        {section === "frases" && <Phrases />}
        {section === "criar" && <Create />}
        {section === "historico" && <History />}
        {section === "utilitarios" && <Utils />}
        {section === "api" && <ApiKeys />}
      </main>

      <nav className="igtab">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            className={section === s.id ? "igtab-btn active" : "igtab-btn"}
            onClick={() => setSection(s.id)}
            aria-label={s.label}
          >
            <Icon name={s.id} active={section === s.id} />
            <span className="igtab-label">{s.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
