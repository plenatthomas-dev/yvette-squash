"use client";

import type { KeyboardEvent } from "react";
import type { PlanningDay, Slot } from "@/lib/resamania/types";
import { fmtTime } from "@/lib/time";

// Déclenche l'action au clavier (Entrée / Espace) sur les cellules cliquables.
function onKey(fn: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  };
}

// Prénoms des membres « présents » (hors réservataire). Passent à la ligne ; au-delà de
// 3, on tronque à 4 lettres pour tenir dans la case (liste complète dans l'infobulle).
function AttendeeList({ names }: { names: string[] }) {
  if (!names.length) return null;
  const short = names.length >= 3;
  return (
    <span className="attendees" title={names.join(", ")}>
      {names.map((n, i) => (
        <span className="att" key={i}>
          {short ? n.slice(0, 4) : n}
        </span>
      ))}
    </span>
  );
}

export function PlanningGrid({
  planning,
  onBook,
  onCancelMine,
  onTogglePresence,
}: {
  planning: PlanningDay;
  onBook: (slot: Slot) => void;
  onCancelMine: (slot: Slot) => void;
  onTogglePresence: (slot: Slot) => void;
}) {
  // Lignes = horaires distincts triés ; colonnes = terrains.
  const times = [...new Set(planning.slots.map((s) => s.startsAt))].sort();
  const byKey = new Map(
    planning.slots.map((s) => [s.courtId + "|" + s.startsAt, s]),
  );
  // Fin du créneau pour chaque horaire (pour afficher « début – fin »).
  const endByTime = new Map(planning.slots.map((s) => [s.startsAt, s.endsAt]));
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
          {times.map((t) => {
            const end = endByTime.get(t);
            return (
              <tr key={t}>
                <th className="time">
                  <span className="t-start">{fmtTime(t)}</span>
                  {end && <span className="t-end">{fmtTime(end)}</span>}
                </th>
                {planning.courts.map((c) => {
                  const slot = byKey.get(c.id + "|" + t);
                  if (!slot) return <td key={c.id} className="cell closed" />;
                  if (slot.mine) {
                    return (
                      <td
                        key={c.id}
                        className="cell mine"
                        role="button"
                        tabIndex={0}
                        title="Ta réservation — cliquer pour annuler"
                        onClick={() => onCancelMine(slot)}
                        onKeyDown={onKey(() => onCancelMine(slot))}
                      >
                        <span className="booker">★ {slot.bookedBy}</span>
                        <AttendeeList names={slot.attendees ?? []} />
                      </td>
                    );
                  }
                  if (slot.bookedBy) {
                    const attending = slot.iAmAttending ?? false;
                    const canToggle = new Date(slot.startsAt).getTime() >= now;
                    const cls = "cell group" + (attending ? " attending" : "");
                    const title = canToggle
                      ? attending
                        ? `Réservé par ${slot.bookedBy} — clique pour retirer ta présence`
                        : `Réservé par ${slot.bookedBy} — clique pour signaler ta présence`
                      : `Réservé par ${slot.bookedBy} (asso)`;
                    const content = (
                      <>
                        <span className="booker">👥 {slot.bookedBy}</span>
                        <AttendeeList names={slot.attendees ?? []} />
                      </>
                    );
                    if (!canToggle) {
                      return (
                        <td key={c.id} className={cls} title={title}>
                          {content}
                        </td>
                      );
                    }
                    return (
                      <td
                        key={c.id}
                        className={cls}
                        role="button"
                        tabIndex={0}
                        aria-pressed={attending}
                        title={title}
                        onClick={() => onTogglePresence(slot)}
                        onKeyDown={onKey(() => onTogglePresence(slot))}
                      >
                        {content}
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
                        role="button"
                        tabIndex={0}
                        title="Cliquer pour réserver"
                        onClick={() => onBook(slot)}
                        onKeyDown={onKey(() => onBook(slot))}
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
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
