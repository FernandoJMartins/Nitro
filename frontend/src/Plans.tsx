import { useEffect, useState } from "react";
import { ErrorBanner } from "./Dialog";
import { billingMe, listPlans, openPortal, startCheckout, type BillingMe, type PlanInfo } from "./api";

const STATUS: Record<string, string> = {
  active: "ativa",
  trialing: "em teste",
  past_due: "pagamento pendente",
  canceled: "cancelada",
  unpaid: "não paga",
  incomplete: "incompleta",
  incomplete_expired: "expirada",
};

function fmt(n: number) {
  return n >= 1e8 ? "ilimitado" : n.toLocaleString("pt-BR");
}

function dataBR(iso: string | null) {
  return iso ? new Date(iso).toLocaleDateString("pt-BR") : "";
}

/** Tela de planos: escolher/assinar (Stripe Checkout), ver uso e gerenciar a assinatura. */
export default function Plans() {
  const [plans, setPlans] = useState<PlanInfo[]>([]);
  const [me, setMe] = useState<BillingMe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const status = new URLSearchParams(window.location.search).get("status");

  useEffect(() => {
    listPlans().then(setPlans).catch((e) => setError(String(e)));
    billingMe().then(setMe).catch((e) => setError(String(e)));
  }, []);

  async function assinar(plano: string) {
    setError(null);
    setBusy(plano);
    try {
      window.location.href = (await startCheckout(plano)).url;
    } catch (e) {
      setError(String(e));
      setBusy(null);
    }
  }

  async function gerenciar() {
    setError(null);
    setBusy("portal");
    try {
      window.location.href = (await openPortal()).url;
    } catch (e) {
      setError(String(e));
      setBusy(null);
    }
  }

  const r = me?.recursos;
  const temStripe = !!me?.assinatura_status && me.assinatura_status !== "canceled";

  return (
    <>
      {status === "sucesso" && (
        <p className="notice-ok">Pagamento recebido! Sua assinatura é ativada em alguns segundos — recarregue a página se ainda não liberou.</p>
      )}
      {status === "cancelado" && <p className="sub">Pagamento cancelado. Nenhuma cobrança foi feita.</p>}
      <ErrorBanner error={error} onClose={() => setError(null)} />

      {me && (
        <div className="card" style={{ display: "block", marginBottom: 20 }}>
          {me.is_admin ? (
            <strong>Você é administrador: acesso total, sem limites e sem assinatura.</strong>
          ) : me.tem_acesso && r ? (
            <>
              <strong>Plano atual: {r.nome}</strong>
              {me.assinatura_status && <span className="pill" style={{ marginLeft: 8 }}>assinatura {STATUS[me.assinatura_status] ?? me.assinatura_status}</span>}
              {me.periodo_fim && <span className="sub"> · renova em {dataBR(me.periodo_fim)}</span>}
              {me.acesso_manual_ate && <span className="sub"> · acesso liberado até {dataBR(me.acesso_manual_ate)}</span>}
              <ul className="sub" style={{ margin: "10px 0 0", paddingLeft: 18 }}>
                <li>Vídeos gerados este mês: {fmt(me.uso.videos_mes)} de {fmt(r.videos_por_mes)}</li>
                <li>Perfis conectados: {me.uso.contas} de {fmt(r.max_contas)}</li>
                <li>Vídeos na fila de publicação: {me.uso.calendario} de {fmt(r.max_calendario)}</li>
                <li>Stories hoje (todas as contas): {me.uso.stories_hoje} de {fmt(r.stories_por_dia)}</li>
                <li>Mídias na biblioteca: {me.uso.midias} de {fmt(r.max_midias)}</li>
                <li>
                  Espaço usado: {(me.uso.armazenamento_bytes / 1024 ** 3).toFixed(2)} GB de {fmt(r.armazenamento_gb)} GB
                </li>
              </ul>
            </>
          ) : (
            <strong>Escolha um plano para usar o Nitro. O pagamento é mensal, no cartão.</strong>
          )}
          {!me.is_admin && me.plano && temStripe && (
            <div style={{ marginTop: 12 }}>
              <button className="btn" onClick={gerenciar} disabled={busy !== null}>
                {busy === "portal" ? "Abrindo…" : "Gerenciar assinatura (cartão, plano, cancelar)"}
              </button>
            </div>
          )}
        </div>
      )}

      <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))" }}>
        {plans.map((p) => {
          const atual = me?.tem_acesso && me.plano === p.id && !me.is_admin;
          return (
            <div key={p.id} className="card" style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "stretch" }}>
              <h3 style={{ margin: 0 }}>{p.nome}</h3>
              <div style={{ fontSize: 26, fontWeight: 700 }}>
                {p.preco_mensal.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}
                <span className="sub" style={{ fontSize: 14, fontWeight: 400 }}> /mês</span>
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.7 }}>
                <li>{fmt(p.max_contas)} perfis conectados</li>
                <li>{fmt(p.videos_por_mes)} vídeos gerados por mês</li>
                <li>até {fmt(p.max_por_lote)} vídeos por lote</li>
                <li>{fmt(p.max_calendario)} vídeos na fila de publicação</li>
                <li>{fmt(p.stories_por_dia)} stories por dia (somando todos os perfis)</li>
                <li>{fmt(p.max_midias)} mídias na biblioteca ({fmt(p.armazenamento_gb)} GB)</li>
                <li>Arquivos de até 50 MB · vídeos gerados de até 1 min</li>
                <li>{p.ia ? "✓" : "✗"} IA de frases e legendas</li>
                <li>{p.stories_compartilhados ? "✓" : "✗"} Stories em várias contas de uma vez</li>
                <li>{p.upscale ? "✓" : "✗"} Ampliar imagens</li>
                <li>{p.api_keys ? "✓" : "✗"} Acesso via API</li>
                <li>Vídeos gerados ficam guardados por 30 dias</li>
              </ul>
              <div style={{ marginTop: "auto" }}>
                {me?.is_admin ? null : atual ? (
                  <span className="pill">Seu plano</span>
                ) : temStripe ? (
                  <button className="btn" onClick={gerenciar} disabled={busy !== null}>
                    Mudar para {p.nome}
                  </button>
                ) : (
                  <button className="btn primary" onClick={() => assinar(p.id)} disabled={busy !== null || !me?.pagamento_configurado}>
                    {busy === p.id ? "Abrindo pagamento…" : `Assinar ${p.nome}`}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {me && !me.pagamento_configurado && !me.is_admin && (
        <p className="sub" style={{ marginTop: 12 }}>O pagamento online ainda não está disponível. Fale com o suporte.</p>
      )}
    </>
  );
}
