import { useEffect, useState } from "react";
import { clearToken, getToken, me, type UserOut } from "./api";
import Plans from "./Plans";
import Admin from "./Admin";
import Landing from "./Landing";
import Legal from "./Legal";
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
  | "api"
  | "planos"
  | "admin";

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
    case "planos": // cartão
      return (
        <svg {...common}>
          <rect x="2" y="5" width="20" height="14" rx="2.5" />
          <line x1="2" y1="10" x2="22" y2="10" />
          <line x1="6" y1="15" x2="10" y2="15" />
        </svg>
      );
    case "admin": // escudo
      return (
        <svg {...common} fill={active ? "currentColor" : "none"}>
          <path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Z" />
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
  {
    titulo: "Conta",
    itens: [
      { id: "planos", label: "Plano" },
      { id: "admin", label: "Admin" },
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
  planos: "Plano e assinatura",
  admin: "Administração",
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
  planos: "Seu plano, o quanto você já usou e o pagamento mensal (cartão).",
  admin: "Todos os usuários, planos e uso. Libere acesso de cortesia ou bloqueie usuários.",
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
  planos: "/planos",
  admin: "/admin",
};

// rotas públicas (sem login). Logado em "/entrar" ou "/" cai no app normalmente.
const PUBLICAS = new Set(["/termos", "/privacidade"]);

function sectionFromPath(path: string): Section {
  const found = (Object.keys(PATHS) as Section[]).find((s) => PATHS[s] === path);
  return found ?? "midias";
}

export default function App() {
  const [logged, setLogged] = useState<boolean>(!!getToken());
  const [section, setSection] = useState<Section>(() => sectionFromPath(window.location.pathname));
  const [menuAberto, setMenuAberto] = useState(false);
  const [confirmaSair, setConfirmaSair] = useState(false);
  const [user, setUser] = useState<UserOut | null>(null);
  // caminho atual — decide as páginas públicas (início, entrar, termos...)
  const [path, setPath] = useState(window.location.pathname);
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
    const onPop = () => {
      setSection(sectionFromPath(window.location.pathname));
      setPath(window.location.pathname);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // normaliza a URL inicial (ex.: "/" vira "/midias") sem empilhar no histórico.
  // Só para quem está logado: visitante fica nas páginas públicas.
  useEffect(() => {
    if (logged && !PUBLICAS.has(window.location.pathname) && window.location.pathname !== PATHS[section]) {
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

  // perfil + plano: recarrega ao logar e sempre que a API responder 402
  // (assinatura caiu ou limite do plano atingido)
  useEffect(() => {
    if (!logged) {
      setUser(null);
      return;
    }
    const load = () => me().then(setUser).catch(() => {});
    load();
    window.addEventListener("nitro-paywall", load);
    return () => window.removeEventListener("nitro-paywall", load);
  }, [logged]);

  // páginas legais: abertas para todos, logado ou não
  if (path === "/termos" || path === "/privacidade") return <Legal pagina={path === "/termos" ? "termos" : "privacidade"} />;

  if (!logged) {
    if (path === "/entrar" || path === "/cadastro")
      return (
        <Auth
          key={path}
          inicial={path === "/cadastro" ? "registro" : "login"}
          onAuth={() => {
            window.history.replaceState(null, "", PATHS.midias);
            setPath(PATHS.midias);
            setSection("midias");
            setLogged(true);
          }}
        />
      );
    return <Landing />;
  }
  if (!user) return <div className="loading">Carregando…</div>;

  // sem assinatura ativa: só a tela de planos fica disponível
  const semAcesso = !user.tem_acesso;
  const visiveis = (id: Section) => (semAcesso ? id === "planos" : id !== "admin" || user.is_admin);
  const groups = GROUPS.map((g) => ({ ...g, itens: g.itens.filter((it) => visiveis(it.id)) })).filter(
    (g) => g.itens.length > 0
  );
  const atual: Section = visiveis(section) ? section : "planos";

  function logout() {
    clearToken();
    setLogged(false);
    setUser(null);
    window.history.pushState(null, "", "/");
    setPath("/");
  }

  function navBtn(id: Section, label: string, extra = "") {
    const active = atual === id;
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
        <h1 className="ightitle">{TITLES[atual]}</h1>
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
        <p className="page-desc">{DESCS[atual]}</p>
        {atual === "midias" && <MediaLibrary />}
        {atual === "frases" && <Phrases />}
        {atual === "criar" && <Create />}
        {atual === "historico" && <History />}
        {atual === "publicacao" && <Publishing />}
        {atual === "calendario" && <Calendar />}
        {atual === "contas" && <Accounts />}
        {atual === "stories" && <Stories />}
        {atual === "utilitarios" && <Utils />}
        {atual === "api" && <ApiKeys />}
        {atual === "planos" && <Plans />}
        {atual === "admin" && user.is_admin && <Admin />}
      </main>

      {/* desktop: barra lateral com todos os itens, agrupados.
          celular: barra inferior só com os principais + "Menu" (abre a lista completa). */}
      <nav className="igtab" aria-label="Menu principal">
        {groups.map((g) => (
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
            {groups.map((g) => (
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
