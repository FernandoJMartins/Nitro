import { useEffect, useMemo, useState, type DragEvent } from "react";
import {
  cancelPublications,
  getCalendar,
  postNowPublications,
  reschedulePublication,
  type CalendarItem,
  type PublicationStatus,
} from "./api";

type View = "day" | "week" | "month";

const STATUS_ICON: Record<PublicationStatus, string> = {
  PENDING: "⏰",
  UPLOADING: "⏳",
  PROCESSING: "⏳",
  PUBLISHED: "✓",
  FAILED: "⚠",
  RETRYING: "↻",
  CANCELLED: "✕",
};

const DAY_LABEL = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function iso(d: Date): string {
  return d.toISOString();
}
function keyOf(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/** Cor estável por conta — indica visualmente a conta responsável pela publicação. */
function accountColor(username: string): string {
  let h = 0;
  for (let i = 0; i < username.length; i++) h = (h * 31 + username.charCodeAt(i)) % 360;
  return `hsl(${h}, 55%, 45%)`;
}

function ItemChip({
  item,
  draggable,
  selectable,
  selected,
  onDragStart,
  onDragEnd,
  onToggle,
}: {
  item: CalendarItem;
  draggable: boolean;
  selectable: boolean;
  selected: boolean;
  onDragStart: (e: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  onToggle: () => void;
}) {
  const color = accountColor(item.account_username);
  const when = new Date(item.scheduled_at);
  return (
    <div
      className={`cal-chip ${draggable ? "draggable" : ""} ${selected ? "selected" : ""} st-${item.status.toLowerCase()}`}
      draggable={draggable}
      onClick={() => selectable && onToggle()}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      title={`${item.kind} · ${item.status} · @${item.account_username}\n${when.toLocaleString("pt-BR")}`}
    >
      <span className="cal-dot" style={{ background: color }} />
      <span className="cal-icon">{STATUS_ICON[item.status]}</span>
      <span className="cal-acc">@{item.account_username}</span>
      <span className="cal-kind">{item.kind === "story" ? "📖" : "🎬"}</span>
      <span className="cal-time">{when.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</span>
    </div>
  );
}

export default function Calendar() {
  const [view, setView] = useState<View>("week");
  const [anchor, setAnchor] = useState<Date>(new Date());
  const [items, setItems] = useState<CalendarItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  // selecionáveis: pendentes/retry/falhas — publicado e em execução não dá para mexer
  const selectable = (s: PublicationStatus) => s === "PENDING" || s === "RETRYING" || s === "FAILED";

  function toggle(c: CalendarItem) {
    if (!selectable(c.status)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(c.publication_id)) next.delete(c.publication_id);
      else next.add(c.publication_id);
      return next;
    });
  }

  async function desprogramar() {
    if (selected.size === 0) return;
    if (!confirm(`Desprogramar ${selected.size} publicação(ões)? O conteúdo volta para a fila de aprovação.`)) return;
    setBusy("cancel");
    try {
      await cancelPublications([...selected]);
      setSelected(new Set());
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function postarAgora() {
    if (selected.size === 0) return;
    if (!confirm(`Postar ${selected.size} publicação(ões) AGORA na conta?`)) return;
    setBusy("now");
    try {
      await postNowPublications([...selected]);
      setSelected(new Set());
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  const firstDay = useMemo(() => {
    if (view === "month") {
      const d = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
      return addDays(d, -d.getDay());
    }
    if (view === "week") return addDays(startOfDay(anchor), -anchor.getDay());
    return startOfDay(anchor);
  }, [view, anchor]);

  const lastDay = useMemo(() => {
    if (view === "month") return addDays(firstDay, 42);
    if (view === "week") return addDays(firstDay, 7);
    return addDays(firstDay, 1);
  }, [view, firstDay]);

  function refresh() {
    getCalendar(iso(firstDay), iso(lastDay)).then(setItems).catch((e) => setError(String(e)));
  }
  useEffect(refresh, [firstDay, lastDay]);

  function moveAnchor(dir: number) {
    if (view === "month") setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + dir, 1));
    else setAnchor(addDays(anchor, dir * (view === "week" ? 7 : 1)));
  }

  function byKey(): Map<string, CalendarItem[]> {
    const map = new Map<string, CalendarItem[]>();
    for (const i of items) {
      const k = keyOf(new Date(i.scheduled_at));
      map.set(k, [...(map.get(k) ?? []), i]);
    }
    return map;
  }

  const grouped = byKey();
  const monthDays = useMemo(() => {
    if (view !== "month") return [];
    return Array.from({ length: 42 }, (_, i) => addDays(firstDay, i));
  }, [view, firstDay]);
  const weekDays = useMemo(() => {
    if (view !== "week") return [];
    return Array.from({ length: 7 }, (_, i) => addDays(firstDay, i));
  }, [view, firstDay]);

  function handleDrop(e: DragEvent<HTMLDivElement>, day: Date, hour: number | null) {
    e.preventDefault();
    const pubId = Number(e.dataTransfer.getData("text/plain"));
    setDragging(null);
    const item = items.find((i) => i.publication_id === pubId);
    if (!item || !(item.status === "PENDING" || item.status === "RETRYING")) return;
    const original = new Date(item.scheduled_at);
    const novo = new Date(day);
    if (hour === null) {
      // mês: mantém o horário, muda só o dia
      novo.setHours(original.getHours(), original.getMinutes(), 0, 0);
    } else {
      // dia/semana: usa a hora da célula, mantém os minutos
      novo.setHours(hour, original.getMinutes(), 0, 0);
    }
    reschedulePublication(pubId, novo.toISOString())
      .then(refresh)
      .catch((err) => {
        setError(String(err));
        refresh();
      });
  }

  function chipsFor(day: Date): CalendarItem[] {
    return grouped.get(keyOf(day)) ?? [];
  }

  const title =
    view === "month"
      ? anchor.toLocaleDateString("pt-BR", { month: "long", year: "numeric" })
      : `${firstDay.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} – ${addDays(
          lastDay,
          -1
        ).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}`;

  return (
    <>
      <p className="sub">
        Calendário de publicações: arraste um item para mudar a data/horário — o novo horário é salvo no backend e
        usado pela fila de execução. Cada item mostra a conta responsável.
      </p>
      {error && <div className="error">⚠️ {error}</div>}

      <div className="selbar" style={{ marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <div className="cal-nav">
          <button className="btn sm" onClick={() => moveAnchor(-1)}>
            ◀
          </button>
          <button className="btn sm" onClick={() => setAnchor(new Date())}>
            Hoje
          </button>
          <button className="btn sm" onClick={() => moveAnchor(1)}>
            ▶
          </button>
          <strong style={{ marginLeft: 8 }}>{title}</strong>
        </div>
        <div className="cal-views">
          {(["day", "week", "month"] as View[]).map((v) => (
            <button key={v} className={`btn sm ${view === v ? "primary" : ""}`} onClick={() => setView(v)}>
              {v === "day" ? "Dia" : v === "week" ? "Semana" : "Mês"}
            </button>
          ))}
        </div>
        <div className="cal-actions" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <span className="hint">
            {selected.size > 0 ? `${selected.size} selecionada(s)` : "Clique nos itens para selecionar"}
          </span>
          <button className="btn sm" onClick={postarAgora} disabled={selected.size === 0 || busy !== null}>
            ⚡ Postar agora
          </button>
          <button className="btn danger sm" onClick={desprogramar} disabled={selected.size === 0 || busy !== null}>
            ✕ Desprogramar
          </button>
        </div>
      </div>

      {view === "month" && (
        <div className="cal-month">
          {DAY_LABEL.map((d) => (
            <div key={d} className="cal-month-head">
              {d}
            </div>
          ))}
          {monthDays.map((day) => {
            const inMonth = day.getMonth() === anchor.getMonth();
            const chips = chipsFor(day);
            return (
              <div
                key={keyOf(day)}
                className={`cal-month-cell ${inMonth ? "" : "out"} ${dragging !== null ? "droptarget" : ""}`}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => handleDrop(e, day, null)}
              >
                <div className="cal-month-day">{day.getDate()}</div>
                <div className="cal-month-chips">
                  {chips.slice(0, 4).map((c) => (
                    <ItemChip
                      key={c.publication_id}
                      item={c}
                      draggable={c.status === "PENDING" || c.status === "RETRYING"}
                      selectable={selectable(c.status)}
                      selected={selected.has(c.publication_id)}
                      onToggle={() => toggle(c)}
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/plain", String(c.publication_id));
                        setDragging(c.publication_id);
                      }}
                      onDragEnd={() => setDragging(null)}
                    />
                  ))}
                  {chips.length > 4 && <div className="meta">+{chips.length - 4} mais</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {view === "week" && (
        <div className="cal-week">
          <div className="cal-week-head-row">
            <div className="cal-hour-col" />
            {weekDays.map((day) => (
              <div key={keyOf(day)} className={`cal-week-head ${day.getDay() === 0 || day.getDay() === 6 ? "wknd" : ""}`}>
                {DAY_LABEL[day.getDay()]} {day.getDate()}/{day.getMonth() + 1}
              </div>
            ))}
          </div>
          <div className="cal-week-body">
            {Array.from({ length: 24 }, (_, hour) => (
              <div key={hour} className="cal-week-row">
                <div className="cal-hour-col">{String(hour).padStart(2, "0")}:00</div>
                {weekDays.map((day) => {
                  const chips = chipsFor(day).filter((c) => new Date(c.scheduled_at).getHours() === hour);
                  return (
                    <div
                      key={keyOf(day)}
                      className="cal-hour-cell"
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => handleDrop(e, day, hour)}
                    >
                      {chips.map((c) => (
                        <ItemChip
                          key={c.publication_id}
                          item={c}
                          draggable={c.status === "PENDING" || c.status === "RETRYING"}
                          selectable={selectable(c.status)}
                          selected={selected.has(c.publication_id)}
                          onToggle={() => toggle(c)}
                          onDragStart={(e) => {
                            e.dataTransfer.setData("text/plain", String(c.publication_id));
                            setDragging(c.publication_id);
                          }}
                          onDragEnd={() => setDragging(null)}
                        />
                      ))}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}

      {view === "day" && (
        <div className="cal-day">
          <h3 style={{ marginBottom: 8 }}>{firstDay.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "2-digit" })}</h3>
          {Array.from({ length: 24 }, (_, hour) => {
            const chips = chipsFor(firstDay).filter((c) => new Date(c.scheduled_at).getHours() === hour);
            return (
              <div
                key={hour}
                className="cal-day-row"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => handleDrop(e, firstDay, hour)}
              >
                <div className="cal-hour-col">{String(hour).padStart(2, "0")}:00</div>
                <div className="cal-day-cell">
                  {chips.map((c) => (
                    <ItemChip
                      key={c.publication_id}
                      item={c}
                      draggable={c.status === "PENDING" || c.status === "RETRYING"}
                      selectable={selectable(c.status)}
                      selected={selected.has(c.publication_id)}
                      onToggle={() => toggle(c)}
                      onDragStart={(e) => {
                        e.dataTransfer.setData("text/plain", String(c.publication_id));
                        setDragging(c.publication_id);
                      }}
                      onDragEnd={() => setDragging(null)}
                    />
                  ))}
                  {chips.length === 0 && <span className="hint" />}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
