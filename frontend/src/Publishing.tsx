import { useState } from "react";
import Accounts from "./Accounts";
import Approval from "./Approval";
import Calendar from "./Calendar";
import PublishDashboard from "./PublishDashboard";

type SubTab = "dashboard" | "aprovacao" | "contas" | "calendario";

export default function Publishing() {
  const [tab, setTab] = useState<SubTab>("dashboard");

  return (
    <>
      <nav className="tabs">
        <button className={tab === "dashboard" ? "tab active" : "tab"} onClick={() => setTab("dashboard")}>
          Dashboard
        </button>
        <button className={tab === "aprovacao" ? "tab active" : "tab"} onClick={() => setTab("aprovacao")}>
          Aprovação
        </button>
        <button className={tab === "calendario" ? "tab active" : "tab"} onClick={() => setTab("calendario")}>
          Calendário
        </button>
        <button className={tab === "contas" ? "tab active" : "tab"} onClick={() => setTab("contas")}>
          Contas
        </button>
      </nav>

      {tab === "dashboard" && <PublishDashboard />}
      {tab === "aprovacao" && <Approval />}
      {tab === "calendario" && <Calendar />}
      {tab === "contas" && <Accounts />}
    </>
  );
}
