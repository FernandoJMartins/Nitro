import { useEffect, useState } from "react";
import { ErrorBanner } from "./Dialog";
import { adminListUsers, adminUpdateUser, type AdminUser } from "./api";

const PLANOS = [
  { id: "basico", nome: "Básico" },
  { id: "pro", nome: "Pro" },
  { id: "agencia", nome: "Agência" },
];

function dataBR(iso: string | null) {
  return iso ? new Date(iso).toLocaleDateString("pt-BR") : "—";
}

/** Painel admin: todos os usuários, plano, uso, acesso manual (cortesia) e bloqueio. */
export default function Admin() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filtro, setFiltro] = useState("");

  function refresh() {
    adminListUsers().then(setUsers).catch((e) => setError(String(e)));
  }
  useEffect(refresh, []);

  async function upd(id: number, body: Parameters<typeof adminUpdateUser>[1]) {
    setError(null);
    try {
      const u = await adminUpdateUser(id, body);
      setUsers((us) => us.map((x) => (x.id === id ? u : x)));
    } catch (e) {
      setError(String(e));
    }
  }

  const lista = users.filter((u) => u.email.includes(filtro.trim().toLowerCase()));

  return (
    <>
      <ErrorBanner error={error} onClose={() => setError(null)} />
      <input
        className="input"
        placeholder="Buscar por e-mail"
        value={filtro}
        onChange={(e) => setFiltro(e.target.value)}
        style={{ width: "100%", marginBottom: 12 }}
      />
      <p className="sub">
        {users.length} usuários · {users.filter((u) => u.tem_acesso && !u.is_admin).length} com acesso ativo
      </p>
      <ul className="list">
        {lista.map((u) => (
          <li key={u.id} className="card" style={{ display: "block" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              <strong style={{ wordBreak: "break-all" }}>{u.email}</strong>
              {u.is_admin && <span className="pill">admin</span>}
              {u.bloqueado && <span className="pill st-danger">bloqueado</span>}
              {!u.is_admin && (
                <span className={`pill ${u.tem_acesso ? "st-ok" : "pill-muted"}`}>{u.tem_acesso ? "com acesso" : "sem acesso"}</span>
              )}
            </div>
            {!u.is_admin && (
              <>
                <p className="sub" style={{ margin: "6px 0" }}>
                  Plano: {u.plano ?? "—"} · Stripe: {u.assinatura_status ?? "—"} · renova: {dataBR(u.periodo_fim)} · cortesia até:{" "}
                  {dataBR(u.acesso_manual_ate)}
                  <br />
                  Uso: {u.uso.videos_mes} vídeos no mês · {u.uso.contas} perfis · {u.uso.calendario} na fila · {u.uso.stories_hoje} stories hoje · {u.uso.midias} mídias ({(u.uso.armazenamento_bytes / 1024 ** 3).toFixed(2)} GB)
                </p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <select className="input" value={u.plano ?? ""} onChange={(e) => e.target.value && upd(u.id, { plano: e.target.value })}>
                    <option value="">Plano…</option>
                    {PLANOS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.nome}
                      </option>
                    ))}
                  </select>
                  <button className="btn" disabled={!u.plano} onClick={() => upd(u.id, { dias_acesso_manual: 30 })}>
                    Liberar 30 dias grátis
                  </button>
                  {u.acesso_manual_ate && (
                    <button className="btn" onClick={() => upd(u.id, { dias_acesso_manual: 0 })}>
                      Remover cortesia
                    </button>
                  )}
                  <button className="btn" onClick={() => upd(u.id, { bloqueado: !u.bloqueado })}>
                    {u.bloqueado ? "Desbloquear" : "Bloquear"}
                  </button>
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
