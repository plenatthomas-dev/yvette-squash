"use client";

import { useState, type KeyboardEvent } from "react";
import type { PlanningDay, Slot } from "@/lib/resamania/types";

function shortDay(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString("fr-FR", {
    weekday: "short",
    day: "numeric",
  });
}
function longDay(date: string): string {
  const s = new Date(`${date}T12:00:00`).toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  return s.charAt(0).toUpperCase() + s.slice(1);
}
// Déclenche l'action au clavier (Entrée / Espace) sur les cellules cliquables.
function onKey(fn: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  };
}

type Cell = { free: Slot[]; total: number; past: boolean };
type Sheet = { date: string; hm: string; slots: Slot[] };

// Aperçu semaine : lignes = horaires, colonnes = jours. Chaque cellule montre le
// nombre de terrains LIBRES (vert). Cliquer ouvre un petit panneau pour réserver
// directement le créneau, ou aller voir la journée complète.
export function WeekGrid({
  days,
  filter,
  onPick,
  onBook,
}: {
  days: { date: string; planning: PlanningDay }[];
  filter: (iso: string) => boolean;
  onPick: (date: string) => void;
  onBook: (slot: Slot) => void;
}) {
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const now = Date.now();
  const todayStr = new Date().toLocaleDateString("en-CA");

  // Union des horaires (HH:MM) présents, filtrés par la plage horaire choisie.
  const times = new Set<string>();
  for (const d of days) {
    for (const s of d.planning.slots) {
      if (filter(s.startsAt)) times.add(s.startsAt.slice(11, 16));
    }
  }
  const rows = [...times].sort();

  if (rows.length === 0) {
    return <p className="muted">Aucun créneau sur cette plage horaire.</p>;
  }

  // date -> (HH:MM -> { free: Slot[], total, past })
  const idx = new Map<string, Map<string, Cell>>();
  for (const d of days) {
    const m = new Map<string, Cell>();
    for (const s of d.planning.slots) {
      if (!filter(s.startsAt)) continue;
      const hm = s.startsAt.slice(11, 16);
      const cur = m.get(hm) ?? { free: [], total: 0, past: false };
      cur.total += 1;
      const past = new Date(s.startsAt).getTime() < now;
      if (s.bookable && !past) cur.free.push(s);
      if (past) cur.past = true;
      m.set(hm, cur);
    }
    idx.set(d.date, m);
  }

  const openSheet = (date: string, hm: string, slots: Slot[]) =>
    setSheet({ date, hm, slots });
  const close = () => setSheet(null);

  return (
    <>
      <div className="grid-wrap">
        <table className="planning week">
          <thead>
            <tr>
              <th className="time">Heure</th>
              {days.map((d) => (
                <th
                  key={d.date}
                  className={d.date === todayStr ? "today" : ""}
                  role="button"
                  tabIndex={0}
                  onClick={() => onPick(d.date)}
                  onKeyDown={onKey(() => onPick(d.date))}
                  title="Voir cette journée"
                >
                  {shortDay(d.date)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((hm) => (
              <tr key={hm}>
                <th className="time">{hm}</th>
                {days.map((d) => {
                  const cell = idx.get(d.date)?.get(hm);
                  if (!cell || cell.total === 0) {
                    return <td key={d.date} className="cell closed" />;
                  }
                  if (cell.free.length > 0) {
                    return (
                      <td
                        key={d.date}
                        className="cell free"
                        role="button"
                        tabIndex={0}
                        title={`${cell.free.length} terrain(s) libre(s) — réserver`}
                        onClick={() => openSheet(d.date, hm, cell.free)}
                        onKeyDown={onKey(() => openSheet(d.date, hm, cell.free))}
                      >
                        {cell.free.length}
                      </td>
                    );
                  }
                  return (
                    <td
                      key={d.date}
                      className={"cell " + (cell.past ? "past" : "booked")}
                      role="button"
                      tabIndex={0}
                      onClick={() => onPick(d.date)}
                      onKeyDown={onKey(() => onPick(d.date))}
                      title="Voir la journée"
                    >
                      {cell.past ? "—" : "0"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {sheet && (
        <div className="modal-overlay" onClick={close}>
          <div
            className="modal week-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Réserver un créneau"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>
              {longDay(sheet.date)} · {sheet.hm}
            </h3>
            <p className="muted">
              {sheet.slots.length} terrain{sheet.slots.length > 1 ? "s" : ""} libre
              {sheet.slots.length > 1 ? "s" : ""} — choisis pour réserver :
            </p>
            <div className="sheet-courts">
              {sheet.slots.map((s) => (
                <button
                  key={s.id}
                  className="sheet-court"
                  onClick={() => {
                    close();
                    onBook(s);
                  }}
                >
                  {s.courtName}
                </button>
              ))}
            </div>
            <div className="modal-actions">
              <button
                className="secondary"
                onClick={() => {
                  close();
                  onPick(sheet.date);
                }}
              >
                Voir la journée
              </button>
              <button className="secondary" onClick={close}>
                Fermer
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
