import { useEffect, useState } from "react";
import {
  ArrowRight,
  CalendarClock,
  Check,
  Clapperboard,
  CircleDashed,
  Music2,
  ShieldCheck,
  Sparkles,
  Upload,
  Users,
  Wand2,
  X,
} from "lucide-react";
import { listPlans, type PlanInfo } from "./api";
import { irPara } from "./nav";
import "./Landing.css";

/** E-mail de contato exibido no rodapé e nas páginas legais. Vazio = não exibe. */
export const CONTATO_EMAIL = "";

function go(e: React.MouseEvent, path: string) {
  e.preventDefault();
  irPara(path);
}

function fmt(n: number) {
  return n >= 1e8 ? "Ilimitado" : n.toLocaleString("pt-BR");
}

const RECURSOS = [
  {
    icon: Clapperboard,
    titulo: "Geração em massa",
    texto: "Escolha uma pasta de mídias e gere dezenas de vídeos verticais de uma vez, cada um com uma combinação diferente.",
  },
  {
    icon: Sparkles,
    titulo: "Textos e legendas com IA",
    texto: "Frases dentro do vídeo e legendas da postagem criadas no estilo das suas, prontas para publicar.",
  },
  {
    icon: Music2,
    titulo: "Música e efeitos",
    texto: "Trilhas da sua biblioteca, texto com fontes e posições livres, imagens sobrepostas e clipe final.",
  },
  {
    icon: CalendarClock,
    titulo: "Calendário de publicações",
    texto: "Aprove os vídeos e o Nitro distribui entre os horários de cada perfil. Arraste para remarcar.",
  },
  {
    icon: CircleDashed,
    titulo: "Stories automáticos",
    texto: "Monte sequências de stories com link e texto e programe para sair todo dia, em um ou vários perfis.",
  },
  {
    icon: Users,
    titulo: "Vários perfis",
    texto: "Gerencie todos os perfis num só lugar, cada um com seus horários, idioma e ritmo de postagem.",
  },
];

const PASSOS = [
  { icon: Upload, titulo: "Envie suas mídias", texto: "Vídeos, fotos e músicas ficam organizados em pastas na sua biblioteca." },
  { icon: Wand2, titulo: "Gere os vídeos", texto: "Defina quantidade, duração, textos e estilo. O Nitro monta tudo sozinho." },
  { icon: CalendarClock, titulo: "Aprove e agende", texto: "Revise, aprove e deixe o calendário publicar nos horários certos." },
];

const FAQ = [
  {
    q: "Posso cancelar quando quiser?",
    a: "Sim. Você cancela pelo próprio painel, sem multa. O acesso continua até o fim do período já pago.",
  },
  {
    q: "Tem reembolso?",
    a: "Sim. Se pedir em até 7 dias após a primeira assinatura, devolvemos o valor integral, como prevê o Código de Defesa do Consumidor.",
  },
  {
    q: "Como é feito o pagamento?",
    a: "Assinatura mensal no cartão de crédito, processada pela Stripe. O Nitro não vê nem guarda os dados do seu cartão.",
  },
  {
    q: "Meus vídeos ficam guardados para sempre?",
    a: "Não. Cada vídeo gerado é apagado automaticamente assim que é postado, e os que não forem agendados são apagados após 3 dias. Baixe os que quiser guardar. Suas mídias enviadas continuam na biblioteca.",
  },
  {
    q: "Existe limite de tamanho?",
    a: "Cada arquivo enviado pode ter até 50 MB e cada vídeo gerado tem até 1 minuto. A quantidade de vídeos, perfis e espaço depende do plano.",
  },
];

