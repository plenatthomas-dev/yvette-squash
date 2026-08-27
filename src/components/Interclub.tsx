"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "@/components/Dialog";
import { readJson } from "@/lib/apiFetch";
import { EmptyState, Skeleton } from "@/components/Placeholders";
import {
  isValidBestOf,
  PLAYER_COLORS,
  playerColor,
  validGameSequence,
  winGamesFor,
  type GameScore,
} from "@/lib/interclub";

// Vue « Interclub » : les rencontres de championnat par équipes. Ce premier jet couvre le
// SOCLE — créer une rencontre, composer l'équipe, saisir les scores et les consulter. Le
// comptage en direct au bord du terrain viendra par-dessus, sans rien changer ici : la
// saisie a posteriori reste le mode de repli les soirs où personne ne marque.

type Team = { id: string; name: string };

type FixtureRow = {
  id: string;
  date: string;
  team: Team;
  opponent: string;
  home: boolean;
  division: string | null;
  matchCount: number;
  status: "scheduled" | "live" | "done";
  score: { home: number; away: number };
};

type MatchRow = {
  id: string;
  order: number;
  homeUserId: string | null;
  homeDisplayName: string;
  awayName: string;
  homeColor: string | null;
  awayColor: string | null;
  status: string;
  gamesHome: number | null;
  gamesAway: number | null;
  games: { number: number; home: number; away: number }[];
};

type Fixture = FixtureRow & {
  season: string | null;
  bestOf: number;
  winGames: number;
  isCreator: boolean;
  matches: MatchRow[];
};

const STATUS_LABEL: Record<FixtureRow["status"], string> = {
  scheduled: "À venir",
  live: "En cours",
  done: "Terminée",
};

/** "2026-09-03" → "jeu. 3 sept." — les rencontres se repèrent au jour de la semaine. */
function shortDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
}

