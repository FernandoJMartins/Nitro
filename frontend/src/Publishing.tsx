import { useEffect, useState } from "react";
import Accounts from "./Accounts";
import Approval from "./Approval";
import Calendar from "./Calendar";
import PublishDashboard from "./PublishDashboard";
import { listContent } from "./api";

type SubTab = "dashboard" | "aprovacao" | "calendario" | "contas";

const TABS: { id: SubTab; label: string; icon: string }[] = [
  { id: "dashboard", label: "Visão geral", icon: "📊" },
  { id: "aprovacao", label: "Aprovação", icon: "✅" },
  { id: "calendario", label: "Calendário", icon: "📅" },
  { id: "contas", label: "Contas", icon: "👤" },
];

export default function Publishing() {
  const [tab, setTab] = useState<SubTab>("dashboard");
  const [pendentes, setPendentes] = useState(0);

  // contador da fila de aprovação (badge na aba), atualizado a cada 30s
  useEffect(() => {
    const load = () =>
      listContent("pendente")
        .then((c) => setPendentes(c.length))
        .catch(() => {});
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, []);

  return (
    <>
      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "tab active" : "tab"}
            onClick={() => setTab(t.id)}
          >
            <span style={{ marginRight: 6 }}>{t.icon}</span>
            {t.label}
            {t.id === "aprovacao" && pendentes > 0 && <span className="tab-count">{pendentes}</span>}
          </button>
        ))}
      </nav>

      {tab === "dashboard" && <PublishDashboard />}
      {tab === "aprovacao" && <Approval />}
      {tab === "calendario" && <Calendar />}
      {tab === "contas" && <Accounts />}
    </>
  );
}
