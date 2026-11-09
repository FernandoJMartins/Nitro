import { useEffect } from "react";
import { CONTATO_EMAIL, LegalFooter } from "./Landing";
import { irPara } from "./nav";
import "./Landing.css";

/* RASCUNHOS de Termos de Uso e Política de Privacidade — revisar com um advogado
   antes de depender deles. Mantidos em sincronia com as regras do sistema
   (planos, retenção de 30 dias, limites, cancelamento e reembolso). */

const ATUALIZADO = "9 de novembro de 2026";

function Contato() {
  return CONTATO_EMAIL ? (
    <a href={`mailto:${CONTATO_EMAIL}`}>{CONTATO_EMAIL}</a>
  ) : (
    <>pelos canais de suporte informados no site</>
  );
}

function Termos() {
  return (
    <>
      <h1>Termos de Uso</h1>
      <p className="ld-updated">Última atualização: {ATUALIZADO}</p>

      <h2>1. O serviço</h2>
      <p>
        O Nitro (nitroflow.site) é uma plataforma online, vendida por assinatura, que permite criar vídeos curtos a partir de
        mídias enviadas pelo próprio usuário e agendar publicações em perfis de redes sociais conectados por ele.
      </p>

      <h2>2. Conta</h2>
      <p>
        Para usar o Nitro é preciso criar uma conta com e-mail e senha. Você é responsável por manter a senha em sigilo e por
        tudo o que for feito na sua conta. É preciso ter 18 anos ou mais.
      </p>

      <h2>3. Planos, pagamento e renovação</h2>
      <p>
        O acesso é liberado mediante assinatura mensal de um dos planos exibidos no site (Básico, Pro ou Agência), cobrada no
        cartão de crédito pela Stripe. A assinatura renova automaticamente a cada mês até ser cancelada. Os limites de cada
        plano (perfis, vídeos, mídias, espaço, stories e recursos) são os informados na página de planos e podem ser
        consultados a qualquer momento no painel.
      </p>

      <h2>4. Cancelamento e reembolso</h2>
      <p>
        Você pode cancelar a qualquer momento pelo painel, sem multa. O acesso continua até o fim do período já pago e não há
        cobrança seguinte. Na primeira contratação, você pode desistir em até 7 (sete) dias e receber o valor integral de volta,
        conforme o art. 49 do Código de Defesa do Consumidor. Fora desse prazo, valores de períodos já iniciados não são
        reembolsados.
      </p>

      <h2>5. Seu conteúdo</h2>
      <p>
        As mídias, textos e vídeos são seus. Você declara ter os direitos necessários sobre tudo o que envia (imagens, músicas,
        marcas e pessoas retratadas) e nos autoriza a armazenar e processar esse material apenas para prestar o serviço. É
        proibido usar o Nitro para conteúdo ilegal, que viole direitos de terceiros, discriminatório, enganoso, de spam, ou que
        envolva menores de idade de forma imprópria.
      </p>

      <h2>6. Armazenamento e limites técnicos</h2>
      <p>
        Cada arquivo enviado pode ter até 50 MB e cada vídeo gerado tem até 1 minuto. Os vídeos gerados ficam disponíveis por
        30 dias e depois são apagados automaticamente; baixe os que quiser guardar. O Nitro não é um serviço de backup.
      </p>

      <h2>7. Publicação em redes sociais</h2>
      <p>
        O Nitro publica nos perfis que você conecta, usando a sessão desses perfis, e não a API oficial da Meta. As redes
        sociais podem limitar, suspender ou bloquear perfis por motivos próprios, inclusive por volume de publicações. Você é o
        único responsável pelo conteúdo publicado e pelo cumprimento das regras de cada rede. Não garantimos que toda
        publicação será concluída nem respondemos por medidas tomadas pelas redes sociais.
      </p>

      <h2>8. Disponibilidade</h2>
      <p>
        Trabalhamos para manter o serviço no ar, mas podem ocorrer interrupções para manutenção ou por falhas. O serviço é
        fornecido "no estado em que se encontra", e nossa responsabilidade fica limitada ao valor pago nos últimos 3 meses.
      </p>

      <h2>9. Suspensão</h2>
      <p>
        Podemos suspender ou encerrar contas que violem estes termos, que tenham pagamento recusado ou que coloquem em risco o
        serviço ou outros usuários.
      </p>

      <h2>10. Alterações e contato</h2>
      <p>
        Podemos atualizar estes termos e os planos, avisando com antecedência quando a mudança afetar o que você já contratou.
        Dúvidas: <Contato />. Fica eleito o foro do domicílio do consumidor.
      </p>
    </>
  );
}

