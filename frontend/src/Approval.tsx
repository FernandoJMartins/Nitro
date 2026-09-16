import { useEffect, useMemo, useState } from "react";
import {
  BookImage,
  CalendarClock,
  CalendarDays,
  Check,
  CheckCircle2,
  Clapperboard,
  Clock,
  FileDown,
  FileText,
  History,
  Package,
  RefreshCw,
  X,
  XCircle,
} from "lucide-react";
import { Modal } from "./Dialog";
import {
  approveAllContent,
  approveContent,
  editContent,
  importFromGenerator,
  isEligibleAccount,
  listAccounts,
  listContent,
  listImportable,
  redistributeContent,
  rejectAllContent,
  rejectContent,
  scheduleContent,
  videoDownloadUrl,
  type ApprovalStatus,
  type ImportableVideo,
  type PubAccount,
  type PubContent,
} from "./api";

type LoteGroup = { key: string; job_id: number | null; videos: ImportableVideo[] };
type DayGroup = { dia: string; lotes: LoteGroup[] };

// Agrupa por dia (mais recente primeiro) e, dentro de cada dia, por lote (job_id) —
// mesma lógica do Histórico. Clicar num lote abre o modal de seleção de vídeos.
function groupByDayAndLote(items: ImportableVideo[]): DayGroup[] {
  const days: DayGroup[] = [];
  for (const v of items) {
    const dia = new Date(v.criado_em).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
    let day = days.find((d) => d.dia === dia);
    if (!day) {
      day = { dia, lotes: [] };
      days.push(day);
    }
    const key = v.job_id != null ? `lote-${v.job_id}` : `sem-lote-${dia}`;
    let lote = day.lotes.find((l) => l.key === key);
    if (!lote) {
      lote = { key, job_id: v.job_id, videos: [] };
      day.lotes.push(lote);
    }
    lote.videos.push(v);
  }
  for (const day of days) {
    day.lotes.sort((a, b) => (b.job_id ?? -1) - (a.job_id ?? -1));
  }
  return days;
}

