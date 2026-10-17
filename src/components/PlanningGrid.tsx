"use client";

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type { PlanningDay, Slot } from "@/lib/resamania/types";
import { fmtTime } from "@/lib/time";
import { useBottomBar } from "@/lib/useBottomBar";

/**
 * Rang en liste d'attente : « 1er », « 2e », « 3e »… Il s'écrivait « 1ᵉ » — forme fautive, le
 * premier rang est le seul à avoir la sienne — et en lettres modificatrices, que certains
 * lecteurs d'écran épellent. Partagé avec WeekGrid, qui affiche le même rang.
 */
export function rang(n: number): string {
  return n === 1 ? "1er" : `${n}e`;
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

// Navigation au clavier DANS la grille (flèches, Origine/Fin).
//
// Avant, chaque cellule interactive était un arrêt de tabulation : atteindre le créneau de
// 20 h demandait jusqu'à 40 tabulations en vue jour — et 280 segments en vue semaine. La
// grille était donc théoriquement accessible et pratiquement inutilisable sans souris.
// On déplace le focus de proche en proche dans le tableau, comme le fait un tableur.
function moveFocus(from: HTMLElement, dRow: number, dCol: number, toEnd?: "start" | "end") {
  const cell = from.closest("td, th");
  const row = cell?.closest("tr");
  const table = row?.closest("table");
  if (!cell || !row || !table) return;

  const rows = [...table.querySelectorAll("tbody tr")];
  const cells = [...row.children];
  const r = rows.indexOf(row as HTMLTableRowElement);
  const c = cells.indexOf(cell);
  if (r < 0) return;

  // Cible : même colonne sur une autre ligne, ou autre colonne sur la même ligne.
  const targetRow = rows[Math.min(Math.max(r + dRow, 0), rows.length - 1)];
  const sameRow = dRow === 0;
  const cols = [...targetRow.children];
  let targetCol = sameRow ? c + dCol : c;
  if (toEnd === "start") targetCol = 1; // 0 = colonne « Heure », non interactive
  if (toEnd === "end") targetCol = cols.length - 1;
  targetCol = Math.min(Math.max(targetCol, 0), cols.length - 1);

  // On cherche le prochain élément focalisable à partir de la cible, dans le sens du geste.
  const step = dCol < 0 || toEnd === "start" ? -1 : 1;
  for (let i = targetCol; i >= 0 && i < cols.length; i += step) {
    const candidate = cols[i] as HTMLElement;
    // Une case INTERACTIVE, qu'elle soit l'arrêt de Tab (0) ou non (-1, tabindex roulant).
    if (candidate.getAttribute("role") === "button") {
      candidate.focus();
      return;
    }
  }
}

function onGridKey(e: KeyboardEvent) {
  const el = e.target as HTMLElement;
  const map: Record<string, [number, number] | "start" | "end"> = {
    ArrowUp: [-1, 0],
    ArrowDown: [1, 0],
    ArrowLeft: [0, -1],
    ArrowRight: [0, 1],
    Home: "start",
    End: "end",
  };
  const move = map[e.key];
  if (!move) return;
  e.preventDefault();
  if (move === "start" || move === "end") moveFocus(el, 0, 0, move);
  else moveFocus(el, move[0], move[1]);
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
  onWatch,
  onUnwatch,
  canWatch,
  waitCountFor,
  myWaitFor,
  pendingIds,
  progress,
  retryIds,
}: {
  planning: PlanningDay;
  onBook: (slot: Slot) => void;
  onCancelMine: (slot: Slot) => void;
  onTogglePresence: (slot: Slot) => void;
  onBookMany: (slots: Slot[]) => void;
  // Mode « Sélection » piloté par la page (bouton dans la barre de vue).
  selMode: boolean;
  setSelMode: (v: boolean) => void;
  onWatch?: (slot: Slot) => void;
  onUnwatch?: (date: string, hm: string) => void;
  canWatch?: boolean;
  // Liste d'attente (idée D) : compteur et mon inscription par créneau.
  waitCountFor?: (date: string, hm: string) => number;
  myWaitFor?: (date: string, hm: string) => { position?: number } | null;
  // Retour visuel de l'action en cours : la ou les cases réellement engagées auprès de
  // ResaMania. Elles deviennent inertes et affichent un point d'attente, pour que le membre
  // voie que ça travaille au lieu de croire que son tap n'a rien fait.
  pendingIds?: Set<string>;
  // Avancement de la réservation groupée (séquentielle) : « Réservation 3 / 7… ».
  progress?: { done: number; total: number } | null;
  // Créneaux à re-cocher après un bilan groupé partiel (ceux qui ont échoué).
  retryIds?: string[];
}) {
  // On coche des créneaux libres (un seul terrain par horaire, règle ResaMania), puis on
  // réserve tout d'un coup. La sélection se vide dès qu'on quitte le mode.
  const [selected, setSelected] = useState<Set<string>>(new Set()); // ids de slots
  // TABINDEX ROULANT (audit 2026-10, point 29) : UNE seule case de la grille est dans l'ordre
  // de tabulation — la dernière touchée, ou la première interactive. Tab entre dans la grille
  // puis en sort d'un coup ; les flèches s'y déplacent. Avant, chaque case libre était un arrêt
  // de Tab : une cinquantaine pour traverser un après-midi au clavier.
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (!selMode) setSelected(new Set());
  }, [selMode]);

  // Après un bilan groupé partiel, la page renvoie les créneaux qui ont échoué : on rouvre
  // le mode sélection avec eux déjà cochés. Sans ça, l'utilisateur devrait se rappeler
  // lesquels ont raté et les recocher un par un.
  useEffect(() => {
    if (!retryIds || retryIds.length === 0) return;
    setSelMode(true);
    setSelected(new Set(retryIds));
    // setSelMode est stable côté page (useState setter) ; on ne suit que la liste.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryIds]);

  // Alerte « préviens-moi si ça se libère » : proposée sur les créneaux réservés HORS asso
  // (les créneaux asso servent, eux, à signaler sa présence — cf. onTogglePresence).
  const watchable = !!(canWatch && onWatch);
  // Index dérivés de la grille : recalculés uniquement quand les créneaux changent
  // (et non à chaque rendu déclenché par un toast, un changement de sélection, etc.).
  // - times   : lignes = horaires distincts triés
  // - byKey   : accès O(1) au créneau d'un (terrain, horaire)
  // - endByTime : fin de chaque horaire (pour afficher « début – fin »)
  // Barre d'action en bas → masque la bannière d'installation PWA, qui la recouvrait.
  const barUp = !!progress || (selMode && selected.size > 0);
  useBottomBar(barUp);

  const { times, byKey, endByTime } = useMemo(() => {
    const times = [...new Set(planning.slots.map((s) => s.startsAt))].sort();
    const byKey = new Map(
      planning.slots.map((s) => [s.courtId + "|" + s.startsAt, s]),
    );
    const endByTime = new Map(planning.slots.map((s) => [s.startsAt, s.endsAt]));
    return { times, byKey, endByTime };
  }, [planning.slots]);
  const now = Date.now();

  if (planning.courts.length === 0) {
    return <p className="muted">Aucun créneau ce jour-là.</p>;
  }

  // Je joue déjà (résa « à moi ») à cet horaire ? → l'autre terrain n'est pas réservable.
  const timeHasMine = (t: string) =>
    planning.slots.some((s) => s.startsAt === t && s.mine);

  // Créneau COMPLET (liste d'attente, idée D) : à venir, aucun terrain libre, et je n'y
  // joue pas déjà. Un terrain libre → réservation directe (pas d'attente).
  const rowComplete = (t: string) => {
    if (new Date(t).getTime() < now) return false;
    const atT = planning.slots.filter((s) => s.startsAt === t);
    if (atT.length === 0) return false;
    if (atT.some((s) => s.mine)) return false;
    if (atT.some((s) => s.bookable)) return false;
    return true;
  };

  // La case porte-t-elle une action ? Même règle que le rendu plus bas — c'est elle qui décide
  // de l'arrêt de tabulation.
  const interactive = (slot: Slot): boolean => {
    if (pendingIds?.has(slot.id)) return false;
    if (slot.mine) return !selMode;
    if (slot.bookedBy) return !selMode && new Date(slot.startsAt).getTime() >= now;
    if (slot.bookable) {
      if (new Date(slot.startsAt).getTime() < now) return false;
      return selMode ? !timeHasMine(slot.startsAt) : true;
    }
    return false;
  };
  const ordre = times.flatMap((t) =>
    planning.courts.map((c) => byKey.get(c.id + "|" + t)).filter((x): x is Slot => !!x && interactive(x)),
  );
  const tabStop = ordre.some((x) => x.id === active) ? active : (ordre[0]?.id ?? null);
  /** Attributs clavier d'une case interactive : un seul arrêt de Tab, focus suivi. */
  const roving = (slot: Slot) => ({
    tabIndex: slot.id === tabStop ? 0 : -1,
    onFocus: () => setActive(slot.id),
  });
  /** Ce que le lecteur d'écran annonce : terrain, horaire, état — la case seule ne disait rien. */
  const label = (courtName: string, slot: Slot, etat: string) =>
    `${courtName}, ${fmtTime(slot.startsAt)} : ${etat}`;

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
      {/* Le libellé disait « Sélection multi créneau » : un groupe nominal agrammatical qui
          n'indiquait ni comment cocher, ni comment sortir. On dit quoi faire. */}
      {selMode && (
        <p className="muted tiny selmode-hint">
          Touche les créneaux libres à réserver, puis « Réserver » en bas. Retouche l&apos;icône
          de sélection pour quitter.
        </p>
      )}

      <div className="grid-wrap">
        {/* La navigation par flèches est posée UNE fois sur le tableau : les événements des
            cellules remontent jusqu'ici. Les cellules gardent leur Entrée/Espace pour
            déclencher l'action ; les flèches ne font que déplacer le focus. */}
        <table className="planning" onKeyDown={onGridKey}>
          <thead>
            <tr>
              <th className="time" scope="col">Heure</th>
              {planning.courts.map((c) => (
                <th key={c.id} scope="col">{c.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {times.map((t) => {
              const end = endByTime.get(t);
              return (
                <tr key={t}>
                  <th className="time" scope="row">
                    <span className="t-start">{fmtTime(t)}</span>
                    {end && <span className="t-end">{fmtTime(end)}</span>}
                    {!selMode && rowComplete(t) && (() => {
                      const d = t.slice(0, 10);
                      const hm = fmtTime(t); // heure du club (cf. onWatch/check-alerts), pas UTC brut
                      const count = waitCountFor?.(d, hm) ?? 0;
                      const mine = myWaitFor?.(d, hm) ?? null;
                      // Déjà « +1 » sur ce créneau → on masque l'offre de REJOINDRE la liste
                      // d'attente (le compteur reste visible ; se retirer reste possible).
                      const attending = planning.slots.some(
                        (s) => s.startsAt === t && s.iAmAttending,
                      );
                      const act = !watchable
                        ? undefined
                        : mine
                          ? () => onUnwatch?.(d, hm)
                          : attending
                            ? undefined
                            : () => onWatch?.(planning.slots.find((s) => s.startsAt === t)!);
                      if (count === 0 && !act) return null;
                      const label = mine
                        ? `Tu es en liste d'attente${mine.position ? ` (${rang(mine.position)})` : ""}${watchable ? " — cliquer pour te retirer" : ""}`
                        : attending
                          ? `Tu es déjà +1 sur ce créneau${count ? ` · ${count} en attente` : ""}`
                          : `Créneau complet — se mettre en liste d'attente${count ? ` (${count} en attente)` : ""}`;
                      return (
                        <button
                          type="button"
                          className={"wait-btn" + (mine ? " on" : "")}
                          disabled={!act}
                          aria-pressed={mine ? true : undefined}
                          title={label}
                          aria-label={label}
                          onClick={act}
                        >
                          🕒{count > 0 ? ` ${count}` : ""}
                        </button>
                      );
                    })()}
                  </th>
                  {planning.courts.map((c) => {
                    const slot = byKey.get(c.id + "|" + t);
                    if (!slot)
                      return (
                        <td
                          key={c.id}
                          className="cell closed"
                          title="Terrain fermé à cet horaire"
                          aria-label="Terrain fermé à cet horaire"
                        />
                      );
                    // Créneau en cours de traitement auprès de ResaMania : case inerte et
                    // visiblement occupée. Placé AVANT tous les autres cas — pendant l'appel,
                    // aucun geste ne doit plus partir depuis cette case.
                    if (pendingIds?.has(slot.id)) {
                      return (
                        <td key={c.id} className="cell pending" aria-busy="true">
                          <span className="pending-dot" aria-hidden="true" />
                          <span className="sr-only">Action en cours…</span>
                        </td>
                      );
                    }
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
                                ...roving(slot),
                                title: "Ta réservation — cliquer pour annuler",
                                "aria-label": label(c.name, slot, "ta réservation, appuie pour annuler"),
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
                          <td key={c.id} className={cls} title={title} aria-label={label(c.name, slot, `réservé par ${slot.bookedBy}`)}>
                            {content}
                          </td>
                        );
                      }
                      return (
                        <td
                          key={c.id}
                          className={cls}
                          role="button"
                          {...roving(slot)}
                          aria-pressed={attending}
                          aria-label={label(
                            c.name,
                            slot,
                            `réservé par ${slot.bookedBy}${attending ? ", tu es +1" : ", appuie pour signaler ta présence"}`,
                          )}
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
                            aria-label={label(c.name, slot, "passé")}
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
                                ...roving(slot),
                                onClick: act,
                                onKeyDown: onKey(act),
                              }
                            : {})}
                          aria-pressed={selMode ? isSel : undefined}
                          aria-label={label(
                            c.name,
                            slot,
                            selMode
                              ? canSel
                                ? isSel
                                  ? "sélectionné"
                                  : "libre, appuie pour sélectionner"
                                : "libre, mais tu joues déjà à cet horaire"
                              : "libre, appuie pour réserver",
                          )}
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
                    {
                      // Créneau réservé hors asso : inerte. La liste d'attente (idée D) est
                      // proposée via le bouton 🕒 de l'en-tête d'horaire, uniquement quand
                      // l'horaire est complet (aucun terrain libre).
                      return (
                        <td
                          key={c.id}
                          className="cell booked"
                          title="Réservé (hors groupe)"
                          aria-label={label(c.name, slot, "réservé hors groupe")}
                        >
                          Réservé
                        </td>
                      );
                    }
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Barre d'action collante quand des créneaux sont sélectionnés. Pendant la réservation
          groupée elle porte l'avancement : la boucle est séquentielle (N allers-retours vers
          ResaMania), donc sans ce compteur l'écran resterait figé plusieurs secondes. */}
      {(progress || (selMode && selected.size > 0)) && (
        <div className="wk-actionbar">
          {progress ? (
            <>
              <span>
                Réservation {Math.min(progress.done + 1, progress.total)} / {progress.total}…
              </span>
              <button type="button" disabled>
                Réservation…
              </button>
            </>
          ) : (
            <>
              <span>
                {selected.size} créneau{selected.size > 1 ? "x" : ""} sélectionné
                {selected.size > 1 ? "s" : ""}
              </span>
              <button type="button" onClick={bookSelected}>
                Réserver
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}
