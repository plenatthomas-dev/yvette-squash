"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "@/components/Dialog";
import { MIN_PLAYERS, MAX_PLAYERS } from "@/lib/tournament";

// Vue « Tournoi » : liste des tournois, assistant de création (roster annuaire + invités,
// cible de matchs) → proposition de formule → génération, puis suivi (poules/tableau,
// liste des matchs par terrain, saisie des scores). Montants/scores en JEUX.

interface Member {
  id: string;
  name: string;
  clt?: string; // classement fédéral (si FEATURE_RANKING + rapprochement sûr)
  rang?: number | null; // rang national (tri des têtes de série)
}
interface PlayerRef {
  id: string;
  name: string;
}
interface MatchView {
  id: string | null;
  p1: PlayerRef | null;
  p2: PlayerRef | null;
  score1: number | null;
  score2: number | null;
  winnerId: string | null;
  status: "pending" | "bye" | "done";
  terrain: string | null;
  order: number | null;
  round?: number;
  slot?: number;
  branch?: string;
  phase?: string;
  placeLabel?: string | null;
  stage?: string;
}
interface StandingView {
  playerId: string;
  name: string;
  rank: number;
  played: number;
  wins: number;
  losses: number;
  gamesFor: number;
  gamesAgainst: number;
  gameDiff: number;
  points: number;
}
interface PoolView {
  label: string;
  matches: MatchView[];
  standings: StandingView[];
}
interface Detail {
  id: string;
  name: string | null;
  date: string;
  status: "draft" | "running" | "done";
  format: string;
  formatLabel: string;
  targetMatches: number;
  bestOf: number;
  courts: number;
  isCreator: boolean;
  isParticipant: boolean;
  players: { id: string; name: string; seed: number }[];
  pools: PoolView[] | null;
  bracket: {
    rounds: number;
    byes: number;
    ranking:
      | { playerId: string; name: string; rank: number; played: number; wins: number; losses: number }[]
      | null;
    matches: MatchView[];
  } | null;
  champion: PlayerRef | null;
}
interface ListItem {
  id: string;
  name: string | null;
  date: string;
  status: string;
  format: string;
  playerCount: number;
}
interface Proposal {
  kind: "pools" | "bracket" | "pools_bracket";
  label: string;
  matchesPerPlayer: { min: number; max: number };
  avgMatchesPerPlayer: number;
  totalMatches: number;
  producesChampion: boolean;
  fullRanking: boolean;
  estimatedMinutes: number;
  poolSizes?: number[];
  bracketByes?: number;
}

interface Props {
  toast: (type: "ok" | "err" | "info", msg: string) => void;
  onExpired: (status: number) => boolean;
}

function todayISO(): string {
  return new Date().toLocaleDateString("en-CA");
}

