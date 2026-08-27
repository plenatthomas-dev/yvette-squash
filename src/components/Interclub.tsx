"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "@/components/Dialog";
import { readJson } from "@/lib/apiFetch";
import { EmptyState, Skeleton } from "@/components/Placeholders";
import {
  describeSequenceProblem,
  isValidBestOf,
  playedGames,
  PLAYER_COLORS,
  playerColor,
  winGamesFor,
  type GameScore,
} from "@/lib/interclub";

// Vue « Interclub » : les rencontres de championnat par équipes. Ce premier jet couvre le
// SOCLE — créer une rencontre, composer l'équipe, saisir les scores et les consulter. Le
// comptage en direct au bord du terrain viendra par-dessus, sans rien changer ici : la
// saisie a posteriori reste le mode de repli les soirs où personne ne marque.

type Team = { id: string; name: string };

type RosterEntry = { id: string; name: string; teamId: string | null; teamName: string | null };

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
  roster: RosterEntry[];
};

const STATUS_LABEL: Record<FixtureRow["status"], string> = {
  scheduled: "À venir",
  live: "En cours",
  done: "Terminée",
};

/** Placeholder posé à la création d'une rencontre dont la composition n'est pas connue. */
const UNSET = "À désigner";

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

/**
 * Pastille de couleur de maillot. Assez grosse pour se lire d'un coup d'œil depuis le bord du
 * terrain — c'est tout son intérêt — mais jamais un aplat sur la ligne : DESIGN.md réserve les
 * grandes surfaces colorées à ce qui est actionnable.
 */
