"use client";

import { useMemo, useState, type KeyboardEvent } from "react";
import type { PlanningDay, Slot } from "@/lib/resamania/types";
import { fmtTime } from "@/lib/time";

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

// État visuel d'un demi-terrain dans une case (une couleur par état, palette de la vue jour).
type Seg = "free" | "asso" | "other" | "mine" | "past" | "closed";
type CourtRef = { id: string; name: string };

function segOf(slot: Slot | null, now: number): Seg {
  if (!slot) return "closed";
  if (new Date(slot.startsAt).getTime() < now) return "past";
  if (slot.mine) return "mine";
  if (slot.bookable) return "free";
  if (slot.bookedBy) return "asso";
  return "other";
}

const SEG_LABEL: Record<Seg, string> = {
  free: "Libre",
  asso: "Réservé (asso)",
  other: "Réservé (autre)",
  mine: "Ta réservation",
  past: "Passé",
  closed: "Fermé",
};

// Aperçu semaine : lignes = horaires, colonnes = jours. Chaque case est BICOLORE — un
// segment par terrain (gauche = Squash 1, droite = Squash 2), coloré selon son état.
// - Clic sur une case → modale de détail des terrains (état, réservataire, +1, actions).
// - Mode « Sélection » → on coche plusieurs cases (ou toute une ligne d'horaire) puis on
//   réserve tout d'un coup (un terrain libre par case).
export function WeekGrid({
  days,
  filter,
  onPick,
  onBook,
  onTogglePresence,
  onBookMany,
}: {
  days: { date: string; planning: PlanningDay }[];
  filter: (iso: string) => boolean;
  onPick: (date: string) => void;
  onBook: (slot: Slot) => void;
  onTogglePresence: (slot: Slot) => void;
  onBookMany: (slots: Slot[]) => void;
}) {
  const [sheet, setSheet] = useState<{ date: string; hm: string } | null>(null);
  const [selMode, setSelMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const now = Date.now();
  const todayStr = new Date().toLocaleDateString("en-CA");

  // Terrains de la semaine, ordre STABLE (gauche → droite) : la position d'un segment
  // désigne toujours le même terrain, quel que soit le jour.
  const courts = useMemo<CourtRef[]>(() => {
    const m = new Map<string, CourtRef>();
    for (const d of days)
      for (const c of d.planning.courts)
        if (!m.has(c.id)) m.set(c.id, { id: c.id, name: c.name });
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [days]);

  // Union des horaires (HH:MM) présents, filtrés par la plage horaire choisie.
  const rows = useMemo(() => {
    const t = new Set<string>();
    for (const d of days)
      for (const s of d.planning.slots) if (filter(s.startsAt)) t.add(fmtTime(s.startsAt));
    return [...t].sort();
  }, [days, filter]);

  // `${date}|${hm}|${courtId}` -> slot (pour retrouver le créneau d'un terrain à un horaire).
  const slotAt = useMemo(() => {
    const m = new Map<string, Slot>();
    for (const d of days)
      for (const s of d.planning.slots) {
        if (!filter(s.startsAt)) continue;
        m.set(`${d.date}|${fmtTime(s.startsAt)}|${s.courtId}`, s);
      }
    return m;
  }, [days, filter]);

  if (rows.length === 0) {
    return <p className="muted">Aucun créneau sur cette plage horaire.</p>;
  }

  const key = (date: string, hm: string) => `${date}|${hm}`;
  const cellSlots = (date: string, hm: string) =>
    courts.map((c) => slotAt.get(`${date}|${hm}|${c.id}`) ?? null);
  const freeSlots = (date: string, hm: string) =>
    cellSlots(date, hm).filter(
      (s): s is Slot => !!s && s.bookable && new Date(s.startsAt).getTime() >= now,
    );
  const selectable = (date: string, hm: string) => freeSlots(date, hm).length > 0;

  const cellTitle = (date: string, hm: string) =>
    courts
      .map((c) => {
        const s = slotAt.get(`${date}|${hm}|${c.id}`) ?? null;
        const seg = segOf(s, now);
        const who = seg === "asso" && s?.bookedBy ? ` (${s.bookedBy})` : "";
        return `${c.name} : ${SEG_LABEL[seg]}${who}`;
      })
      .join(" · ");

  const toggleCell = (date: string, hm: string) => {
    if (!selectable(date, hm)) return;
    setSelected((prev) => {
      const n = new Set(prev);
      const k = key(date, hm);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });
  };
  const toggleRow = (hm: string) => {
    const keys = days.filter((d) => selectable(d.date, hm)).map((d) => key(d.date, hm));
    if (keys.length === 0) return;
    setSelected((prev) => {
      const n = new Set(prev);
      const allSel = keys.every((k) => n.has(k));
      for (const k of keys) (allSel ? n.delete(k) : n.add(k));
      return n;
    });
  };
  const exitSel = () => {
    setSelMode(false);
    setSelected(new Set());
  };

  const clickCell = (date: string, hm: string) => {
    if (selMode) toggleCell(date, hm);
    else setSheet({ date, hm });
  };

  const bookSelected = () => {
    const slots: Slot[] = [];
    for (const k of selected) {
      const [date, hm] = k.split("|");
      const free = freeSlots(date, hm);
      if (free.length) slots.push(free[0]); // un terrain libre par case
    }
    if (slots.length) onBookMany(slots);
    exitSel();
  };

  const sheetCourts = sheet
    ? courts.map((c) => ({
        court: c,
        slot: slotAt.get(`${sheet.date}|${sheet.hm}|${c.id}`) ?? null,
      }))
    : [];

  return (
    <>
      <div className="week-tools">
        <button
          type="button"
          className={"secondary wk-selbtn" + (selMode ? " active" : "")}
          aria-pressed={selMode}
          onClick={() => (selMode ? exitSel() : setSelMode(true))}
        >
          {selMode ? "Annuler la sélection" : "🗓️ Réserver plusieurs créneaux"}
        </button>
        {selMode && (
          <span className="muted tiny">
            Touche les cases à réserver (ou un horaire pour toute la ligne).
          </span>
        )}
      </div>

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
                <th
                  className={"time" + (selMode ? " selrow" : "")}
                  {...(selMode
                    ? {
                        role: "button" as const,
                        tabIndex: 0,
                        title: "Sélectionner cet horaire sur toute la semaine",
                        onClick: () => toggleRow(hm),
                        onKeyDown: onKey(() => toggleRow(hm)),
                      }
                    : {})}
                >
                  {hm}
                </th>
                {days.map((d) => {
                  const k = key(d.date, hm);
                  const canSel = selectable(d.date, hm);
                  const isSel = selected.has(k);
                  return (
                    <td
                      key={d.date}
                      className={
                        "cell wk" +
                        (selMode && canSel ? " selectable" : "") +
                        (isSel ? " selected" : "")
                      }
                      role="button"
                      tabIndex={0}
                      aria-pressed={selMode ? isSel : undefined}
                      aria-label={cellTitle(d.date, hm)}
                      title={cellTitle(d.date, hm)}
                      onClick={() => clickCell(d.date, hm)}
                      onKeyDown={onKey(() => clickCell(d.date, hm))}
                    >
                      <span className="wk-cell">
                        {courts.map((c) => {
                          const s = slotAt.get(`${d.date}|${hm}|${c.id}`) ?? null;
                          return <span key={c.id} className={"wk-seg " + segOf(s, now)} />;
                        })}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Barre d'action collante quand des cases sont sélectionnées. */}
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

      {sheet && (
        <div className="modal-overlay" onClick={() => setSheet(null)}>
          <div
            className="modal week-detail"
            role="dialog"
            aria-modal="true"
            aria-label="Détail des terrains"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>
              {longDay(sheet.date)} · {sheet.hm}
            </h3>
            <div className="wk-detail-list">
              {sheetCourts.map(({ court, slot }) => {
                const seg = segOf(slot, now);
                const who =
                  seg === "asso" && slot?.bookedBy ? ` · ${slot.bookedBy}` : "";
                const att =
                  slot && (seg === "asso" || seg === "mine") && slot.attendees?.length
                    ? slot.attendees.join(", ")
                    : "";
                return (
                  <div key={court.id} className={"wk-detail " + seg}>
                    <div className="wk-detail-head">
                      <span className={"wk-chip " + seg} />
                      <strong>{court.name}</strong>
                      <span className="wk-state">
                        {seg === "mine" ? "Ta réservation ★" : SEG_LABEL[seg]}
                        {who}
                      </span>
                    </div>
                    {att && <div className="wk-att">👥 +1 : {att}</div>}
                    <div className="wk-detail-actions">
                      {seg === "free" && slot && (
                        <button
                          type="button"
                          onClick={() => {
                            setSheet(null);
                            onBook(slot);
                          }}
                        >
                          Réserver
                        </button>
                      )}
                      {seg === "asso" && slot && (
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => {
                            setSheet(null);
                            onTogglePresence(slot);
                          }}
                        >
                          {slot.iAmAttending ? "Retirer ma présence" : "Je suis +1"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="modal-actions">
              <button
                className="secondary"
                onClick={() => {
                  setSheet(null);
                  onPick(sheet.date);
                }}
              >
                Voir la journée
              </button>
              <button className="secondary" onClick={() => setSheet(null)}>
                Fermer
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
