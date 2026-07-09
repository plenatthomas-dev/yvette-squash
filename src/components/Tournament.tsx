"use client";

import { useCallback, useEffect, useState } from "react";
import { Dialog } from "@/components/Dialog";
import { MIN_PLAYERS, MAX_PLAYERS } from "@/lib/tournament";

// Vue « Tournoi » : liste des tournois, assistant de création (roster annuaire + invités,
// cible de matchs) → proposition de formule → génération, puis suivi (poules/tableau,
// liste des matchs par terrain, saisie des scores). Montants/scores en JEUX.

interface Member {
  id: string;
  name: string;
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
    ranking: { playerId: string; name: string; rank: number }[] | null;
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

  // Assistant de création
  const [wizardOpen, setWizardOpen] = useState(false);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [guests, setGuests] = useState<string[]>([]);
  const [guestInput, setGuestInput] = useState("");
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

  const fetchProposals = async () => {
    if (totalPlayers < MIN_PLAYERS || totalPlayers > MAX_PLAYERS) {
      toast("err", `Il faut de ${MIN_PLAYERS} à ${MAX_PLAYERS} joueurs`);
      return;
    }
    setBusy(true);
    try {
      const players = [
        ...[...picked].map((userId) => ({ userId })),
        ...guests.map((guestName) => ({ guestName })),
      ];
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
      setStep(3);
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

  // --- Rendu d'un match (score ou saisie) ---
  const canScore = !!detail && (detail.isParticipant || detail.isCreator);
  const renderMatch = (m: MatchView, key: string) => {
    const done = m.status === "done";
    const bye = m.status === "bye";
    const p1 = m.p1?.name ?? "—";
    const p2 = m.p2?.name ?? "—";
    return (
      <li key={key} className={"trn-match" + (done ? " done" : "")}>
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
      </li>
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
            <small className="muted">
              · {detail.players.length} joueurs · {STATUS_LABEL[detail.status]}
            </small>
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
                    <th>V</th>
                    <th>Jeux</th>
                  </tr>
                </thead>
                <tbody>
                  {pool.standings.map((s) => (
                    <tr key={s.playerId}>
                      <td>{s.rank}</td>
                      <td>{s.name}</td>
                      <td>{s.wins}</td>
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

          {/* Tableau (bracket) par tour */}
          {detail.bracket && (
            <section className="trn-block">
              <h3>Tableau</h3>
              {detail.bracket.ranking && (
                <ol className="trn-ranking">
                  {detail.bracket.ranking.map((r) => (
                    <li key={r.playerId}>{r.name}</li>
                  ))}
                </ol>
              )}
              {Array.from({ length: detail.bracket.rounds }).map((_, r) => {
                const ms = detail
                  .bracket!.matches.filter((m) => m.round === r)
                  // Vainqueurs (tableau principal) d'abord, repêchage ensuite.
                  .sort((a, b) => (a.phase === "winners" ? 0 : 1) - (b.phase === "winners" ? 0 : 1));
                if (ms.length === 0) return null;
                return (
                  <div key={r} className="trn-round">
                    <h4>Tour {r + 1} sur {detail.bracket!.rounds}</h4>
                    <ul className="trn-matches">
                      {ms.map((m, i) => renderMatch(m, `r${r}-${i}`))}
                    </ul>
                  </div>
                );
              })}
            </section>
          )}
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
                    <small className="muted">
                      {t.playerCount} joueurs · {STATUS_LABEL[t.status] ?? t.status}
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
                  onClick={() => setStep(2)}
                  disabled={totalPlayers < MIN_PLAYERS || totalPlayers > MAX_PLAYERS}
                >
                  Suivant
                </button>
              </div>
            </>
          )}

          {step === 2 && (
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
                <button type="button" className="secondary" onClick={() => setStep(1)}>
                  Retour
                </button>
                <button type="button" onClick={fetchProposals} disabled={busy}>
                  {busy ? "…" : "Voir les formules"}
                </button>
              </div>
            </>
          )}

          {step === 3 && proposals && (
            <>
              <p className="muted tiny">Choisis une formule ({totalPlayers} joueurs) :</p>
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
                <button type="button" className="secondary" onClick={() => setStep(2)}>
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