function LoteImportModal({
  lote,
  accounts,
  onClose,
  onImported,
}: {
  lote: LoteGroup;
  accounts: PubAccount[];
  onClose: () => void;
  onImported: () => void;
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set(lote.videos.map((v) => v.id)));
  // perfis destino — default: todas as contas aptas (mesmo comportamento de antes)
  const [profiles, setProfiles] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    setProfiles(new Set(accounts.filter(isEligibleAccount).map((a) => a.id)));
  }, [accounts]);

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleProfile(id: number) {
    setProfiles((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function confirmar() {
    if (selected.size === 0) return;
    if (accounts.length > 0 && profiles.size === 0) {
      setError("Selecione ao menos um perfil para receber os vídeos.");
      return;
    }
    setImporting(true);
    setError(null);
    try {
      await importFromGenerator([...selected], { account_ids: accounts.length ? [...profiles] : null });
      onImported();
      onClose();
    } catch (e) {
      setError(String(e));
      setImporting(false);
    }
  }

  return (
    <Modal title={lote.job_id != null ? `Lote #${lote.job_id}` : "Vídeos sem lote"} onClose={onClose} wide>
      {error && <div className="error">⚠️ {error}</div>}
      <div className="modal-actions" style={{ justifyContent: "space-between", marginTop: 0 }}>
        <span className="hint">
          {selected.size} de {lote.videos.length} selecionado(s)
        </span>
        <button
          className="btn sm"
          onClick={() =>
            setSelected(selected.size === lote.videos.length ? new Set() : new Set(lote.videos.map((v) => v.id)))
          }
        >
          {selected.size === lote.videos.length ? "Desmarcar todos" : "Selecionar todos"}
        </button>
      </div>
      <ul className="import-grid">
        {lote.videos.map((v) => (
          <li key={v.id} className={selected.has(v.id) ? "vcard selected" : "vcard"}>
            <label className="vsel">
              <input type="checkbox" checked={selected.has(v.id)} onChange={() => toggle(v.id)} />
            </label>
            <video src={videoDownloadUrl(v.id)} controls preload="metadata" />
            <div className="vmeta">
              <div className="meta">{v.duracao ?? "?"}s</div>
              {v.legenda && (
                <div className="vlegenda">
                  <FileText size={12} /> {v.legenda}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
      <div className="field" style={{ marginTop: 14 }}>
        <span>
          Perfis que receberão os vídeos ({profiles.size} de {accounts.length})
        </span>
        {accounts.length === 0 ? (
          <div className="hint" style={{ fontWeight: 400 }}>
            Nenhuma conta cadastrada — os vídeos entram na fila de aprovação sem conta atribuída (cadastre em Contas).
          </div>
        ) : (
          <>
            <div className="checkrow" style={{ gap: 8, marginTop: 6 }}>
              <button type="button" className="linkbtn" onClick={() => setProfiles(new Set(accounts.map((a) => a.id)))}>
                Todos
              </button>
              <button
                type="button"
                className="linkbtn"
                onClick={() => setProfiles(new Set(accounts.filter(isEligibleAccount).map((a) => a.id)))}
              >
                Apenas aptas
              </button>
              <button type="button" className="linkbtn" onClick={() => setProfiles(new Set())}>
                Nenhum
              </button>
            </div>
            <div className="checklist" style={{ marginTop: 6 }}>
              {accounts.map((a) => (
                <label key={a.id} className={profiles.has(a.id) ? "chk picked" : "chk"}>
                  <input
                    type="checkbox"
                    checked={profiles.has(a.id)}
                    disabled={!a.ativa}
                    onChange={() => toggleProfile(a.id)}
                  />
                  <span className="chk-name">@{a.username}</span>
                  {!a.ativa ? (
                    <span className="hint" style={{ fontWeight: 400 }}>(desativada)</span>
                  ) : a.status !== "pronta" || a.automation_status === "pausada" ? (
                    <span className="hint" style={{ fontWeight: 400 }}>
                      ({a.status === "pronta" ? "automação pausada" : a.status})
                    </span>
                  ) : null}
                </label>
              ))}
            </div>
          </>
        )}
      </div>
      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>
          Cancelar
        </button>
        <button className="btn primary" onClick={confirmar} disabled={selected.size === 0 || importing}>
          <FileDown size={14} /> {importing ? "Importando…" : `Importar e distribuir (${selected.size})`}
        </button>
      </div>
    </Modal>
  );
}

function ImportPanel({ onImported, accounts }: { onImported: () => void; accounts: PubAccount[] }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ImportableVideo[]>([]);
  const [openLote, setOpenLote] = useState<LoteGroup | null>(null);
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    listImportable().then(setItems).catch((e) => setError(String(e)));
  }

  useEffect(() => {
    if (open) refresh();
  }, [open]);

  const days = useMemo(() => groupByDayAndLote(items), [items]);

  // importou: fecha TODOS os modais sozinho (lote + histórico) e atualiza a fila
  function handleImported() {
    setOpenLote(null);
    setOpen(false);
    onImported();
  }

  return (
    <>
      <div className="selbar" style={{ marginBottom: 12 }}>
        <button className="btn sm" onClick={() => setOpen(true)}>
          <History size={14} /> Importar do histórico
        </button>
        <span className="hint">
          Importa vídeos da geração em massa e distribui entre os perfis escolhidos (padrão: todos os aptos) — o
          modal fecha sozinho ao importar.
        </span>
      </div>

      {open && (
        <Modal title="Importar do histórico — por lote" onClose={() => setOpen(false)} wide scroll>
          {error && <div className="error">⚠️ {error}</div>}
          {days.length === 0 ? (
            <div className="empty">Nenhum vídeo novo no histórico para importar.</div>
          ) : (
            days.map((day) => (
              <div key={day.dia} className="day-group">
                <div className="day-header">
                  <CalendarDays size={14} /> {day.dia}
                </div>
                <ul className="list" style={{ marginTop: 8 }}>
                  {day.lotes.map((l) => (
                    <li key={l.key} className="card">
                      <div className="card-main">
                        <strong>
                          <Package size={14} /> {l.job_id != null ? `Lote #${l.job_id}` : "Sem lote"}
                        </strong>
                        <div className="meta">{l.videos.length} vídeo(s)</div>
                      </div>
                      <div className="card-actions">
                        <button className="btn primary sm" onClick={() => setOpenLote(l)}>
                          Selecionar vídeos
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )}
        </Modal>
      )}

      {openLote && (
        <LoteImportModal lote={openLote} accounts={accounts} onClose={() => setOpenLote(null)} onImported={handleImported} />
      )}
    </>
  );
}

function toLocalInput(dt: string | null): string {
  // converte ISO (UTC) para o formato do <input type="datetime-local"> no fuso do navegador
  if (!dt) return "";
  const d = new Date(dt);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ContentCard({
  content,
  accounts,
  onChange,
  selectable,
  selected,
  onToggleSelect,
}: {
  content: PubContent;
  accounts: PubAccount[];
  onChange: () => void;
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const [legenda, setLegenda] = useState(content.legenda ?? "");
  const [agendando, setAgendando] = useState(false);
  const [quando, setQuando] = useState(toLocalInput(content.scheduled_at));
  const [salvandoAgendamento, setSalvandoAgendamento] = useState(false);
  const [erroAgendamento, setErroAgendamento] = useState<string | null>(null);
  const account = accounts.find((a) => a.id === content.account_id);

  async function salvarLegenda() {
    await editContent(content.id, { legenda });
    onChange();
  }

  async function mudarConta(id: number) {
    await editContent(content.id, { account_id: id });
    onChange();
  }

  async function salvarAgendamento() {
    if (!quando) return;
    setSalvandoAgendamento(true);
    setErroAgendamento(null);
    try {
      await scheduleContent(content.id, new Date(quando).toISOString());
      setAgendando(false);
      onChange();
    } catch (e) {
      setErroAgendamento(String(e));
    } finally {
      setSalvandoAgendamento(false);
    }
  }

  return (
    <li className={selected ? "vcard selected" : "vcard"}>
      {selectable && (
        <label className="vsel">
          <input type="checkbox" checked={!!selected} onChange={onToggleSelect} />
        </label>
      )}
      {content.origem === "gerador" && content.generated_video_id != null ? (
        <video src={videoDownloadUrl(content.generated_video_id)} controls preload="metadata" />
      ) : (
        <div className="mini-music" style={{ width: "100%", aspectRatio: "9/16", background: "#000" }}>
          <Clapperboard size={28} color="#666" />
        </div>
      )}
      <div className="vmeta">
        <div className="meta">
          {content.kind === "story" ? (
            <>
              <BookImage size={13} /> Story
            </>
          ) : (
            <>
              <Clapperboard size={13} /> Reel
            </>
          )}{" "}
          · {content.duracao ?? "?"}s ·{" "}
          {content.scheduled_at ? new Date(content.scheduled_at).toLocaleString("pt-BR") : "sem horário ainda"}
        </div>

        {content.approval_status === "pendente" ? (
          <>
            <select value={content.account_id ?? ""} onChange={(e) => e.target.value && mudarConta(Number(e.target.value))}>
              <option value="">Sem conta atribuída</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  @{a.username}
                </option>
              ))}
            </select>
            <textarea
              className="vtext-edit"
              value={legenda}
              onChange={(e) => setLegenda(e.target.value)}
              onBlur={salvarLegenda}
              placeholder="Legenda (opcional — vazio usa a legenda automática do perfil)"
              rows={2}
              style={{ width: "100%", marginTop: 6 }}
            />
            <div className="card-actions" style={{ marginTop: 8 }}>
              <button className="btn primary sm" onClick={() => approveContent([content.id]).then(onChange)}>
                <Check size={14} /> Aprovar
              </button>
              <button className="btn danger sm" onClick={() => rejectContent([content.id]).then(onChange)}>
                <X size={14} /> Rejeitar
              </button>
              <button className="btn sm" onClick={() => redistributeContent(content.id).then(onChange)}>
                <RefreshCw size={13} /> Redistribuir
              </button>
            </div>
          </>
        ) : (
          <>
            {content.legenda && (
              <div className="vlegenda">
                <FileText size={12} /> {content.legenda}
              </div>
            )}
            <div className="meta">
              {account ? `@${account.username}` : "sem conta"} ·{" "}
              <span className={content.approval_status === "aprovado" ? "badge" : "badge ia"}>
                {content.approval_status}
              </span>
              {content.schedule_mode === "especifico" && (
                <>
                  {" "}
                  · <Clock size={12} /> horário manual
                </>
              )}
            </div>
            {content.approval_status === "aprovado" && (
              <>
                <div className="card-actions" style={{ marginTop: 8 }}>
                  <button className="btn sm" onClick={() => setAgendando((v) => !v)}>
                    <CalendarClock size={14} /> Programar manualmente
                  </button>
                </div>
                {agendando && (
                  <div className="checkrow" style={{ gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                    <input type="datetime-local" value={quando} onChange={(e) => setQuando(e.target.value)} />
                    <button
                      className="btn primary sm"
                      disabled={!quando || salvandoAgendamento}
                      onClick={salvarAgendamento}
                    >
                      {salvandoAgendamento ? "Salvando…" : "Salvar horário"}
                    </button>
                    {erroAgendamento && (
                      <span className="hint" style={{ color: "var(--danger)" }}>
                        ⚠ {erroAgendamento}
                      </span>
                    )}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </li>
  );
}

export default function Approval() {
  const [status, setStatus] = useState<ApprovalStatus>("pendente");
  const [items, setItems] = useState<PubContent[]>([]);
  const [accounts, setAccounts] = useState<PubAccount[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);

  function refresh() {
    listContent(status).then(setItems).catch((e) => setError(String(e)));
    listAccounts().then(setAccounts).catch(() => {});
  }

  useEffect(refresh, [status]);

  const pendentesIds = useMemo(() => items.filter((i) => i.approval_status === "pendente").map((i) => i.id), [items]);

  return (
    <>
      <p className="sub">Fila de aprovação: revise, distribua e aprove antes de agendar a publicação.</p>
      {error && <div className="error">⚠️ {error}</div>}

      <ImportPanel onImported={refresh} accounts={accounts} />

      <nav className="tabs">
        <button className={status === "pendente" ? "tab active" : "tab"} onClick={() => setStatus("pendente")}>
          <Clock size={14} /> Pendentes
        </button>
        <button className={status === "aprovado" ? "tab active" : "tab"} onClick={() => setStatus("aprovado")}>
          <CheckCircle2 size={14} /> Aprovados
        </button>
        <button className={status === "rejeitado" ? "tab active" : "tab"} onClick={() => setStatus("rejeitado")}>
          <XCircle size={14} /> Rejeitados
        </button>
      </nav>

      {status === "pendente" && items.length > 0 && (
        <div className="selbar">
          <span>{items.length} pendente(s)</span>
          <button className="btn primary sm" onClick={() => approveAllContent().then(refresh)}>
            <Check size={14} /> Aprovar todos
          </button>
          <button className="btn danger sm" onClick={() => rejectAllContent().then(refresh)}>
            <X size={14} /> Rejeitar todos
          </button>
          {selected.size > 0 && (
            <button className="btn sm" onClick={() => approveContent([...selected]).then(() => { setSelected(new Set()); refresh(); })}>
              <Check size={14} /> Aprovar selecionados ({selected.size})
            </button>
          )}
        </div>
      )}

      {items.length === 0 && <div className="empty">Nada por aqui.</div>}

      <ul className="grid">
        {items.map((c) => (
          <ContentCard
            key={c.id}
            content={c}
            accounts={accounts}
            onChange={refresh}
            selectable={status === "pendente"}
            selected={selected.has(c.id)}
            onToggleSelect={() =>
              setSelected((prev) => {
                const next = new Set(prev);
                next.has(c.id) ? next.delete(c.id) : next.add(c.id);
                return next;
              })
            }
          />
        ))}
      </ul>
      {pendentesIds.length === 0 && status === "pendente" && items.length > 0 && (
        <div className="hint">Todos os itens visíveis já foram processados — atualize a lista.</div>
      )}
    </>
  );
}
