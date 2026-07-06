"use client";

import { useEffect, useState, type KeyboardEvent } from "react";
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
  onBookMany,
  selMode,
  setSelMode,
}: {
  planning: PlanningDay;
  onBook: (slot: Slot) => void;
  onCancelMine: (slot: Slot) => void;
  onTogglePresence: (slot: Slot) => void;
  onBookMany: (slots: Slot[]) => void;
  // Mode « Sélection » piloté par la page (bouton dans la barre de vue).
  selMode: boolean;
  setSelMode: (v: boolean) => void;
}) {
  // On coche des créneaux libres (un seul terrain par horaire, règle ResaMania), puis on
  // réserve tout d'un coup. La sélection se vide dès qu'on quitte le mode.
  const [selected, setSelected] = useState<Set<string>>(new Set()); // ids de slots
  useEffect(() => {
    if (!selMode) setSelected(new Set());
  }, [selMode]);

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

  // Je joue déjà (résa « à moi ») à cet horaire ? → l'autre terrain n'est pas réservable.
  const timeHasMine = (t: string) =>
    planning.slots.some((s) => s.startsAt === t && s.mine);

  // Coche/décoche un créneau (radio par horaire : au plus un terrain à la même heure).
  const toggleSel = (slot: Slot) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(slot.id)) {
        n.delete(slot.id);
        return n;
      }
      for (const s of planning.slots)
        if (s.startsAt === slot.startsAt) n.delete(s.id); // vide l'autre terrain
      n.add(slot.id);
      return n;
    });
  };
  const exitSel = () => {
    setSelMode(false);
    setSelected(new Set());
  };
  const bookSelected = () => {
    const slots = planning.slots
      .filter((s) => selected.has(s.id))
      .sort((a, b) =>
        a.startsAt === b.startsAt
          ? a.courtName.localeCompare(b.courtName)
          : a.startsAt.localeCompare(b.startsAt),
      );
    if (slots.length) onBookMany(slots);
    exitSel();
  };

  return (
    <>
      {selMode && (
        <p className="muted tiny selmode-hint">
          Touche les créneaux libres à réserver (un seul terrain par horaire).
        </p>
      )}

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
                      // En mode sélection, la case est inerte (pas d'annulation accidentelle).
                      return (
                        <td
                          key={c.id}
                          className="cell mine"
                          {...(selMode
                            ? {}
                            : {
                                role: "button" as const,
                                tabIndex: 0,
                                title: "Ta réservation — cliquer pour annuler",
                                onClick: () => onCancelMine(slot),
                                onKeyDown: onKey(() => onCancelMine(slot)),
                              })}
                        >
                          <span className="booker">★ {slot.bookedBy}</span>
                          <AttendeeList names={slot.attendees ?? []} />
                        </td>
                      );
                    }
                    if (slot.bookedBy) {
                      const attending = slot.iAmAttending ?? false;
                      const canToggle =
                        !selMode && new Date(slot.startsAt).getTime() >= now;
                      const cls =
                        "cell group" + (attending ? " attending" : "");
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
                          <td
                            key={c.id}
                            className="cell past"
                            title="Créneau passé"
                          >
                            —
                          </td>
                        );
                      }
                      // Mode sélection : on coche (si aucun de mes créneaux au même horaire) ;
                      // mode normal : réservation directe.
                      const isSel = selected.has(slot.id);
                      const canSel = !timeHasMine(slot.startsAt);
                      const act = selMode
                        ? canSel
                          ? () => toggleSel(slot)
                          : undefined
                        : () => onBook(slot);
                      return (
                        <td
                          key={c.id}
                          className={"cell free" + (isSel ? " selcell" : "")}
                          {...(act
                            ? {
                                role: "button" as const,
                                tabIndex: 0,
                                onClick: act,
                                onKeyDown: onKey(act),
                              }
                            : {})}
                          aria-pressed={selMode ? isSel : undefined}
                          title={
                            selMode
                              ? canSel
                                ? "Sélectionner ce terrain"
                                : "Tu joues déjà à cet horaire — un seul terrain à la fois"
                              : "Cliquer pour réserver"
                          }
                        >
                          {isSel ? "✓" : "Libre"}
                        </td>
                      );
                    }
                    return (
                      <td
                        key={c.id}
                        className="cell booked"
                        title="Réservé (hors groupe)"
                      >
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

      {/* Barre d'action collante quand des créneaux sont sélectionnés. */}
      {selMode && selected.size > 0 && (
        <div className="wk-actionbar">
          <span>
            {selected.size} créneau{selected.size > 1 ? "x" : ""} sélectionné
            {selected.size > 1 ? "s" : ""}
          </span>
          <button type="button" onClick={bookSelected}>
            Réserver
          </button>
        </div>
      )}
    </>
  );
}