function todayISO(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Pastille de couleur de maillot. Jamais un aplat sur toute la ligne (cf. DESIGN.md). */
function ColorDot({ color }: { color: string | null }) {
  const c = playerColor(color);
  if (!c) return null;
  return (
    <span className="ic-dot" style={{ background: c.bg, borderColor: c.fg }} title={`Maillot ${c.label}`}>
      <span className="sr-only">Maillot {c.label}</span>
    </span>
  );
}

export default function Interclub({
  toast,
  onExpired,
}: {
  toast: (type: "ok" | "err" | "info", msg: string) => void;
  onExpired: (status: number) => boolean;
}) {
  const [teams, setTeams] = useState<Team[]>([]);
  const [rows, setRows] = useState<FixtureRow[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [fixture, setFixture] = useState<Fixture | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  // Garde-fou multi-utilisateur : on ne rafraîchit pas pendant qu'une saisie est en vol,
  // sinon on écraserait l'écran de celui qui est en train de taper (cf. Tournament.tsx).
  const busyRef = useRef(false);
  busyRef.current = busy;

  const loadList = useCallback(async () => {
    try {
      const res = await fetch("/api/interclub", { cache: "no-store" });
      if (onExpired(res.status)) return;
      const data = await readJson<{ teams: Team[]; fixtures: FixtureRow[] }>(res);
      setTeams(data.teams);
      setRows(data.fixtures);
    } catch (e) {
      setRows([]);
      toast("err", (e as Error).message);
    }
  }, [toast, onExpired]);

  const loadFixture = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/interclub/${id}`, { cache: "no-store" });
        if (onExpired(res.status)) return;
        setFixture(await readJson<Fixture>(res));
      } catch (e) {
        toast("err", (e as Error).message);
        setOpenId(null);
      }
    },
    [toast, onExpired],
  );

  useEffect(() => {
    loadList();
  }, [loadList]);

  useEffect(() => {
    if (openId) loadFixture(openId);
    else setFixture(null);
  }, [openId, loadFixture]);

  // Rafraîchissement au retour sur l'onglet : plusieurs personnes saisissent en parallèle un
  // soir de rencontre. Pas d'intervalle — le palier gratuit ne supporte pas le polling.
  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState !== "visible" || busyRef.current) return;
      loadList();
      if (openId) loadFixture(openId);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [loadList, loadFixture, openId]);

  async function createFixture(form: {
    date: string;
    teamId: string;
    opponent: string;
    home: boolean;
    division: string;
    matchCount: number;
    bestOf: number;
  }) {
    setBusy(true);
    try {
      const res = await fetch("/api/interclub", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (onExpired(res.status)) return;
      const data = await readJson<{ id: string }>(res);
      toast("ok", "Rencontre créée");
      setCreating(false);
      await loadList();
      setOpenId(data.id);
    } catch (e) {
      toast("err", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveMatch(matchId: string, body: Record<string, unknown>) {
    if (!fixture) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/interclub/${fixture.id}/matches/${matchId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (onExpired(res.status)) return;
      await readJson(res);
      await loadFixture(fixture.id);
      await loadList();
    } catch (e) {
      toast("err", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (rows === null) return <Skeleton />;

  return (
    <section className="interclub">
      <div className="ic-head">
        <h3>Interclub</h3>
        <button onClick={() => setCreating(true)} disabled={teams.length === 0}>
          Nouvelle rencontre
        </button>
      </div>

      {rows.length === 0 ? (
        <EmptyState icon="🏸" text="Aucune rencontre pour le moment." />
      ) : (
        <ul className="ic-list">
          {rows.map((f) => (
            <li key={f.id}>
              <button className="ic-row" onClick={() => setOpenId(f.id)}>
                <span className="ic-date">{shortDate(f.date)}</span>
                <span className="ic-opponent">
                  {f.team.name} {f.home ? "reçoit" : "se déplace à"} {f.opponent}
                  {f.division && <span className="muted tiny"> · {f.division}</span>}
                </span>
                <span className="ic-score" aria-label={`Score ${f.score.home} à ${f.score.away}`}>
                  {f.score.home}–{f.score.away}
                </span>
                <span className={`ic-status ic-${f.status}`}>{STATUS_LABEL[f.status]}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {creating && (
        <CreateDialog teams={teams} busy={busy} onClose={() => setCreating(false)} onSubmit={createFixture} />
      )}

      {openId && fixture && (
        <FixtureDialog
          fixture={fixture}
          busy={busy}
          onClose={() => setOpenId(null)}
          onSaveMatch={saveMatch}
        />
      )}
    </section>
  );
}

// --- Création d'une rencontre ----------------------------------------------

function CreateDialog({
  teams,
  busy,
  onClose,
  onSubmit,
}: {
  teams: Team[];
  busy: boolean;
  onClose: () => void;
  onSubmit: (f: {
    date: string;
    teamId: string;
    opponent: string;
    home: boolean;
    division: string;
    matchCount: number;
    bestOf: number;
  }) => void;
}) {
  const [date, setDate] = useState(todayISO());
  const [teamId, setTeamId] = useState(teams[0]?.id ?? "");
  const [opponent, setOpponent] = useState("");
  const [home, setHome] = useState(true);
  const [division, setDivision] = useState("");
  const [matchCount, setMatchCount] = useState(4);
  const [bestOf, setBestOf] = useState(5);

  const canSubmit = !!date && !!teamId && opponent.trim().length > 0 && !busy;

  return (
    <Dialog onClose={onClose} label="Nouvelle rencontre">
      <h3>Nouvelle rencontre</h3>
      <label>
        Date
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <label>
        Équipe
        <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Club adverse
        <input
          value={opponent}
          onChange={(e) => setOpponent(e.target.value)}
          placeholder="ex. Squash de Massy"
          maxLength={60}
        />
      </label>
      <label>
        Division <span className="muted tiny">(facultatif)</span>
        <input
          value={division}
          onChange={(e) => setDivision(e.target.value)}
          placeholder="ex. D2 Hommes"
          maxLength={30}
        />
      </label>
      <fieldset>
        <legend className="tiny muted">Lieu</legend>
        <label>
          <input type="radio" checked={home} onChange={() => setHome(true)} /> À domicile
        </label>
        <label>
          <input type="radio" checked={!home} onChange={() => setHome(false)} /> À l&apos;extérieur
        </label>
      </fieldset>
      <div className="ic-form-row">
        <label>
          Nombre de matchs
          <input
            type="number"
            min={1}
            max={8}
            value={matchCount}
            onChange={(e) => setMatchCount(Number(e.target.value))}
          />
        </label>
        <label>
          Format
          <select value={bestOf} onChange={(e) => setBestOf(Number(e.target.value))}>
            <option value={5}>Au meilleur des 5 jeux</option>
            <option value={3}>Au meilleur des 3 jeux</option>
          </select>
        </label>
      </div>
      <div className="modal-actions">
        <button className="secondary" onClick={onClose}>
          Annuler
        </button>
        <button
          disabled={!canSubmit}
          onClick={() =>
            onSubmit({
              date,
              teamId,
              opponent,
              home,
              division,
              matchCount,
              bestOf: isValidBestOf(bestOf) ? bestOf : 5,
            })
          }
        >
          Créer
        </button>
      </div>
    </Dialog>
  );
}

// --- Détail d'une rencontre ------------------------------------------------

function FixtureDialog({
  fixture,
  busy,
  onClose,
  onSaveMatch,
}: {
  fixture: Fixture;
  busy: boolean;
  onClose: () => void;
  onSaveMatch: (matchId: string, body: Record<string, unknown>) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <Dialog onClose={onClose} label="Rencontre" className="ic-detail">
      <h3>
        {fixture.team.name} {fixture.home ? "–" : "chez"} {fixture.opponent}
      </h3>
      <p className="muted tiny">
        {shortDate(fixture.date)}
        {fixture.division && ` · ${fixture.division}`} · au meilleur des {fixture.bestOf} jeux (
        {fixture.winGames} gagnants)
      </p>
      <p className="ic-total">
        {fixture.score.home}–{fixture.score.away}{" "}
        <span className="muted tiny">{STATUS_LABEL[fixture.status]}</span>
      </p>

      <ul className="ic-matches">
        {fixture.matches.map((m) => (
          <li key={m.id}>
            {editing === m.id ? (
              <MatchEditor
                match={m}
                bestOf={fixture.bestOf}
                busy={busy}
                onCancel={() => setEditing(null)}
                onSave={(body) => {
                  onSaveMatch(m.id, body);
                  setEditing(null);
                }}
              />
            ) : (
              <button className="ic-match" onClick={() => setEditing(m.id)}>
                <span className="ic-order">#{m.order}</span>
                <span className="ic-players">
                  <span className="ic-player">
                    <ColorDot color={m.homeColor} />
                    {m.homeDisplayName}
                  </span>
                  <span className="muted tiny"> c. </span>
                  <span className="ic-player">
                    <ColorDot color={m.awayColor} />
                    {m.awayName}
                  </span>
                </span>
                <span className="ic-games">
                  {m.gamesHome === null ? (
                    <span className="muted tiny">à saisir</span>
                  ) : (
                    <>
                      {m.gamesHome}–{m.gamesAway}
                      {m.games.length > 0 && (
                        <span className="muted tiny">
                          {" "}
                          ({m.games.map((g) => `${g.home}-${g.away}`).join(", ")})
                        </span>
                      )}
                    </>
                  )}
                </span>
              </button>
            )}
          </li>
        ))}
      </ul>

      <div className="modal-actions">
        <button className="secondary" onClick={onClose}>
          Fermer
        </button>
      </div>
    </Dialog>
  );
}

// --- Saisie d'un match -----------------------------------------------------

function MatchEditor({
  match,
  bestOf,
  busy,
  onCancel,
  onSave,
}: {
  match: MatchRow;
  bestOf: number;
  busy: boolean;
  onCancel: () => void;
  onSave: (body: Record<string, unknown>) => void;
}) {
  const [homeName, setHomeName] = useState(match.homeDisplayName);
  const [awayName, setAwayName] = useState(match.awayName);
  const [homeColor, setHomeColor] = useState(match.homeColor ?? "");
  const [awayColor, setAwayColor] = useState(match.awayColor ?? "");
  const [games, setGames] = useState<GameScore[]>(
    match.games.map((g) => ({ home: g.home, away: g.away })),
  );

  const setGame = (i: number, side: "home" | "away", v: string) => {
    const n = v === "" ? 0 : Number(v);
    if (!Number.isInteger(n) || n < 0) return;
    setGames((prev) => prev.map((g, k) => (k === i ? { ...g, [side]: n } : g)));
  };

  // On ne laisse pas enregistrer un score que le serveur refusera : le moteur pur est le
  // MÊME des deux côtés, donc le message arrive avant l'aller-retour réseau.
  const sequenceOk = validGameSequence(games, bestOf);
  const maxGames = bestOf;

  return (
    <div className="ic-editor">
      <div className="ic-form-row">
        <label>
          Joueur
          <input value={homeName} onChange={(e) => setHomeName(e.target.value)} maxLength={40} />
        </label>
        <label>
          Adversaire
          <input value={awayName} onChange={(e) => setAwayName(e.target.value)} maxLength={40} />
        </label>
      </div>
      <div className="ic-form-row">
        <label>
          Maillot
          <select value={homeColor} onChange={(e) => setHomeColor(e.target.value)}>
            <option value="">—</option>
            {PLAYER_COLORS.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Maillot adverse
          <select value={awayColor} onChange={(e) => setAwayColor(e.target.value)}>
            <option value="">—</option>
            {PLAYER_COLORS.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="tiny muted">
        Jeux, dans l&apos;ordre. {winGamesFor(bestOf)} jeux gagnants.
      </p>
      {games.map((g, i) => (
        <div className="ic-game-row" key={i}>
          <span className="tiny muted">Jeu {i + 1}</span>
          <input
            type="number"
            min={0}
            value={g.home}
            aria-label={`Jeu ${i + 1}, points de ${homeName}`}
            onChange={(e) => setGame(i, "home", e.target.value)}
          />
          <span aria-hidden="true">–</span>
          <input
            type="number"
            min={0}
            value={g.away}
            aria-label={`Jeu ${i + 1}, points de ${awayName}`}
            onChange={(e) => setGame(i, "away", e.target.value)}
          />
          <button
            className="secondary tiny"
            onClick={() => setGames((prev) => prev.filter((_, k) => k !== i))}
            aria-label={`Supprimer le jeu ${i + 1}`}
          >
            ✕
          </button>
        </div>
      ))}
      {games.length < maxGames && (
        <button
          className="secondary"
          onClick={() => setGames((prev) => [...prev, { home: 0, away: 0 }])}
        >
          + Ajouter un jeu
        </button>
      )}

      {!sequenceOk && (
        <p className="notice error tiny" role="alert">
          Ce score est impossible : chaque jeu se gagne à 11 points avec 2 d&apos;écart, et aucun
          jeu ne se joue après la fin du match.
        </p>
      )}

      <div className="modal-actions">
        <button className="secondary" onClick={onCancel}>
          Annuler
        </button>
        <button
          disabled={busy || !sequenceOk}
          onClick={() =>
            onSave({
              homeDisplayName: homeName,
              awayName,
              homeColor: homeColor || null,
              awayColor: awayColor || null,
              games,
            })
          }
        >
          Enregistrer
        </button>
      </div>
    </div>
  );
}
