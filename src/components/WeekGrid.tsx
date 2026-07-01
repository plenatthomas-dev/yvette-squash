"use client";

import type { PlanningDay } from "@/lib/resamania/types";

function shortDay(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString("fr-FR", {
    weekday: "short",
    day: "numeric",
  });
}

// Aperçu semaine : lignes = horaires, colonnes = jours. Chaque cellule montre le
// nombre de terrains LIBRES (vert) ; cliquer ouvre la journée pour réserver.
export function WeekGrid({
  days,
  filter,
  onPick,
}: {
  days: { date: string; planning: PlanningDay }[];
  filter: (iso: string) => boolean;
  onPick: (date: string) => void;
}) {
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

  // date -> (HH:MM -> { free, total, past })
  const idx = new Map<string, Map<string, { free: number; total: number; past: boolean }>>();
  for (const d of days) {
    const m = new Map<string, { free: number; total: number; past: boolean }>();
    for (const s of d.planning.slots) {
      const hm = s.startsAt.slice(11, 16);
      const cur = m.get(hm) ?? { free: 0, total: 0, past: false };
      cur.total += 1;
      const past = new Date(s.startsAt).getTime() < now;
      if (s.bookable && !past) cur.free += 1;
      if (past) cur.past = true;
      m.set(hm, cur);
    }
    idx.set(d.date, m);
  }

  return (
    <div className="grid-wrap">
      <table className="planning week">
        <thead>
          <tr>
            <th className="time">Heure</th>
            {days.map((d) => (
              <th
                key={d.date}
                className={d.date === todayStr ? "today" : ""}
                onClick={() => onPick(d.date)}
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
                if (cell.free > 0) {
                  return (
                    <td
                      key={d.date}
                      className="cell free"
                      title={`${cell.free} terrain(s) libre(s) — voir la journée`}
                      onClick={() => onPick(d.date)}
                    >
                      {cell.free}
                    </td>
                  );
                }
                return (
                  <td
                    key={d.date}
                    className={"cell " + (cell.past ? "past" : "booked")}
                    onClick={() => onPick(d.date)}
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
  );
}