function Privacidade() {
  return (
    <>
      <h1>Política de Privacidade</h1>
      <p className="ld-updated">Última atualização: {ATUALIZADO}</p>

      <p>
        Esta política explica quais dados o Nitro (nitroflow.site) coleta, para quê e quais são seus direitos, de acordo com a
        Lei Geral de Proteção de Dados (Lei 13.709/2018).
      </p>

      <h2>1. Dados que coletamos</h2>
      <ul>
        <li><strong>Conta:</strong> e-mail e senha (guardada apenas como hash criptográfico).</li>
        <li><strong>Assinatura:</strong> plano, status e identificadores da Stripe. Os dados do cartão ficam só com a Stripe.</li>
        <li><strong>Conteúdo:</strong> mídias, frases e vídeos que você envia ou gera. Os metadados dos arquivos (como localização e modelo do aparelho) são removidos no envio.</li>
        <li><strong>Perfis conectados:</strong> nome de usuário e credenciais ou sessão dos perfis que você conecta, guardados criptografados, apenas para publicar em seu nome.</li>
        <li><strong>Uso técnico:</strong> registros de publicações e erros, para operar e dar suporte ao serviço.</li>
      </ul>

      <h2>2. Para que usamos</h2>
      <p>
        Para prestar o serviço contratado (gerar vídeos, agendar e publicar), cobrar a assinatura, dar suporte, garantir a
        segurança e cumprir obrigações legais. Não vendemos seus dados e não os usamos para publicidade.
      </p>

      <h2>3. Com quem compartilhamos</h2>
      <ul>
        <li><strong>Stripe:</strong> processamento de pagamentos.</li>
        <li><strong>DigitalOcean:</strong> hospedagem dos servidores e do banco de dados.</li>
        <li><strong>OpenAI:</strong> apenas quando você usa os recursos de IA, recebe as frases de exemplo e instruções necessárias para gerar os textos.</li>
        <li><strong>Redes sociais:</strong> o conteúdo que você escolhe publicar nos seus perfis.</li>
      </ul>

      <h2>4. Por quanto tempo guardamos</h2>
      <p>
        Vídeos gerados: 30 dias. Mídias e configurações: enquanto sua conta existir. Dados de cobrança: pelo prazo exigido pela
        legislação fiscal. Ao excluir a conta, apagamos seu conteúdo em até 30 dias.
      </p>

      <h2>5. Seus direitos</h2>
      <p>
        Você pode pedir acesso, correção, portabilidade ou exclusão dos seus dados e revogar consentimentos, entrando em
        contato <Contato />.
      </p>

      <h2>6. Segurança</h2>
      <p>
        Usamos conexão criptografada (HTTPS), senhas com hash, credenciais de perfis criptografadas e acesso restrito aos
        servidores. Nenhum sistema é 100% seguro, mas avisaremos você e as autoridades em caso de incidente relevante.
      </p>

      <h2>7. Cookies</h2>
      <p>
        Usamos apenas o armazenamento local do navegador necessário para manter você conectado e lembrar preferências, como o
        tema. Não usamos cookies de rastreamento ou publicidade.
      </p>
    </>
  );
}

export default function Legal({ pagina }: { pagina: "termos" | "privacidade" }) {
  useEffect(() => {
    document.title = pagina === "termos" ? "Termos de Uso · Nitro" : "Política de Privacidade · Nitro";
    window.scrollTo(0, 0);
  }, [pagina]);

  return (
    <div className="ld">
      <header className="ld-nav">
        <a
          href="/"
          className="ld-logo"
          onClick={(e) => {
            e.preventDefault();
            irPara("/");
          }}
        >
          Nitro
        </a>
      </header>
      <main className="ld-legal">{pagina === "termos" ? <Termos /> : <Privacidade />}</main>
      <LegalFooter />
    </div>
  );
}
