"use client";

import type { PlanningDay, Slot } from "@/lib/resamania/types";

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function PlanningGrid({
  planning,
  onBook,
}: {
  planning: PlanningDay;
  onBook: (slot: Slot) => void;
}) {
  // Lignes = horaires distincts triés ; colonnes = terrains.
  const times = [...new Set(planning.slots.map((s) => s.startsAt))].sort();
  const byKey = new Map(
    planning.slots.map((s) => [s.courtId + "|" + s.startsAt, s]),
  );
  const now = Date.now();

  if (planning.courts.length === 0) {
    return <p className="muted">Aucun créneau ce jour-là.</p>;
  }

  return (
    <div className="grid-wrap">
      <table className="planning">
        <thead>
          <tr>
            <th className="time">Heure</th>
            {planning.courts.map((c) => (
              <th key={c.id}>{c.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {times.map((t) => (
            <tr key={t}>
              <th className="time">{fmtTime(t)}</th>
              {planning.courts.map((c) => {
                const slot = byKey.get(c.id + "|" + t);
                if (!slot) return <td key={c.id} className="cell closed" />;
                if (slot.mine) {
                  return (
                    <td key={c.id} className="cell mine" title="Ta réservation (annulable depuis le journal)">
                      ★ {slot.bookedBy}
                    </td>
                  );
                }
                if (slot.bookedBy) {
                  return (
                    <td key={c.id} className="cell group" title={`Réservé par ${slot.bookedBy} (asso)`}>
                      👥 {slot.bookedBy}
                    </td>
                  );
                }
                if (slot.bookable) {
                  const past = new Date(slot.startsAt).getTime() < now;
                  if (past) {
                    return (
                      <td key={c.id} className="cell past" title="Créneau passé">
                        —
                      </td>
                    );
                  }
                  return (
                    <td
                      key={c.id}
                      className="cell free"
                      title="Cliquer pour réserver"
                      onClick={() => onBook(slot)}
                    >
                      Libre
                    </td>
                  );
                }
                return (
                  <td key={c.id} className="cell booked" title="Réservé (hors groupe)">
                    Réservé
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
