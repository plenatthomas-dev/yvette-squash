"use client";

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
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
// Déclenche l'action au clavier (Entrée / Espace) sur les éléments cliquables.
function onKey(fn: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  };
}

// État visuel d'un terrain dans une case (une couleur par état, palette de la vue jour).
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
// segment par terrain (gauche = Squash 1, droite = Squash 2), coloré selon son état, et
// CHAQUE terrain est cliquable INDÉPENDAMMENT (y compris au doigt) :
// - Mode normal : terrain libre → réservation directe ; « le mien » → annulation directe ;
//   réservé asso → détail (qui a réservé, « +1 »). Pas de modale de choix de terrain.
// - Mode « Sélection » : on coche des terrains libres précis (un seul par horaire, règle
//   ResaMania) — ils changent de couleur — puis on réserve tout d'un coup.
export function WeekGrid({
  days,
  filter,
  onPick,
  onBook,
  onCancelMine,
  onTogglePresence,
  onBookMany,
  selMode,
  setSelMode,
}: {
  days: { date: string; planning: PlanningDay }[];
  filter: (iso: string) => boolean;
  onPick: (date: string) => void;
  onBook: (slot: Slot) => void;
  onCancelMine: (slot: Slot) => void;
  onTogglePresence: (slot: Slot) => void;
  onBookMany: (slots: Slot[]) => void;
  // Mode « Sélection » piloté par la page (bouton dans la barre de vue).
  selMode: boolean;
  setSelMode: (v: boolean) => void;
}) {
  const [sheet, setSheet] = useState<{ date: string; hm: string; courtId: string } | null>(
    null,
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!selMode) setSelected(new Set());
  }, [selMode]);
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

  // `${date}|${hm}|${courtId}` -> slot. Cette clé sert aussi de clé de sélection.
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

  const segKey = (date: string, hm: string, courtId: string) => `${date}|${hm}|${courtId}`;
  // Je joue déjà (résa « à moi ») sur un terrain de cette case ? → l'autre terrain n'est pas
  // réservable (ResaMania refuse 2 terrains au même horaire).
  const cellHasMine = (date: string, hm: string) =>
    courts.some((c) => slotAt.get(segKey(date, hm, c.id))?.mine);
  // Ce terrain précis est-il réservable ? (libre, à venir, et pas de résa à moi à cet horaire)
  const isReservable = (slot: Slot | null, date: string, hm: string): slot is Slot =>
    !!slot &&
    slot.bookable &&
    new Date(slot.startsAt).getTime() >= now &&
    !cellHasMine(date, hm);
  // Un terrain libre réservable existe-t-il dans cette case ? (pour la sélection par ligne)
  const rowHasReservable = (date: string, hm: string) =>
    courts.some((c) => isReservable(slotAt.get(segKey(date, hm, c.id)) ?? null, date, hm));

  const segAria = (date: string, hm: string, court: CourtRef, seg: Seg, slot: Slot | null) => {
    const who = seg === "asso" && slot?.bookedBy ? ` (${slot.bookedBy})` : "";
    return `${shortDay(date)} ${hm} · ${court.name} : ${SEG_LABEL[seg]}${who}`;
  };

  // Sélection d'un terrain précis (radio DANS la case : au plus un terrain par horaire).
  const toggleSeg = (date: string, hm: string, courtId: string) => {
    setSelected((prev) => {
      const n = new Set(prev);
      const k = segKey(date, hm, courtId);
      if (n.has(k)) {
        n.delete(k);
        return n;
      }
      for (const c of courts) n.delete(segKey(date, hm, c.id)); // vide l'autre terrain
      n.add(k);
      return n;
    });
  };
  // Sélectionne un terrain libre par jour pour cet horaire (le 1ᵉʳ libre), sur toute la
  // semaine ; re-clic → désélectionne toute la ligne.
  const toggleRow = (hm: string) => {
    const daysWithFree = days.filter((d) => rowHasReservable(d.date, hm));
    if (daysWithFree.length === 0) return;
    setSelected((prev) => {
      const n = new Set(prev);
      const allSel = daysWithFree.every((d) =>
        courts.some((c) => n.has(segKey(d.date, hm, c.id))),
      );
      for (const d of daysWithFree) for (const c of courts) n.delete(segKey(d.date, hm, c.id));
      if (!allSel)
        for (const d of daysWithFree) {
          const c = courts.find((c) =>
            isReservable(slotAt.get(segKey(d.date, hm, c.id)) ?? null, d.date, hm),
          );
          if (c) n.add(segKey(d.date, hm, c.id));
        }
      return n;
    });
  };
  const exitSel = () => {
    setSelMode(false);
    setSelected(new Set());
  };

  // Clic sur un terrain précis (segment).
  const clickSeg = (date: string, hm: string, court: CourtRef, slot: Slot | null, seg: Seg) => {
    if (selMode) {
      if (isReservable(slot, date, hm)) toggleSeg(date, hm, court.id);
      return;
    }
    if (seg === "free" && slot) {
      // Conflit « un seul terrain par horaire » : on ouvre le détail qui l'explique.
      if (cellHasMine(date, hm)) setSheet({ date, hm, courtId: court.id });
      else onBook(slot);
    } else if (seg === "mine" && slot) {
      onCancelMine(slot);
    } else if (seg === "asso" && slot) {
      setSheet({ date, hm, courtId: court.id });
    }
    // other / past / closed : inerte
  };

  const bookSelected = () => {
    const slots = [...selected]
      .map((k) => slotAt.get(k))
      .filter((s): s is Slot => !!s)
      .sort((a, b) =>
        a.startsAt === b.startsAt
          ? a.courtName.localeCompare(b.courtName)
          : a.startsAt.localeCompare(b.startsAt),
      );
    if (slots.length) onBookMany(slots);
    exitSel();
  };

  const sheetSlot = sheet
    ? slotAt.get(segKey(sheet.date, sheet.hm, sheet.courtId)) ?? null
    : null;
  const sheetCourt = sheet ? courts.find((c) => c.id === sheet.courtId) ?? null : null;
  const sheetSeg = segOf(sheetSlot, now);
  const sheetOtherMine = sheet
    ? courts.some((c) => c.id !== sheet.courtId && slotAt.get(segKey(sheet.date, sheet.hm, c.id))?.mine)
    : false;
  const sheetOtherMineName = sheet
    ? courts.find(
        (c) => c.id !== sheet.courtId && slotAt.get(segKey(sheet.date, sheet.hm, c.id))?.mine,
      )?.name
    : undefined;
  const sheetAtt =
    sheetSlot && (sheetSeg === "asso" || sheetSeg === "mine") && sheetSlot.attendees?.length
      ? sheetSlot.attendees.join(", ")
      : "";

  return (
    <>
      {selMode && (
        <p className="muted tiny selmode-hint">Sélection multi créneau</p>
      )}

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
                {days.map((d) => (
                  <td key={d.date} className="cell wk">
                    <span className="wk-cell">
                      {courts.map((c) => {
                        const slot = slotAt.get(segKey(d.date, hm, c.id)) ?? null;
                        const seg = segOf(slot, now);
                        const canSel = selMode && isReservable(slot, d.date, hm);
                        const isSel = selected.has(segKey(d.date, hm, c.id));
                        const interactive = selMode
                          ? canSel
                          : seg === "free" || seg === "asso" || seg === "mine";
                        return (
                          <span
                            key={c.id}
                            className={
                              "wk-seg " +
                              seg +
                              (interactive ? " tap" : "") +
                              (isSel ? " selseg" : "")
                            }
                            role={interactive ? "button" : undefined}
                            tabIndex={interactive ? 0 : undefined}
                            aria-pressed={selMode ? isSel : undefined}
                            aria-label={segAria(d.date, hm, c, seg, slot)}
                            title={segAria(d.date, hm, c, seg, slot)}
                            onClick={
                              interactive
                                ? () => clickSeg(d.date, hm, c, slot, seg)
                                : undefined
                            }
                            onKeyDown={
                              interactive
                                ? onKey(() => clickSeg(d.date, hm, c, slot, seg))
                                : undefined
                            }
                          />
                        );
                      })}
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Barre d'action collante quand des terrains sont sélectionnés. */}
      {selMode && selected.size > 0 && (
        <div className="wk-actionbar">
          <span>
            {selected.size} terrain{selected.size > 1 ? "s" : ""} sélectionné
            {selected.size > 1 ? "s" : ""}
          </span>
          <button type="button" onClick={bookSelected}>
            Réserver
          </button>
        </div>
      )}

      {sheet && sheetCourt && (
        <div className="modal-overlay" onClick={() => setSheet(null)}>
          <div
            className="modal week-detail"
            role="dialog"
            aria-modal="true"
            aria-label="Détail du terrain"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>
              {longDay(sheet.date)} · {sheet.hm}
            </h3>
            <div className="wk-detail-list">
              <div className={"wk-detail " + sheetSeg}>
                <div className="wk-detail-head">
                  <span className={"wk-chip " + sheetSeg} />
                  <strong>{sheetCourt.name}</strong>
                  <span className="wk-state">
                    {sheetSeg === "mine" ? "Ta réservation ★" : SEG_LABEL[sheetSeg]}
                    {sheetSeg === "asso" && sheetSlot?.bookedBy ? ` · ${sheetSlot.bookedBy}` : ""}
                  </span>
                </div>
                {sheetAtt && <div className="wk-att">👥 +1 : {sheetAtt}</div>}
                <div className="wk-detail-actions">
                  {sheetSeg === "free" && sheetSlot && !sheetOtherMine && (
                    <button
                      type="button"
                      onClick={() => {
                        setSheet(null);
                        onBook(sheetSlot);
                      }}
                    >
                      Réserver
                    </button>
                  )}
                  {sheetSeg === "free" && sheetOtherMine && (
                    <span className="muted tiny">
                      Tu joues déjà sur {sheetOtherMineName} à cet horaire — un seul
                      terrain à la fois.
                    </span>
                  )}
                  {sheetSeg === "mine" && sheetSlot && (
                    <button
                      type="button"
                      className="secondary danger"
                      onClick={() => {
                        setSheet(null);
                        onCancelMine(sheetSlot);
                      }}
                    >
                      Annuler ma résa
                    </button>
                  )}
                  {sheetSeg === "asso" && sheetSlot && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        setSheet(null);
                        onTogglePresence(sheetSlot);
                      }}
                    >
                      {sheetSlot.iAmAttending ? "Retirer ma présence" : "Je suis +1"}
                    </button>
                  )}
                </div>
              </div>
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
