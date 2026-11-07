import { useEffect, useState } from "react";
import { clearToken, getToken } from "./api";
import Auth from "./Auth";
import MediaLibrary from "./MediaLibrary";
import Phrases from "./Phrases";
import Create from "./Create";
import History from "./History";
import ApiKeys from "./ApiKeys";
import Utils from "./Utils";
import Publishing from "./Publishing";
import Stories from "./Stories";
import Calendar from "./Calendar";
import Accounts from "./Accounts";
import { ConfirmDialog, ConfirmHost, Modal } from "./Dialog";

type Section =
  | "midias"
  | "frases"
  | "criar"
  | "historico"
  | "publicacao"
  | "calendario"
  | "contas"
  | "stories"
  | "utilitarios"
  | "api";

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
    case "publicacao": // enviar / avião de papel
      return (
        <svg {...common}>
          <line x1="22" y1="2" x2="11" y2="13" />
          <polygon points="22 2 15 22 11 13 2 9 22 2" fill={active ? "currentColor" : "none"} />
        </svg>
      );
    case "utilitarios": // ferramentas / chave inglesa
      return (
        <svg {...common} fill={active ? "currentColor" : "none"}>
          <path d="M14.7 6.3a4 4 0 0 0-5.4 5.2L3 17.8 6.2 21l6.3-6.3a4 4 0 0 0 5.2-5.4l-2.6 2.6-2.3-.3-.3-2.3 2.6-2.6Z" />
        </svg>
      );
    case "stories": // anel de story (círculo tracejado + imagem dentro) — diferente do "+" de Criar
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10" strokeDasharray="4 2.2" />
          <circle cx="12" cy="12" r="5.5" fill={active ? "currentColor" : "none"} />
        </svg>
      );
    case "calendario": // calendário
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="17" rx="2.5" />
          <line x1="3" y1="9" x2="21" y2="9" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="16" y1="2" x2="16" y2="6" />
        </svg>
      );
    case "contas": // pessoas (múltiplas contas)
      return (
        <svg {...common}>
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" fill={active ? "currentColor" : "none"} />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
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

// Menu agrupado por etapa do trabalho — o nome de cada item diz o que ele faz.
// `mobile: true` = aparece direto na barra inferior do celular; os demais ficam em "Menu".
const GROUPS: { titulo: string; itens: { id: Section; label: string; mobile?: boolean }[] }[] = [
  {
    titulo: "Criar conteúdo",
    itens: [
      { id: "midias", label: "Mídias", mobile: true },
      { id: "frases", label: "Frases" },
      { id: "criar", label: "Criar vídeos", mobile: true },
      { id: "historico", label: "Vídeos gerados" },
    ],
  },
  {
    titulo: "Publicar",
    itens: [
      { id: "publicacao", label: "Publicação", mobile: true },
      { id: "calendario", label: "Calendário" },
      { id: "stories", label: "Stories", mobile: true },
      { id: "contas", label: "Contas" },
    ],
  },
  {
    titulo: "Ferramentas",
    itens: [
      { id: "utilitarios", label: "Utilitários" },
      { id: "api", label: "Chaves de API" },
    ],
  },
];

const TITLES: Record<Section, string> = {
  midias: "Mídias",
  frases: "Frases",
  criar: "Criar vídeos",
  historico: "Vídeos gerados",
  publicacao: "Publicação",
  calendario: "Calendário",
  contas: "Contas",
  stories: "Stories",
  utilitarios: "Utilitários",
  api: "Chaves de API",
};

// Uma frase dizendo PARA QUE serve cada página — sempre no mesmo lugar, logo abaixo do título.
const DESCS: Record<Section, string> = {
  midias: "Guarde aqui os vídeos, fotos e músicas usados para criar o conteúdo, organizados em pastas.",
  frases: "Frases que aparecem dentro dos vídeos. Escolha um tipo para ver e editar as frases dele.",
  criar: "Gere vários vídeos de uma vez a partir de uma pasta de mídias.",
  historico: "Todos os vídeos que já foram gerados, do mais novo para o mais antigo.",
  publicacao: "Acompanhe o que foi publicado hoje e aprove o que ainda vai ser publicado.",
  calendario: "Veja os dias e horários de cada publicação. Arraste um item para mudar o horário.",
  contas: "As contas do Instagram usadas para publicar, e as configurações de cada uma.",
  stories: "Stories publicados automaticamente todo dia, por conta ou em várias contas de uma vez.",
  utilitarios: "Ferramentas extras, como ampliar imagens.",
  api: "Chaves para outros sistemas usarem o Nitro. Só mexa aqui se souber para que serve.",
};

type Theme = "dark" | "light";

const PATHS: Record<Section, string> = {
  midias: "/midias",
  frases: "/frases",
  criar: "/criar",
  historico: "/historico",
  publicacao: "/publicacao",
  calendario: "/calendario",
  contas: "/contas",
  stories: "/stories",
  utilitarios: "/utilitarios",
  api: "/api",
};

function sectionFromPath(path: string): Section {
  const found = (Object.keys(PATHS) as Section[]).find((s) => PATHS[s] === path);
  return found ?? "midias";
}

export default function App() {
  const [logged, setLogged] = useState<boolean>(!!getToken());
  const [section, setSection] = useState<Section>(() => sectionFromPath(window.location.pathname));
  const [menuAberto, setMenuAberto] = useState(false);
  const [confirmaSair, setConfirmaSair] = useState(false);
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem("nitro-theme") as Theme) || "dark"
  );

  // navega para uma seção trocando a URL (permite F5 e voltar/avançar do navegador)
  function goTo(next: Section) {
    setSection(next);
    if (window.location.pathname !== PATHS[next]) {
      window.history.pushState(null, "", PATHS[next]);
    }
    window.scrollTo(0, 0);
  }

  // mantém a URL em sincronia quando o usuário usa voltar/avançar
  useEffect(() => {
    const onPop = () => setSection(sectionFromPath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // normaliza a URL inicial (ex.: "/" vira "/midias") sem empilhar no histórico
  useEffect(() => {
    if (window.location.pathname !== PATHS[section]) {
      window.history.replaceState(null, "", PATHS[section]);
    }
  }, []);

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

  function navBtn(id: Section, label: string, extra = "") {
    const active = section === id;
    return (
      <button
        key={id}
        type="button"
        className={`igtab-btn${active ? " active" : ""}${extra}`}
        onClick={() => {
          goTo(id);
          setMenuAberto(false);
        }}
        aria-current={active ? "page" : undefined}
      >
        <Icon name={id} active={active} />
        <span className="igtab-label">{label}</span>
      </button>
    );
  }

  return (
    <div className="app">
      <a className="skip-link" href="#conteudo">
        Pular para o conteúdo
      </a>
      <header className="ighead">
        <span className="iglogo">Nitro</span>
        <h1 className="ightitle">{TITLES[section]}</h1>
        <button
          type="button"
          className="igtheme"
          onClick={toggleTheme}
          title={theme === "dark" ? "Mudar para o tema claro" : "Mudar para o tema escuro"}
          aria-label={theme === "dark" ? "Mudar para o tema claro" : "Mudar para o tema escuro"}
        >
          {theme === "dark" ? (
            /* sol */
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
            </svg>
          ) : (
            /* lua */
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
            </svg>
          )}
        </button>
        <button type="button" className="iglogout" onClick={() => setConfirmaSair(true)} title="Sair da conta">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          <span className="iglogout-label">Sair</span>
        </button>
      </header>

      <main className="igmain" id="conteudo" tabIndex={-1}>
        <p className="page-desc">{DESCS[section]}</p>
        {section === "midias" && <MediaLibrary />}
        {section === "frases" && <Phrases />}
        {section === "criar" && <Create />}
        {section === "historico" && <History />}
        {section === "publicacao" && <Publishing />}
        {section === "calendario" && <Calendar />}
        {section === "contas" && <Accounts />}
        {section === "stories" && <Stories />}
        {section === "utilitarios" && <Utils />}
        {section === "api" && <ApiKeys />}
      </main>

      {/* desktop: barra lateral com todos os itens, agrupados.
          celular: barra inferior só com os principais + "Menu" (abre a lista completa). */}
      <nav className="igtab" aria-label="Menu principal">
        {GROUPS.map((g) => (
          <div key={g.titulo} className="igtab-group" role="group" aria-label={g.titulo}>
            <div className="igtab-group-title" aria-hidden="true">
              {g.titulo}
            </div>
            {g.itens.map((it) => navBtn(it.id, it.label, it.mobile ? "" : " igtab-btn--desk"))}
          </div>
        ))}
        <button
          type="button"
          className={`igtab-btn igtab-btn--more${menuAberto ? " active" : ""}`}
          onClick={() => setMenuAberto(true)}
          aria-haspopup="dialog"
        >
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <line x1="4" y1="7" x2="20" y2="7" />
            <line x1="4" y1="12" x2="20" y2="12" />
            <line x1="4" y1="17" x2="20" y2="17" />
          </svg>
          <span className="igtab-label">Menu</span>
        </button>
      </nav>

      {menuAberto && (
        <Modal title="Menu" onClose={() => setMenuAberto(false)}>
          <div className="menu-sheet">
            {GROUPS.map((g) => (
              <div key={g.titulo} className="menu-sheet-group" role="group" aria-label={g.titulo}>
                <div className="igtab-group-title">{g.titulo}</div>
                {g.itens.map((it) => navBtn(it.id, it.label))}
              </div>
            ))}
          </div>
        </Modal>
      )}
      <ConfirmHost />
      {confirmaSair && (
        <ConfirmDialog
          title="Sair da conta?"
          message="Você vai precisar digitar o e-mail e a senha de novo para entrar."
          confirmLabel="Sair"
          cancelLabel="Ficar"
          tone="primary"
          onConfirm={() => {
            setConfirmaSair(false);
            logout();
          }}
          onClose={() => setConfirmaSair(false)}
        />
      )}
    </div>
  );
}