function prettyDate(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString("fr-FR", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/** Lignes de score valides selon le format : bo3 → 2-0/2-1/… ; bo5 → 3-0/3-1/… */
function scorelines(bestOf: number): [number, number][] {
  const w = Math.ceil(bestOf / 2);
  const lines: [number, number][] = [];
  for (let k = w - 1; k >= 0; k--) lines.push([w, k]); // p1 gagne
  for (let k = 0; k < w; k++) lines.push([k, w]); // p2 gagne
  return lines;
}

const STATUS_LABEL: Record<string, string> = {
  draft: "Brouillon",
  running: "En cours",
  done: "Terminé",
};

export default function Tournament({ toast, onExpired }: Props) {
  const [list, setList] = useState<ListItem[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Assistant de création (1 roster, 2 têtes de série, 3 réglages, 4 formules)
  const [wizardOpen, setWizardOpen] = useState(false);
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [guests, setGuests] = useState<string[]>([]);
  const [guestInput, setGuestInput] = useState("");
  // Ordre des têtes de série (glisser-déposer / flèches) : le 1er = tête de série n°1.
  const [seeded, setSeeded] = useState<
    { key: string; label: string; userId: string | null; guestName: string | null; clt?: string | null }[]
  >([]);
  const dragIndex = useRef<number | null>(null);
  const [name, setName] = useState("");
  const [date, setDate] = useState(todayISO());
  const [target, setTarget] = useState<2 | 3 | 4>(3);
  const [bestOf, setBestOf] = useState<3 | 5>(3);
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    const r = await fetch("/api/tournaments");
    if (onExpired(r.status)) return;
    const j = await r.json().catch(() => ({}));
    if (r.ok) setList(j.tournaments ?? []);
  }, [onExpired]);

  const loadDetail = useCallback(
    async (id: string) => {
      const r = await fetch(`/api/tournaments/${id}`);
      if (onExpired(r.status)) return;
      const j = await r.json().catch(() => ({}));
      if (r.ok) setDetail(j as Detail);
    },
    [onExpired],
  );

  useEffect(() => {
    loadList();
  }, [loadList]);
  useEffect(() => {
    if (openId) loadDetail(openId);
    else setDetail(null);
  }, [openId, loadDetail]);

  // Rafraîchissement multi-utilisateur : plusieurs personnes saisissent des scores en
  // parallèle. Au retour sur l'onglet (focus / redevenu visible), on recharge le tournoi
  // ouvert — sauf pendant une saisie (busy) pour ne pas écraser l'action en cours.
  const busyRef = useRef(busy);
  busyRef.current = busy;
  useEffect(() => {
    if (!openId) return;
    const refresh = () => {
      if (document.visibilityState === "visible" && !busyRef.current) loadDetail(openId);
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [openId, loadDetail]);

  const totalPlayers = picked.size + guests.length;

  const openWizard = async () => {
    setStep(1);
    setPicked(new Set());
    setGuests([]);
    setGuestInput("");
    setName("");
    setDate(todayISO());
    setTarget(3);
    setBestOf(3);
    setProposals(null);
    setDraftId(null);
    setSeeded([]);
    setWizardOpen(true);
    if (members === null) {
      const r = await fetch("/api/directory");
      if (onExpired(r.status)) return;
      const j = await r.json().catch(() => ({}));
      if (r.ok) setMembers(j.members ?? []);
    }
  };

  const togglePick = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const addGuest = () => {
    const g = guestInput.trim();
    if (!g) return;
    if (totalPlayers >= MAX_PLAYERS) {
      toast("err", `Maximum ${MAX_PLAYERS} joueurs`);
      return;
    }
    setGuests((prev) => [...prev, g.slice(0, 40)]);
    setGuestInput("");
  };

  // Construit la liste ordonnée (têtes de série) à partir des joueurs choisis. ORDRE PAR
  // DÉFAUT = classement fédéral (rang national croissant = plus fort en tête), les membres
  // non classés puis les invités ensuite (ordre alpha). L'utilisateur ré-ordonne à la main.
  const buildSeeded = () => {
    const memberOf = (id: string) => members?.find((x) => x.id === id);
    const sortedIds = [...picked].sort((a, b) => {
      const ra = memberOf(a)?.rang ?? Infinity;
      const rb = memberOf(b)?.rang ?? Infinity;
      if (ra !== rb) return ra - rb;
      return (memberOf(a)?.name ?? "").localeCompare(memberOf(b)?.name ?? "", "fr", {
        sensitivity: "base",
      });
    });
    const memberItems = sortedIds.map((id) => ({
      key: `m${id}`,
      label: memberOf(id)?.name ?? "?",
      userId: id as string | null,
      guestName: null as string | null,
      clt: memberOf(id)?.clt ?? null,
    }));
    const guestItems = guests.map((g, i) => ({
      key: `g${i}`,
      label: g,
      userId: null as string | null,
      guestName: g as string | null,
      clt: null as string | null,
    }));
    setSeeded([...memberItems, ...guestItems]);
  };

  // Déplace une tête de série (flèches ou glisser-déposer).
  const moveSeed = (from: number, to: number) =>
    setSeeded((prev) => {
      if (to < 0 || to >= prev.length || from === to) return prev;
      const a = [...prev];
      const [x] = a.splice(from, 1);
      a.splice(to, 0, x);
      return a;
    });

  const fetchProposals = async () => {
    if (seeded.length < MIN_PLAYERS || seeded.length > MAX_PLAYERS) {
      toast("err", `Il faut de ${MIN_PLAYERS} à ${MAX_PLAYERS} joueurs`);
      return;
    }
    setBusy(true);
    try {
      // Ordre = têtes de série (seed = position dans la liste).
      const players = seeded.map((s) =>
        s.userId ? { userId: s.userId } : { guestName: s.guestName as string },
      );
      const res = await fetch("/api/tournaments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, date, targetMatches: target, bestOf, players }),
      });
      if (onExpired(res.status)) return;
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `Erreur ${res.status}`);
      setDraftId(j.id);
      setProposals(j.proposals ?? []);
      setStep(4);
    } catch (e) {
      toast("err", "Impossible : " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const generate = async (p: Proposal) => {
    if (!draftId || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/tournaments/${draftId}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: p.kind, poolSizes: p.poolSizes }),
      });
      if (onExpired(res.status)) return;
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `Erreur ${res.status}`);
      toast("ok", "Tournoi lancé 🏆");
      setWizardOpen(false);
      await loadList();
      setOpenId(draftId);
    } catch (e) {
      toast("err", "Génération impossible : " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const enterScore = async (m: MatchView, g1: number, g2: number) => {
    if (!m.id || !openId || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/tournaments/${openId}/matches/${m.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ score1: g1, score2: g2 }),
      });
      if (onExpired(res.status)) return;
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `Erreur ${res.status}`);
      await loadDetail(openId);
    } catch (e) {
      toast("err", "Score refusé : " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    setConfirmDelete(false);
    if (!openId || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/tournaments/${openId}`, { method: "DELETE" });
      if (onExpired(res.status)) return;
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Erreur ${res.status}`);
      }
      toast("ok", "Tournoi supprimé");
      setOpenId(null);
      loadList();
    } catch (e) {
      toast("err", "Suppression impossible : " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // --- Rendu d'un match (corps réutilisé en liste ET dans l'arbre) ---
  const canScore = !!detail && (detail.isParticipant || detail.isCreator);
  const renderMatchBody = (m: MatchView) => {
    const done = m.status === "done";
    const bye = m.status === "bye";
    const p1 = m.p1?.name ?? "—";
    const p2 = m.p2?.name ?? "—";
    return (
      <>
        <div className="trn-match-head">
          {m.terrain && m.status === "pending" && (
            <span className="trn-terrain">{m.terrain}</span>
          )}
          {m.stage && <span className="trn-place">{m.stage}</span>}
        </div>
        <div className="trn-vs">
          <span className={done && m.winnerId === m.p1?.id ? "win" : ""}>{p1}</span>
          {bye ? (
            <em className="trn-bye">passe (bye)</em>
          ) : done ? (
            <strong className="trn-scoreval">
              {m.score1}–{m.score2}
            </strong>
          ) : (
            <span className="trn-vs-sep">vs</span>
          )}
          <span className={done && m.winnerId === m.p2?.id ? "win" : ""}>{p2}</span>
        </div>
        {canScore && m.status === "pending" && m.p1 && m.p2 && detail && (
          <div className="trn-scorepick">
            {scorelines(detail.bestOf).map(([a, b]) => (
              <button
                key={`${a}-${b}`}
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => enterScore(m, a, b)}
                aria-label={`${p1} ${a} - ${b} ${p2}`}
              >
                {a}–{b}
              </button>
            ))}
          </div>
        )}
      </>
    );
  };
  const renderMatch = (m: MatchView, key: string) => (
    <li key={key} className={"trn-match" + (m.status === "done" ? " done" : "")}>
      {renderMatchBody(m)}
    </li>
  );

  // Arbre graphique d'un jeu de matchs (colonnes = tours). Réutilisé pour le tableau
  // principal (vainqueurs) ET le repêchage (perdants), qui a aussi ses demi/finales.
  const renderTree = (ms: MatchView[], titleFn: (r: number) => string) => {
    if (!detail?.bracket || ms.length === 0) return null;
    const rounds = detail.bracket.rounds;
    const minRound = Math.min(...ms.map((m) => m.round ?? 0));
    return (
      <div className="trn-tree">
        {Array.from({ length: rounds }).map((_, r) => {
          const col = ms
            .filter((m) => m.round === r)
            .sort((a, c) => (a.slot ?? 0) - (c.slot ?? 0));
          if (col.length === 0) return null;
          return (
            <div key={r} className="trn-tree-col">
              <div className="trn-tree-col-title">{titleFn(r)}</div>
              <div className="trn-tree-col-body">
                {col.map((m, i) => (
                  <div
                    key={i}
                    className={
                      "trn-tree-match" +
                      (r > minRound ? " linked" : "") +
                      (m.status === "done" ? " done" : "")
                    }
                  >
                    {renderMatchBody(m)}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  // Liste des matchs planifiés (par ordre de passage / terrain) — les prochains d'abord.
  const scheduleMatches = (): MatchView[] => {
    if (!detail) return [];
    const all = detail.pools
      ? detail.pools.flatMap((p) => p.matches)
      : (detail.bracket?.matches ?? []);
    return all
      .filter((m) => m.order !== null && m.status === "pending" && m.p1 && m.p2)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  };

  return (
    <section className="tournament">
      {openId && detail ? (
        // --- Vue d'un tournoi ---
        <div>
          <div className="trn-detail-head">
            <button className="secondary" onClick={() => setOpenId(null)}>
              ← Tournois
            </button>
            {detail.isCreator && (
              <button className="cancel" onClick={() => setConfirmDelete(true)} disabled={busy}>
                Supprimer
              </button>
            )}
          </div>
          <h2>
            🏆 {detail.name || `Tournoi du ${prettyDate(detail.date)}`}{" "}
            <small className="trn-count">· {detail.players.length} joueurs</small>{" "}
            <span className={"trn-status " + detail.status}>{STATUS_LABEL[detail.status]}</span>
          </h2>
          <p className="trn-formula muted tiny">
            Formule : <strong>{detail.formatLabel}</strong> ·{" "}
            {detail.bestOf === 5 ? "3 jeux gagnants" : "2 jeux gagnants"}
          </p>

          {detail.champion && (
            <p className="trn-champion">🥇 Vainqueur : <strong>{detail.champion.name}</strong></p>
          )}

          {/* Prochains matchs (planning des terrains) */}
          {scheduleMatches().length > 0 && (
            <section className="trn-block">
              <h3>📋 Prochains matchs</h3>
              <ul className="trn-schedule">
                {scheduleMatches()
                  .slice(0, 6)
                  .map((m) => (
                    <li key={`sch-${m.id}`}>
                      {m.terrain && <span className="trn-terrain">{m.terrain}</span>}
                      <span>
                        {m.p1?.name} <span className="muted">vs</span> {m.p2?.name}
                      </span>
                    </li>
                  ))}
              </ul>
            </section>
          )}

          {/* Poules */}
          {detail.pools?.map((pool) => (
            <section key={pool.label} className="trn-block">
              <h3>Poule {pool.label}</h3>
              <table className="trn-standings">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Joueur</th>
                    <th title="Matchs joués">MJ</th>
                    <th title="Victoires">V</th>
                    <th title="Défaites">D</th>
                    <th>Jeux</th>
                  </tr>
                </thead>
                <tbody>
                  {pool.standings.map((s) => (
                    <tr key={s.playerId}>
                      <td>{s.rank}</td>
                      <td>{s.name}</td>
                      <td>{s.played}</td>
                      <td>{s.wins}</td>
                      <td>{s.losses}</td>
                      <td>
                        {s.gamesFor}/{s.gamesAgainst}
                        <span className="muted">
                          {" "}
                          ({s.gameDiff >= 0 ? "+" : ""}
                          {s.gameDiff})
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <ul className="trn-matches">
                {pool.matches.map((m, i) => renderMatch(m, `${pool.label}-${i}`))}
              </ul>
            </section>
          ))}

          {/* Tableau (bracket) : arbre graphique du chemin principal + repêchage */}
          {detail.bracket &&
            (() => {
              const b = detail.bracket!;
              const winners = b.matches.filter((m) => m.phase === "winners");
              const classif = b.matches.filter((m) => m.phase === "classification");
              return (
                <section className="trn-block">
                  <h3>Tableau</h3>
                  {b.ranking && (
                    <table className="trn-standings">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>Joueur</th>
                          <th title="Matchs joués">MJ</th>
                          <th title="Victoires">V</th>
                          <th title="Défaites">D</th>
                        </tr>
                      </thead>
                      <tbody>
                        {b.ranking.map((r) => (
                          <tr key={r.playerId}>
                            <td>{r.rank}</td>
                            <td>{r.name}</td>
                            <td>{r.played}</td>
                            <td>{r.wins}</td>
                            <td>{r.losses}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {/* Arbre principal (chemin vers la 1re place) */}
                  <h4>Tableau principal</h4>
                  {renderTree(winners, (r) => (r === b.rounds - 1 ? "Finale" : `Tour ${r + 1}`))}
                  {/* Repêchage : les perdants (dès le 1er tour) ont AUSSI leur arbre —
                      leurs demi-finales puis leurs finales de classement. */}
                  {classif.length > 0 &&
                    (() => {
                      const minR = Math.min(...classif.map((m) => m.round ?? 0));
                      return (
                        <>
                          <h4>Tableau des perdants (repêchage)</h4>
                          {renderTree(classif, (r) =>
                            r === b.rounds - 1
                              ? "Finales de classement"
                              : r === minR
                                ? "Demi-finales des perdants"
                                : `Repêchage ${r - minR + 1}`,
                          )}
                        </>
                      );
                    })()}
                </section>
              );
            })()}
        </div>
      ) : (
        // --- Liste des tournois ---
        <div>
          <div className="trn-actions">
            <button onClick={openWizard} disabled={busy}>
              ➕ Nouveau tournoi
            </button>
          </div>
          {list === null ? (
            <p className="muted">Chargement…</p>
          ) : list.length === 0 ? (
            <p className="muted">Aucun tournoi. Crée le premier (6 à 16 joueurs).</p>
          ) : (
            <ul className="trn-list">
              {list.map((t) => (
                <li key={t.id}>
                  <button className="trn-list-item" onClick={() => setOpenId(t.id)}>
                    <strong>{t.name || `Tournoi du ${prettyDate(t.date)}`}</strong>
                    <small className="trn-count">
                      {t.playerCount} joueurs ·{" "}
                      <span className={"trn-status " + t.status}>
                        {STATUS_LABEL[t.status] ?? t.status}
                      </span>
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Assistant de création */}
      {wizardOpen && (
        <Dialog onClose={() => !busy && setWizardOpen(false)} closeOnOverlay={!busy} label="Nouveau tournoi" className="trn-wizard">
          <h3>➕ Nouveau tournoi</h3>

          {step === 1 && (
            <>
              <p className="muted tiny">
                Choisis les joueurs ({totalPlayers}/{MAX_PLAYERS}) — membres et/ou invités.
              </p>
              <div className="trn-roster">
                {members?.map((m) => (
                  <label key={m.id} className={"trn-check" + (picked.has(m.id) ? " on" : "")}>
                    <input
                      type="checkbox"
                      checked={picked.has(m.id)}
                      onChange={() => togglePick(m.id)}
                    />
                    {m.name}
                  </label>
                ))}
              </div>
              {guests.length > 0 && (
                <ul className="trn-guests">
                  {guests.map((g, i) => (
                    <li key={i}>
                      {g}
                      <button
                        type="button"
                        className="cancel"
                        onClick={() => setGuests((prev) => prev.filter((_, j) => j !== i))}
                        aria-label={`Retirer ${g}`}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="trn-guest-add">
                <input
                  type="text"
                  placeholder="Ajouter un invité (prénom)"
                  value={guestInput}
                  maxLength={40}
                  onChange={(e) => setGuestInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addGuest();
                    }
                  }}
                />
                <button type="button" className="secondary" onClick={addGuest}>
                  +
                </button>
              </div>
              <div className="modal-actions">
                <button type="button" className="secondary" onClick={() => setWizardOpen(false)}>
                  Annuler
                </button>
                <button
                  type="button"
                  onClick={() => {
                    buildSeeded();
                    setStep(2);
                  }}
                  disabled={totalPlayers < MIN_PLAYERS || totalPlayers > MAX_PLAYERS}
                >
                  Suivant
                </button>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <p className="muted tiny">
                Classe les joueurs du plus fort (n°1) au plus faible — glisse-les ou utilise les
                flèches. Ça crée les têtes de série : en poules le 1 et le 2 sont séparés ; en
                tableau le 1 rencontre le dernier, et le 1/4 (puis 2/3) peuvent se croiser en demie.
                {seeded.some((s) => s.clt) && " Ordre pré-rempli d'après le classement fédéral."}
              </p>
              <ol className="trn-seedlist">
                {seeded.map((s, i) => (
                  <li
                    key={s.key}
                    draggable
                    onDragStart={() => (dragIndex.current = i)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      if (dragIndex.current !== null) moveSeed(dragIndex.current, i);
                      dragIndex.current = null;
                    }}
                  >
                    <span className="trn-seed-num">{i + 1}</span>
                    <span className="trn-seed-name">{s.label}</span>
                    {s.clt && (
                      <span className="trn-seed-clt" title="Classement fédéral">
                        {s.clt}
                      </span>
                    )}
                    <span className="trn-seed-arrows">
                      <button
                        type="button"
                        className="secondary"
                        disabled={i === 0}
                        onClick={() => moveSeed(i, i - 1)}
                        aria-label={`Monter ${s.label}`}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={i === seeded.length - 1}
                        onClick={() => moveSeed(i, i + 1)}
                        aria-label={`Descendre ${s.label}`}
                      >
                        ↓
                      </button>
                    </span>
                  </li>
                ))}
              </ol>
              <div className="modal-actions">
                <button type="button" className="secondary" onClick={() => setStep(1)}>
                  Retour
                </button>
                <button type="button" onClick={() => setStep(3)}>
                  Suivant
                </button>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <label className="tri-field">
                Nom (optionnel)
                <input
                  type="text"
                  value={name}
                  maxLength={80}
                  placeholder="ex. Tournoi de printemps"
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label className="tri-field">
                Jour
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </label>
              <fieldset className="trn-choice">
                <legend>Matchs par joueur (environ)</legend>
                {[2, 3, 4].map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={target === t ? "on" : ""}
                    onClick={() => setTarget(t as 2 | 3 | 4)}
                  >
                    {t}
                  </button>
                ))}
              </fieldset>
              <fieldset className="trn-choice">
                <legend>Format d'un match</legend>
                <button
                  type="button"
                  className={bestOf === 3 ? "on" : ""}
                  onClick={() => setBestOf(3)}
                >
                  2 jeux gagnants
                </button>
                <button
                  type="button"
                  className={bestOf === 5 ? "on" : ""}
                  onClick={() => setBestOf(5)}
                >
                  3 jeux gagnants
                </button>
              </fieldset>
              <div className="modal-actions">
                <button type="button" className="secondary" onClick={() => setStep(2)}>
                  Retour
                </button>
                <button type="button" onClick={fetchProposals} disabled={busy}>
                  {busy ? "…" : "Voir les formules"}
                </button>
              </div>
            </>
          )}

          {step === 4 && proposals && (
            <>
              <p className="muted tiny">Choisis une formule ({seeded.length} joueurs) :</p>
              <ul className="trn-proposals">
                {proposals.map((p, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      className="trn-proposal"
                      disabled={busy}
                      onClick={() => generate(p)}
                    >
                      <strong>{p.label}</strong>
                      <small>
                        {p.matchesPerPlayer.min === p.matchesPerPlayer.max
                          ? `${p.matchesPerPlayer.min} matchs/joueur`
                          : `${p.matchesPerPlayer.min}–${p.matchesPerPlayer.max} matchs/joueur`}{" "}
                        · ~{p.estimatedMinutes} min
                        {p.fullRanking ? " · classement complet" : ""}
                      </small>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="modal-actions">
                <button type="button" className="secondary" onClick={() => setStep(3)}>
                  Retour
                </button>
              </div>
            </>
          )}
        </Dialog>
      )}

      {confirmDelete && (
        <Dialog onClose={() => setConfirmDelete(false)} label="Supprimer le tournoi">
          <h3>Supprimer ce tournoi ?</h3>
          <p className="muted tiny">Tous les matchs et résultats seront effacés.</p>
          <div className="modal-actions">
            <button className="secondary" onClick={() => setConfirmDelete(false)}>
              Garder
            </button>
            <button className="danger" onClick={doDelete}>
              Supprimer
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