function Recursos({ p }: { p: PlanInfo }) {
  const linhas: [boolean, string][] = [
    [true, `${fmt(p.max_contas)} perfis conectados`],
    [true, `${fmt(p.videos_por_mes)} vídeos por mês`],
    [true, `Até ${fmt(p.max_por_lote)} vídeos por lote`],
    [true, `${fmt(p.max_calendario)} posts na fila`],
    [true, `${fmt(p.stories_por_dia)} stories por dia`],
    [true, `${fmt(p.max_midias)} mídias · ${fmt(p.armazenamento_gb)} GB`],
    [p.ia, "IA para textos e legendas"],
    [p.stories_compartilhados, "Stories em vários perfis"],
    [p.upscale, "Ampliar imagens"],
    [p.api_keys, "Acesso via API"],
  ];
  return (
    <ul className="ld-plan-list">
      {linhas.map(([ok, txt]) => (
        <li key={txt} className={ok ? "" : "ld-off"}>
          {ok ? <Check size={16} aria-hidden="true" /> : <X size={16} aria-hidden="true" />}
          <span>
            {txt}
            {!ok && <span className="ld-sr"> (não incluso)</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Página pública (visitante sem login): apresenta o Nitro e leva ao cadastro. */
export default function Landing() {
  const [plans, setPlans] = useState<PlanInfo[]>([]);
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    document.title = "Nitro: vídeos curtos em escala e posts no automático";
    listPlans().then(setPlans).catch(() => {});
  }, []);

  return (
    <div className="ld">
      <header className="ld-nav">
        <a href="/" className="ld-logo" onClick={(e) => go(e, "/")}>
          Nitro
        </a>
        <nav className={`ld-links${menu ? " open" : ""}`} aria-label="Seções">
          <a href="#recursos" onClick={() => setMenu(false)}>Recursos</a>
          <a href="#como-funciona" onClick={() => setMenu(false)}>Como funciona</a>
          <a href="#planos" onClick={() => setMenu(false)}>Planos</a>
          <a href="#faq" onClick={() => setMenu(false)}>Dúvidas</a>
        </nav>
        <div className="ld-nav-cta">
          <a href="/entrar" className="ld-btn ld-btn-ghost" onClick={(e) => go(e, "/entrar")}>
            Entrar
          </a>
          <a href="/cadastro" className="ld-btn ld-btn-primary ld-hide-sm" onClick={(e) => go(e, "/cadastro")}>
            Começar
          </a>
          <button className="ld-burger" aria-label="Abrir menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
            <span />
            <span />
          </button>
        </div>
      </header>

      <main>
        <section className="ld-hero">
          <div className="ld-glow" aria-hidden="true" />
          <div className="ld-hero-text">
            <span className="ld-eyebrow">
              <Sparkles size={14} aria-hidden="true" /> Para criadores, marcas e agências
            </span>
            <h1>
              Vídeos curtos em escala.
              <br />
              <span className="ld-grad">Posts no automático.</span>
            </h1>
            <p className="ld-lead">
              Gere dezenas de Reels a partir das suas próprias mídias, com textos, música e legendas por IA. Depois deixe o
              Nitro agendar e publicar nos seus perfis.
            </p>
            <div className="ld-hero-cta">
              <a href="/cadastro" className="ld-btn ld-btn-primary ld-btn-lg" onClick={(e) => go(e, "/cadastro")}>
                Criar minha conta <ArrowRight size={18} aria-hidden="true" />
              </a>
              <a href="#planos" className="ld-btn ld-btn-ghost ld-btn-lg">
                Ver planos
              </a>
            </div>
            <p className="ld-trust">
              <ShieldCheck size={16} aria-hidden="true" /> Pagamento seguro pela Stripe · Cancele quando quiser
            </p>
          </div>

          <div className="ld-phones" aria-hidden="true">
            <div className="ld-phone ld-phone-1">
              <div className="ld-screen ld-s1">
                <span className="ld-caption">3 dicas para crescer</span>
              </div>
            </div>
            <div className="ld-phone ld-phone-2">
              <div className="ld-screen ld-s2">
                <span className="ld-caption">antes x depois</span>
                <div className="ld-progress"><i /></div>
              </div>
            </div>
            <div className="ld-phone ld-phone-3">
              <div className="ld-screen ld-s3">
                <span className="ld-caption">novidade da semana ✨</span>
              </div>
            </div>
            <div className="ld-chip ld-chip-1">
              <Clapperboard size={14} /> 48 vídeos gerados
            </div>
            <div className="ld-chip ld-chip-2">
              <CalendarClock size={14} /> Agendado para 18:00
            </div>
            <div className="ld-chip ld-chip-3">
              <Check size={14} /> Story publicado
            </div>
          </div>
        </section>

        <section id="recursos" className="ld-section">
          <h2>Tudo o que você precisa para postar todo dia</h2>
          <p className="ld-sub">Da criação à publicação, sem planilha e sem editor de vídeo.</p>
          <div className="ld-features">
            {RECURSOS.map(({ icon: Icon, titulo, texto }) => (
              <article key={titulo} className="ld-feature">
                <div className="ld-icon">
                  <Icon size={22} aria-hidden="true" />
                </div>
                <h3>{titulo}</h3>
                <p>{texto}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="como-funciona" className="ld-section">
          <h2>Como funciona</h2>
          <p className="ld-sub">Três passos entre as suas mídias e o seu feed.</p>
          <ol className="ld-steps">
            {PASSOS.map(({ icon: Icon, titulo, texto }, i) => (
              <li key={titulo} className="ld-step">
                <span className="ld-step-n">{i + 1}</span>
                <Icon size={26} aria-hidden="true" />
                <h3>{titulo}</h3>
                <p>{texto}</p>
              </li>
            ))}
          </ol>
        </section>

        <section id="planos" className="ld-section">
          <h2>Planos</h2>
          <p className="ld-sub">Assinatura mensal no cartão. Troque de plano ou cancele quando quiser.</p>
          <div className="ld-plans">
            {plans.map((p) => {
              const destaque = p.id === "pro";
              return (
                <article key={p.id} className={`ld-plan${destaque ? " ld-plan-hot" : ""}`}>
                  {destaque && <span className="ld-badge">Mais escolhido</span>}
                  <h3>{p.nome}</h3>
                  <div className="ld-price">
                    <span className="ld-cur">R$</span>
                    {Math.round(p.preco_mensal).toLocaleString("pt-BR")}
                    <span className="ld-per">/mês</span>
                  </div>
                  <Recursos p={p} />
                  <a
                    href="/cadastro"
                    className={`ld-btn ${destaque ? "ld-btn-primary" : "ld-btn-ghost"} ld-btn-block`}
                    onClick={(e) => go(e, "/cadastro")}
                  >
                    Assinar {p.nome}
                  </a>
                </article>
              );
            })}
          </div>
          <p className="ld-fine">
            Em todos os planos: arquivos de até 50 MB, vídeos gerados de até 1 minuto, apagados após a postagem (ou em 3 dias, se não agendados).
          </p>
        </section>

        <section id="faq" className="ld-section ld-faq">
          <h2>Dúvidas frequentes</h2>
          {FAQ.map(({ q, a }) => (
            <details key={q}>
              <summary>{q}</summary>
              <p>{a}</p>
            </details>
          ))}
        </section>

        <section className="ld-final">
          <h2>Comece a postar mais hoje</h2>
          <p>Crie sua conta em menos de um minuto.</p>
          <a href="/cadastro" className="ld-btn ld-btn-primary ld-btn-lg" onClick={(e) => go(e, "/cadastro")}>
            Criar minha conta <ArrowRight size={18} aria-hidden="true" />
          </a>
        </section>
      </main>

      <LegalFooter />
    </div>
  );
}

export function LegalFooter() {
  return (
    <footer className="ld-footer">
      <span className="ld-logo ld-logo-sm">Nitro</span>
      <nav aria-label="Links legais">
        <a href="/termos" onClick={(e) => go(e, "/termos")}>Termos de Uso</a>
        <a href="/privacidade" onClick={(e) => go(e, "/privacidade")}>Privacidade</a>
        {CONTATO_EMAIL && <a href={`mailto:${CONTATO_EMAIL}`}>Contato</a>}
      </nav>
      <span className="ld-copy">© {new Date().getFullYear()} Nitro · nitroflow.site</span>
    </footer>
  );
}