function ColorDot({ color, size = "md" }: { color: string | null; size?: "md" | "lg" }) {
  const c = playerColor(color);
  if (!c) return null;
  return (
    <span
      className={`ic-dot ic-dot-${size}`}
      style={{ background: c.bg, borderColor: c.fg }}
      title={`Maillot ${c.label}`}
    >
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
                roster={fixture.roster}
                fixtureTeamId={fixture.team.id}
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
                    <ColorDot color={m.homeColor} size="lg" />
                    <span className={m.homeDisplayName === UNSET ? "muted" : undefined}>
                      {m.homeDisplayName}
                    </span>
                  </span>
                  <span className="ic-versus">c.</span>
                  <span className="ic-player">
                    <ColorDot color={m.awayColor} size="lg" />
                    <span className={m.awayName === UNSET ? "muted" : undefined}>{m.awayName}</span>
                  </span>
                </span>
                <span className="ic-games">
                  {m.gamesHome === null ? (
                    <span className="muted tiny">à saisir</span>
                  ) : (
                    <>
                      <span className="ic-gamescore">
                        {m.gamesHome}–{m.gamesAway}
                      </span>
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

// --- Choix de la couleur de maillot ----------------------------------------

/**
 * Sélecteur compact : une pastille posée à droite du nom, qui déplie une grille de couleurs.
 * Un `<select>` pleine largeur mangeait un tiers de l'écran pour une information secondaire,
 * et n'affichait la couleur que par son nom — alors que c'est justement le repère visuel.
 */
function ColorPicker({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const current = playerColor(value);

  return (
    <span className="ic-picker">
      <button
        type="button"
        className="ic-swatch-btn"
        aria-label={current ? `${label} : ${current.label}. Changer` : `${label} : choisir une couleur`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={current ? { background: current.bg, borderColor: current.fg } : undefined}
      >
        {!current && <span aria-hidden="true">?</span>}
      </button>

      {open && (
        <span className="ic-swatches" role="listbox" aria-label={label}>
          {PLAYER_COLORS.map((c) => (
            <button
              key={c.key}
              type="button"
              role="option"
              aria-selected={value === c.key}
              className={`ic-swatch${value === c.key ? " is-on" : ""}`}
              style={{ background: c.bg, borderColor: c.fg }}
              title={c.label}
              onClick={() => {
                onChange(c.key);
                setOpen(false);
              }}
            >
              <span className="sr-only">{c.label}</span>
            </button>
          ))}
          <button
            type="button"
            role="option"
            aria-selected={value === ""}
            className={`ic-swatch ic-swatch-none${value === "" ? " is-on" : ""}`}
            title="Aucune couleur"
            onClick={() => {
              onChange("");
              setOpen(false);
            }}
          >
            <span aria-hidden="true">✕</span>
            <span className="sr-only">Aucune couleur</span>
          </button>
        </span>
      )}
    </span>
  );
}

// --- Saisie d'un match -----------------------------------------------------

function MatchEditor({
  match,
  bestOf,
  roster,
  fixtureTeamId,
  busy,
  onCancel,
  onSave,
}: {
  match: MatchRow;
  bestOf: number;
  roster: RosterEntry[];
  fixtureTeamId: string;
  busy: boolean;
  onCancel: () => void;
  onSave: (body: Record<string, unknown>) => void;
}) {
  // "" = non renseigné, "__free__" = nom libre (remplaçant hors appli), sinon l'id du membre.
  const FREE = "__free__";
  const initialPick = match.homeUserId ?? (match.homeDisplayName === UNSET ? "" : FREE);
  const [pick, setPick] = useState(initialPick);
  const [freeName, setFreeName] = useState(match.homeUserId ? "" : match.homeDisplayName === UNSET ? "" : match.homeDisplayName);
  const [awayName, setAwayName] = useState(match.awayName === UNSET ? "" : match.awayName);
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

  // Le moteur pur est le MÊME des deux côtés : ce que l'écran refuse, le serveur le refuse
  // aussi, et réciproquement. Un jeu qu'on vient d'ouvrir (0-0) n'est pas une erreur — il est
  // simplement vide, et ne remonte donc aucun message.
  const problem = describeSequenceProblem(games, bestOf);

  // L'équipe de la rencontre d'abord : c'est là qu'on cherche 9 fois sur 10. Les autres
  // équipes restent accessibles, un joueur dépannant régulièrement l'équipe voisine.
  const ownTeam = roster.filter((r) => r.teamId === fixtureTeamId);
  const otherTeams = roster.filter((r) => r.teamId !== fixtureTeamId);

  return (
    <div className="ic-editor">
      <label className="ic-field">
        Joueur
        <span className="ic-field-row">
          <select value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">— à désigner —</option>
            {ownTeam.length > 0 && (
              <optgroup label={ownTeam[0].teamName ?? "Équipe"}>
                {ownTeam.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </optgroup>
            )}
            {otherTeams.length > 0 && (
              <optgroup label="Autres équipes">
                {otherTeams.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} {r.teamName ? `(${r.teamName})` : ""}
                  </option>
                ))}
              </optgroup>
            )}
            <option value={FREE}>Autre (nom libre)…</option>
          </select>
          <ColorPicker value={homeColor} onChange={setHomeColor} label="Maillot du joueur" />
        </span>
      </label>

      {pick === FREE && (
        <label className="ic-field">
          <span className="sr-only">Nom du remplaçant</span>
          <input
            value={freeName}
            onChange={(e) => setFreeName(e.target.value)}
            placeholder="Nom du remplaçant"
            maxLength={40}
          />
        </label>
      )}

      <label className="ic-field">
        Adversaire
        <span className="ic-field-row">
          <input
            value={awayName}
            onChange={(e) => setAwayName(e.target.value)}
            placeholder="Nom de l'adversaire"
            maxLength={40}
          />
          <ColorPicker value={awayColor} onChange={setAwayColor} label="Maillot de l'adversaire" />
        </span>
      </label>

      <p className="tiny muted ic-games-hint">
        Jeux, dans l&apos;ordre. {winGamesFor(bestOf)} jeux gagnants.
      </p>
      {games.map((g, i) => (
        <div className="ic-game-row" key={i}>
          <span className="tiny muted">Jeu {i + 1}</span>
          <input
            type="number"
            min={0}
            inputMode="numeric"
            value={g.home}
            aria-label={`Jeu ${i + 1}, points du joueur`}
            onChange={(e) => setGame(i, "home", e.target.value)}
          />
          <span aria-hidden="true">–</span>
          <input
            type="number"
            min={0}
            inputMode="numeric"
            value={g.away}
            aria-label={`Jeu ${i + 1}, points de l'adversaire`}
            onChange={(e) => setGame(i, "away", e.target.value)}
          />
          <button
            type="button"
            className="secondary ic-game-del"
            onClick={() => setGames((prev) => prev.filter((_, k) => k !== i))}
            aria-label={`Supprimer le jeu ${i + 1}`}
          >
            ✕
          </button>
        </div>
      ))}

      {games.length < bestOf && (
        <button
          type="button"
          className="secondary ic-add-game"
          onClick={() => setGames((prev) => [...prev, { home: 0, away: 0 }])}
        >
          + Ajouter un jeu
        </button>
      )}

      {problem && (
        <p className="notice error tiny ic-problem" role="alert">
          {problem}
        </p>
      )}

      <div className="modal-actions ic-editor-actions">
        <button type="button" className="secondary" onClick={onCancel}>
          Annuler
        </button>
        <button
          type="button"
          disabled={busy || !!problem}
          onClick={() =>
            onSave({
              // Un membre choisi prime : le serveur fige alors son nom d'affichage. Le nom
              // libre s'accompagne de `homeUserId: null` pour détacher le membre précédent.
              // Revenir sur « à désigner » doit aussi être possible : on remet le placeholder.
              ...(pick && pick !== FREE
                ? { homeUserId: pick }
                : pick === FREE && freeName.trim()
                  ? { homeUserId: null, homeDisplayName: freeName.trim() }
                  : pick === ""
                    ? { homeUserId: null, homeDisplayName: UNSET }
                    : {}),
              awayName: awayName.trim() || UNSET,
              homeColor: homeColor || null,
              awayColor: awayColor || null,
              // Les lignes vides ou inachevées ne partent pas : `problem` a déjà bloqué les
              // secondes, les premières sont juste des lignes qu'on a ouvertes sans s'en servir.
              games: playedGames(games),
            })
          }
        >
          Enregistrer
        </button>
      </div>
    </div>
  );
}
