"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Dialog } from "@/components/Dialog";
import { readOk } from "@/lib/apiFetch";
import { onForeground } from "@/lib/onForeground";
import { EmptyState, Skeleton } from "@/components/Placeholders";
import InterclubScorer from "@/components/InterclubScorer";
import InterclubFollow from "@/components/InterclubFollow";
import InterclubLive from "@/components/InterclubLive";
import { CLUB_TZ } from "@/lib/time";
import {
  COLOR_PRESETS,
  colorsTooClose,
  describeSequenceProblem,
  isValidBestOf,
  lineupComplete,
  playedGames,
  hexToHsv,
  hsvToHex,
  resolveColor,
  type Hsv,
  // ⚠️ Importé, jamais recopié : le client compare cette chaîne pour griser un nom et la
  // renvoie pour effacer un nom d'adversaire. Une divergence d'un caractère avec le serveur
  // faisait apparaître un « à désigner » qui n'en était plus un.
  UNSET_PLAYER,
  winGamesFor,
  type GameScore,
} from "@/lib/interclub";
import { compareRosterOrder, lineupOrderConflict, type OrderedSlot } from "@/lib/interclub-order";

// Vue « Interclub » : les rencontres de championnat par équipes.
//
// CE QUE CE FICHIER ORCHESTRE
// Il tient l'état de la vue — la liste des rencontres, celle qui est ouverte, le match qu'on
// marque — et délègue le reste à trois composants qui, eux, ne connaissent pas cet état :
//   * `InterclubFollow` (abonnement aux notifications) en tête de page, avant même la création
//     d'une rencontre : ces réglages décident de ce qu'on recevra dans trois semaines, pas de
//     ce qui se passe ce soir ;
//   * `InterclubLive` (le bandeau « en direct »), qui sonde pour son propre compte ;
//   * `InterclubScorer` (le marquage au bord du terrain), ouvert par-dessus le détail.
//
// DEUX MODES DE SAISIE, ET C'EST VOULU
// Le marquage EN DIRECT (`InterclubScorer`, point par point) et la saisie A POSTERIORI
// (`MatchEditor`, jeu par jeu) coexistent : le direct est le mode normal, la saisie a
// posteriori le repli des soirs où personne ne marque — et l'outil de correction quand le
// marqueur s'est trompé. Les deux écrivent par des routes différentes, avec des gardes
// différentes, mais valident par le MÊME moteur pur (`@/lib/interclub`) : ce que l'écran
// refuse, le serveur le refuse aussi.
//
// AUTORISATIONS : il n'y en a qu'une, « membre connecté ». Tout membre peut créer une
// rencontre, la composer et la marquer. Ce n'est pas un oubli — cf. `docs/interclub.md`. Les
// seules restrictions protègent d'un ÉCRASEMENT (la prise de marquage, un match déjà entamé),
// jamais d'un accès. L'écran n'a donc rien à masquer selon qui regarde.
//
// PAS D'INTERVALLE DE SONDAGE ICI : cet écran se rafraîchit au retour au premier plan et après
// chaque écriture. Le direct, lui, sonde — mais c'est `InterclubLive` qui s'en charge, et
// seulement quand il y a quelque chose à regarder.

type Team = { id: string; name: string };

// Le serveur ne renvoie QUE le roster de l'équipe qui dispute la rencontre : la restriction
// est appliquée là-bas, pas ici. Deux populations s'y mêlent — les MEMBRES (compte sur
// l'appli) et les joueurs sans compte, qu'un admin a inscrits au roster de l'équipe. Le
// `kind` sert à renvoyer le bon champ au serveur ; à l'écran, un joueur est un joueur.
type RosterEntry = {
  kind: "member" | "guest";
  id: string;
  name: string;
  /** Classement fédéral effectif, ou `null` si inconnu — décide de l'ordre des simples. */
  clt: string | null;
  /** Rang national mixte squashnet, ou `null` — départage deux joueurs de même classement dans
   *  le sélecteur (cf. `compareRosterOrder`) ; toujours `null` pour un invité. */
  rangM: number | null;
};

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
  /** Renseigné à la place de `homeUserId` quand le joueur aligné n'a pas de compte. */
  homeGuestId: string | null;
  homeDisplayName: string;
  awayName: string;
  homeColor: string | null;
  awayColor: string | null;
  status: string;
  gamesHome: number | null;
  gamesAway: number | null;
  games: { number: number; home: number; away: number }[];
  scorerId: string | null;
  scorerName: string | null;
  isMine: boolean;
  scorerStale: boolean;
  /** Instantané du jeu en cours, publié par le marqueur. `null` hors direct. */
  live: {
    current: { home: number; away: number };
    serving: "home" | "away" | null;
    servingBox: "right" | "left" | null;
    awaitingServeBox: boolean;
  } | null;
};

type Fixture = FixtureRow & {
  season: string | null;
  bestOf: number;
  winGames: number;
  isCreator: boolean;
  /** Le serveur autorise aussi les admins : l'écran doit suivre, pas deviner. */
  canDelete: boolean;
  matches: MatchRow[];
  roster: RosterEntry[];
};

const STATUS_LABEL: Record<FixtureRow["status"], string> = {
  scheduled: "À venir",
  live: "En cours",
  done: "Terminée",
};

/** Les mêmes trois états, côté SIMPLE. Le vocabulaire diffère : un match se « saisit ». */
const MATCH_STATUS_LABEL: Record<string, string> = {
  pending: "À saisir",
  live: "En cours",
  done: "Terminé",
};

/**
 * Onglets d'équipe.
 *
 * ⚠️ Le filtrage porte sur les rencontres DÉJÀ CHARGÉES, jamais sur une nouvelle requête. La
 * route accepte pourtant `?teamId`, et l'évidence serait de s'en servir — mais changer d'onglet
 * réveillerait alors Neon à chaque appui, sur un écran qu'on parcourt justement en tapotant.
 * Vingt rencontres tiennent en mémoire ; le palier gratuit, lui, ne tient pas le sondage.
 *
 * L'onglet sélectionné se marque par le POIDS et un trait, jamais par un aplat vert :
 * DESIGN.md réserve le vert à ce qui est actionnable, et un filtre actif est un état.
 */
function TeamTabs({
  teams,
  value,
  onChange,
}: {
  teams: Team[];
  value: string;
  onChange: (v: string) => void;
}) {
  const ids = ["all", ...teams.map((t) => t.id)];
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  // Navigation au clavier attendue d'un `tablist` : les flèches déplacent la sélection, et un
  // seul onglet reste dans l'ordre de tabulation (`tabIndex` roulant).
  const onKeyDown = (e: KeyboardEvent, i: number) => {
    const last = ids.length - 1;
    let next = -1;
    if (e.key === "ArrowRight") next = i === last ? 0 : i + 1;
    else if (e.key === "ArrowLeft") next = i === 0 ? last : i - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    else return;
    e.preventDefault();
    onChange(ids[next]);
    refs.current[next]?.focus();
  };

  return (
    <div className="ic-tabs" role="tablist" aria-label="Filtrer les rencontres par équipe">
      {ids.map((id, i) => (
        <button
          key={id}
          type="button"
          role="tab"
          id={`ic-tab-${id}`}
          aria-selected={value === id}
          aria-controls="ic-fixtures"
          tabIndex={value === id ? 0 : -1}
          ref={(el) => {
            refs.current[i] = el;
          }}
          className={`ic-tab${value === id ? " is-on" : ""}`}
          onClick={() => onChange(id)}
          onKeyDown={(e) => onKeyDown(e, i)}
        >
          {id === "all" ? "Toutes" : (teams.find((t) => t.id === id)?.name ?? id)}
        </button>
      ))}
    </div>
  );
}

/** "2026-09-03" → "jeu. 3 sept." — les rencontres se repèrent au jour de la semaine. */
function shortDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
}

/**
 * Date du jour en heure MURALE DU CLUB. Le dépôt a une règle unique sur ce point (lib/time.ts) :
 * ni le fuseau du serveur ni celui du navigateur ne doivent décider. Un membre en déplacement
 * hors Europe/Paris voyait sinon une date de rencontre décalée d'un jour.
 */
function todayISO(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: CLUB_TZ });
}

/**
 * Pastille de couleur de maillot. Assez grosse pour se lire d'un coup d'œil depuis le bord du
 * terrain — c'est tout son intérêt — mais jamais un aplat sur la ligne : DESIGN.md réserve les
 * grandes surfaces colorées à ce qui est actionnable.
 */
function ColorDot({ color, size = "md" }: { color: string | null; size?: "md" | "lg" }) {
  const c = resolveColor(color);
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
  const [scoring, setScoring] = useState<string | null>(null);
  /** Onglet d'équipe actif : `"all"` ou un `teamId`. Filtre d'affichage, rien de plus. */
  const [tab, setTab] = useState<string>("all");
  const [busy, setBusy] = useState(false);
  // Garde-fou multi-utilisateur : on ne rafraîchit pas pendant qu'une saisie est en vol,
  // sinon on écraserait l'écran de celui qui est en train de taper (cf. Tournament.tsx).
  const busyRef = useRef(false);
  busyRef.current = busy;

  // LES DEUX RAPPELS DU PARENT PASSENT PAR UNE REF, ET N'ENTRENT PLUS EN DÉPENDANCE.
  //
  // Les chargeurs ci-dessous sont des dépendances de `useEffect` : leur identité décide donc
  // du nombre de requêtes émises. La rattacher à celle de deux fonctions que le parent nous
  // passe, c'est confier cette décision à un détail de rendu qui ne nous regarde pas — et le
  // `catch` de `loadList` toaste, c'est-à-dire écrit dans l'état du parent. Une seule fonction
  // nue là-haut et le cycle se refermait : échec → toast → rendu → nouveau chargeur → effet
  // rejoué → échec. Sans fin, à la cadence de l'échec.
  //
  // Le parent mémoïse désormais les deux (cf. `handleExpired` dans `page.tsx`), ce qui suffit
  // à casser la boucle. Ces refs la rendent IMPOSSIBLE À ROUVRIR : la stabilité cesse d'être
  // une convention que l'appelant doit tenir, elle devient une propriété de ce fichier. Même
  // motif que `busyRef` juste au-dessus — on lit toujours la dernière version, jamais celle
  // capturée à la création.
  const onExpiredRef = useRef(onExpired);
  onExpiredRef.current = onExpired;
  const toastRef = useRef(toast);
  toastRef.current = toast;

  // …et c'est SOUS CETTE FORME qu'ils descendent aux enfants. `InterclubFollow`, `InterclubLive`
  // et `InterclubScorer` en font le même usage que nous — dépendances de `useCallback`, donc
  // d'effets qui émettent des requêtes — et repasser les rappels bruts leur transmettait
  // l'instabilité du parent en la contournant chez nous seulement. Le bandeau du direct, en
  // particulier, y perdait ses trois garde-fous de sondage.
  //
  // Deux enveloppes créées une fois pour toutes, qui lisent la dernière version au moment de
  // l'appel : tout le sous-arbre devient indifférent à la cadence de rendu de la page.
  const stableExpired = useCallback((status: number) => onExpiredRef.current(status), []);
  const stableToast = useCallback(
    (type: "ok" | "err" | "info", msg: string) => toastRef.current(type, msg),
    [],
  );

  const loadList = useCallback(async () => {
    try {
      const res = await fetch("/api/interclub", { cache: "no-store" });
      if (onExpiredRef.current(res.status)) return;
      const data = await readOk<{ teams: Team[]; fixtures: FixtureRow[] }>(res);
      setTeams(data.teams);
      setRows(data.fixtures);
    } catch (e) {
      setRows([]);
      toastRef.current("err", (e as Error).message);
    }
  }, []);

  const loadFixture = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/interclub/${id}`, { cache: "no-store" });
      if (onExpiredRef.current(res.status)) return;
      setFixture(await readOk<Fixture>(res));
    } catch (e) {
      // On NE ferme PAS le détail : ce rechargement se déclenche à chaque retour au premier
      // plan, donc à chaque déverrouillage du téléphone au bord du terrain. Le fermer sur un
      // échec réseau démontait l'écran de marquage EN PLEIN MATCH, sans relâcher la prise ni
      // laisser partir la synchro en attente.
      toastRef.current("err", (e as Error).message);
    }
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  useEffect(() => {
    if (openId) loadFixture(openId);
    else setFixture(null);
  }, [openId, loadFixture]);

  // Rafraîchissement au retour sur l'onglet : plusieurs personnes saisissent en parallèle un
  // soir de rencontre. Pas d'intervalle — le palier gratuit ne supporte pas le polling.
  //
  // `onForeground` dédoublonne la rafale `focus` + `visibilitychange` : cet écran recharge la
  // liste ET le détail ouvert, il partait donc en quatre requêtes à chaque déverrouillage du
  // téléphone au bord du terrain.
  useEffect(() => {
    return onForeground(() => {
      if (busyRef.current) return;
      loadList();
      if (openId) loadFixture(openId);
    });
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
      const data = await readOk<{ id: string }>(res);
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

  /** Prend le marquage puis ouvre l'écran. Sans la prise, deux personnes compteraient en
      parallèle et produiraient deux scores qu'on ne saurait pas départager. */
  async function startScoring(matchId: string) {
    if (!fixture) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/interclub/${fixture.id}/matches/${matchId}/claim`, {
        method: "POST",
      });
      if (onExpired(res.status)) return;
      await readOk(res);
      setScoring(matchId);
    } catch (e) {
      toast("err", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function stopScoring(matchId: string) {
    setScoring(null);
    if (!fixture) return;
    // Relâcher est un confort, pas une obligation : la prise se périme d'elle-même. On
    // n'affiche donc aucune erreur si l'appel échoue.
    await fetch(`/api/interclub/${fixture.id}/matches/${matchId}/claim`, {
      method: "DELETE",
    }).catch(() => {});
    await loadFixture(fixture.id);
    await loadList();
  }

  async function deleteFixture(id: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/interclub/${id}`, { method: "DELETE" });
      if (onExpired(res.status)) return;
      await readOk(res);
      toast("ok", "Rencontre supprimee");
      setOpenId(null);
      await loadList();
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
      await readOk(res);
      await loadFixture(fixture.id);
      await loadList();
    } catch (e) {
      toast("err", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const scoringMatch = scoring ? (fixture?.matches.find((m) => m.id === scoring) ?? null) : null;

  if (rows === null) return <Skeleton />;

  // Une équipe retirée pendant que son onglet était actif ne doit pas vider l'écran sans
  // explication : on retombe sur « Toutes ».
  const activeTab = tab !== "all" && !teams.some((t) => t.id === tab) ? "all" : tab;
  const visibleRows = activeTab === "all" ? rows : rows.filter((f) => f.team.id === activeTab);

  return (
    <section className="interclub">
      {/* L'abonnement OUVRE la page, avant même « Nouvelle rencontre ». Il vivait sous la liste
          des rencontres du jour, dans le bloc « En direct » : personne ne l'y trouvait, et on
          pouvait se croire abonné sans l'être. C'est le réglage le plus consulté de l'écran, et
          le seul qui décide de ce qu'on recevra les soirs où l'on n'ouvre pas l'appli. */}
      <InterclubFollow teams={teams} toast={stableToast} onExpired={stableExpired} />

      <div className="ic-head">
        <h3>Interclub</h3>
        <button onClick={() => setCreating(true)} disabled={teams.length === 0}>
          Nouvelle rencontre
        </button>
      </div>

      <InterclubLive onExpired={stableExpired} />

      {/* Les onglets ne s'affichent qu'à partir de DEUX équipes : avec une seule, un filtre
          qui ne filtre rien est du bruit. Le schéma prévoit la troisième. */}
      {teams.length > 1 && <TeamTabs teams={teams} value={activeTab} onChange={setTab} />}

      {rows.length === 0 ? (
        <EmptyState icon="🏸" text="Aucune rencontre pour le moment." />
      ) : (
        <ul
          className="ic-list"
          id="ic-fixtures"
          role={teams.length > 1 ? "tabpanel" : undefined}
          aria-labelledby={teams.length > 1 ? `ic-tab-${activeTab}` : undefined}
        >
          {visibleRows.length === 0 && (
            <li className="ic-empty-tab muted">Aucune rencontre pour cette équipe.</li>
          )}
          {visibleRows.map((f) => (
            <li key={f.id}>
              <button className={`ic-row ic-row-${f.status}`} onClick={() => setOpenId(f.id)}>
                <span className="ic-row-head">
                  <span className="ic-date" title={`Date de la rencontre : ${shortDate(f.date)}`}>
                    {shortDate(f.date)}
                  </span>
                  <span className={`ic-status ic-${f.status}`}>
                    <span className="sr-only">État : </span>
                    {STATUS_LABEL[f.status]}
                  </span>
                </span>
                <span className="ic-row-main">
                  <span className="ic-opponent">
                    {f.team.name}{" "}
                    <span className="ic-vs-word">{f.home ? "reçoit" : "se déplace à"}</span>{" "}
                    {f.opponent}
                  </span>
                  {/* Une rencontre pas encore commencée n'a pas de score : afficher « 0–0 »
                      annonçait un nul là où il n'y a rien eu. */}
                  {f.status === "scheduled" ? (
                    <span className="ic-score ic-score-none" aria-label="Pas encore jouée">
                      <span aria-hidden="true">–</span>
                    </span>
                  ) : (
                    <span className="ic-score" aria-label={`Score ${f.score.home} à ${f.score.away}`}>
                      {f.score.home}–{f.score.away}
                    </span>
                  )}
                </span>
                {f.division && <span className="ic-division">{f.division}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}

      {creating && (
        <CreateDialog teams={teams} busy={busy} onClose={() => setCreating(false)} onSubmit={createFixture} />
      )}

      {scoringMatch && fixture && (
        <InterclubScorer
          fixtureId={fixture.id}
          match={scoringMatch}
          bestOf={fixture.bestOf}
          onClose={() => stopScoring(scoringMatch.id)}
          onExpired={stableExpired}
          toast={stableToast}
        />
      )}

      {openId && fixture && !scoringMatch && (
        <FixtureDialog
          fixture={fixture}
          busy={busy}
          onClose={() => setOpenId(null)}
          onSaveMatch={saveMatch}
          onDelete={() => deleteFixture(fixture.id)}
          onScore={startScoring}
        />
      )}
    </section>
  );
}

// --- Création d'une rencontre ----------------------------------------------
//
// La COMPOSITION ne se fait pas ici, délibérément : on inscrit une rencontre bien avant de
// savoir qui jouera, et réclamer quatre noms à la création aurait fait de ce formulaire un
// obstacle. Les simples naissent donc « à désigner » (le serveur en crée `matchCount`), et se
// composent un par un depuis le détail, quand l'équipe se décide.

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
//
// C'est le pivot de la vue : il montre les simples, ouvre l'éditeur de l'un d'eux, et lance le
// marquage. Il calcule aussi `takenBy` — qui est déjà aligné où — parce qu'un joueur ne dispute
// qu'un simple par rencontre. Ce contrôle EXISTE AUSSI côté serveur (`findAlignmentClash`, dans
// la transaction) ; ici il ne sert qu'à griser le choix avant qu'on le fasse, avec le numéro du
// simple qui retient le joueur. Un écran qui empêche une faute vaut mieux qu'un message qui la
// signale — mais l'écran n'est jamais la garantie.

function FixtureDialog({
  fixture,
  busy,
  onClose,
  onSaveMatch,
  onDelete,
  onScore,
}: {
  fixture: Fixture;
  busy: boolean;
  onClose: () => void;
  onSaveMatch: (matchId: string, body: Record<string, unknown>) => void;
  onDelete: () => void;
  onScore: (matchId: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  // Confirmation en deux temps plutot qu'un confirm() natif : la suppression emporte tous les
  // matchs et leurs jeux, et une boîte de dialogue bloquante fige l'onglet.
  const [confirmDel, setConfirmDel] = useState(false);

  // Un joueur ne dispute qu'UN simple par rencontre. On retient donc qui est déjà pris, et par
  // quel simple, pour le griser dans le sélecteur — plutôt que de le proposer, de le laisser
  // choisir, et de faire refuser la sauvegarde par le serveur. Le contrôle sérieux reste côté
  // serveur (cf. findAlignmentClash) ; celui-ci évite juste de tendre un piège.
  const takenBy = new Map<string, number>();
  for (const m of fixture.matches) {
    const key = m.homeUserId
      ? `member:${m.homeUserId}`
      : m.homeGuestId
        ? `guest:${m.homeGuestId}`
        : null;
    if (key) takenBy.set(key, m.order);
  }

  // L'ORDRE des simples doit suivre le classement des joueurs désignés (cf. `interclub-order.ts`
  // — le mieux classé des joueurs présents joue le simple n° 1). Même logique que `takenBy` :
  // on grise ici les choix que le serveur refuserait, plutôt que de laisser composer puis
  // échouer à l'enregistrement.
  const rosterClt = new Map(fixture.roster.map((r) => [`${r.kind}:${r.id}`, r.clt]));
  const orderSlots: OrderedSlot[] = fixture.matches
    .filter((m) => m.homeDisplayName !== UNSET_PLAYER)
    .map((m) => {
      const key = m.homeUserId
        ? `member:${m.homeUserId}`
        : m.homeGuestId
          ? `guest:${m.homeGuestId}`
          : null;
      return { order: m.order, name: m.homeDisplayName, clt: key ? (rosterClt.get(key) ?? null) : null };
    });

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
          // La vignette porte l'état ET englobe les actions : un simple est UN bloc. Le bouton
          // de marquage vivait à côté de la ligne, sur le fond du dialogue — il paraissait
          // appartenir à la rencontre plutôt qu'au match qu'il concerne.
          <li
            key={m.id}
            className={editing === m.id ? "ic-match-card is-editing" : `ic-match-card ic-match-${m.status}`}
          >
            {editing === m.id ? (
              <MatchEditor
                match={m}
                bestOf={fixture.bestOf}
                roster={fixture.roster}
                takenBy={takenBy}
                orderSlots={orderSlots}
                teamName={fixture.team.name}
                busy={busy}
                onCancel={() => setEditing(null)}
                onSave={(body) => {
                  onSaveMatch(m.id, body);
                  setEditing(null);
                }}
              />
            ) : (
              <button className="ic-match" onClick={() => setEditing(m.id)}>
                <span className="ic-match-head">
                  <span className="ic-order">Simple {m.order}</span>
                  <span className={`ic-status ic-${m.status}`}>
                    <span className="sr-only">État : </span>
                    {MATCH_STATUS_LABEL[m.status] ?? m.status}
                  </span>
                </span>
                <span className="ic-players">
                  <span className="ic-player">
                    <ColorDot color={m.homeColor} size="lg" />
                    <span className={m.homeDisplayName === UNSET_PLAYER ? "muted" : undefined}>
                      {m.homeDisplayName}
                    </span>
                  </span>
                  <span className="ic-versus" title="contre">
                    <span className="sr-only">contre</span>
                    <span aria-hidden="true">c.</span>
                  </span>
                  <span className="ic-player">
                    <ColorDot color={m.awayColor} size="lg" />
                    <span className={m.awayName === UNSET_PLAYER ? "muted" : undefined}>{m.awayName}</span>
                  </span>
                </span>
                {(m.live || m.gamesHome !== null) && (
                  <span className="ic-games">
                    {m.games.length > 0 && (
                      <span className="ic-gamelist">
                        {m.games.map((g) => `${g.home}-${g.away}`).join(" · ")}
                      </span>
                    )}
                    {m.live && (
                      <span className="ic-inplay" title="Jeu en cours">
                        {m.live.current.home}–{m.live.current.away}
                      </span>
                    )}
                    {m.gamesHome !== null && (
                      <span
                        className="ic-gamescore"
                        aria-label={`Jeux gagnés : ${m.gamesHome} à ${m.gamesAway}`}
                      >
                        {m.gamesHome}–{m.gamesAway}
                      </span>
                    )}
                  </span>
                )}
              </button>
            )}
            {editing !== m.id && m.status !== "done" && (
              <div className="ic-match-actions">
                <button
                  className="secondary ic-score-btn"
                  disabled={!lineupComplete(m.homeDisplayName, m.awayName)}
                  title={
                    lineupComplete(m.homeDisplayName, m.awayName)
                      ? undefined
                      : "Désigne les deux joueurs avant de marquer en direct"
                  }
                  onClick={() => onScore(m.id)}
                >
                  {m.isMine ? "Reprendre le marquage" : "Marquer en direct"}
                </button>
                {m.scorerName && !m.isMine && (
                  <span className="muted tiny">
                    {m.scorerStale ? `${m.scorerName} a laissé le marquage` : `${m.scorerName} marque`}
                  </span>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      <div className="modal-actions ic-detail-actions">
        {fixture.canDelete &&
          (confirmDel ? (
            <>
              <button className="secondary" onClick={() => setConfirmDel(false)}>
                Non, garder
              </button>
              <button className="danger" disabled={busy} onClick={onDelete}>
                Supprimer définitivement
              </button>
            </>
          ) : (
            <button className="secondary ic-delete" disabled={busy} onClick={() => setConfirmDel(true)}>
              Supprimer
            </button>
          ))}
        {!confirmDel && (
          <button className="secondary" onClick={onClose}>
            Fermer
          </button>
        )}
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
// Couleur de maillot : une pastille qui ouvre une palette. Elle sert à distinguer les deux
// joueurs d'un coup d'œil sur l'écran de marquage, montré à bout de bras — d'où la palette
// restreinte (`COLOR_PRESETS`) et l'alerte quand les deux couleurs sont trop proches
// (`colorsTooClose`) : deux maillots indiscernables rendent le marqueur hésitant au pire
// moment.
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
  /** Le panneau « autre couleur » est-il déplié ? */
  const [free, setFree] = useState(false);
  const current = resolveColor(value);
  const isCustom = !!current && !COLOR_PRESETS.some((c) => c.hex === current.bg);

  const hsv = hexToHsv(current?.bg ?? "") ?? { h: 0, s: 0.7, v: 0.8 };
  const pose = (next: Hsv) => onChange(hsvToHex(next));
  const borne = (u: number) => Math.min(1, Math.max(0, u));

  const areaRef = useRef<HTMLDivElement>(null);
  /** Traduit un point de l'aire en saturation/valeur. Origine en haut à gauche. */
  const pointer = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = areaRef.current?.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return;
    pose({
      ...hsv,
      s: borne((e.clientX - r.left) / r.width),
      v: 1 - borne((e.clientY - r.top) / r.height),
    });
  };

  const PAS = 0.02;
  const clavier = (e: KeyboardEvent<HTMLDivElement>) => {
    const gestes: Record<string, [number, number]> = {
      ArrowLeft: [-PAS, 0],
      ArrowRight: [PAS, 0],
      ArrowUp: [0, PAS],
      ArrowDown: [0, -PAS],
    };
    const g = gestes[e.key];
    if (!g) return;
    e.preventDefault();
    const f = e.shiftKey ? 5 : 1;
    pose({ ...hsv, s: borne(hsv.s + g[0] * f), v: borne(hsv.v + g[1] * f) });
  };

  return (
    <span className="ic-picker">
      <button
        type="button"
        className="ic-swatch-btn"
        aria-label={current ? `${label} : ${current.label}. Changer` : `${label} : choisir une couleur`}
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
          setFree(false);
        }}
        style={current ? { background: current.bg, borderColor: current.fg } : undefined}
      >
        {!current && <span aria-hidden="true">?</span>}
      </button>

      {open && (
        <span className="ic-swatches">
          <span className="ic-swatch-grid">
            {COLOR_PRESETS.map((c) => (
              <button
                key={c.key}
                type="button"
                aria-label={c.label}
                className={`ic-swatch${value.toLowerCase() === c.hex ? " is-on" : ""}`}
                style={{ background: c.hex }}
                title={c.label}
                onClick={() => {
                  onChange(c.hex);
                  setOpen(false);
                }}
              />
            ))}

            {/* Déplie l'aire de choix libre, au lieu d'appeler le sélecteur du système : celui-ci
                présente, selon la plateforme, trois curseurs teinte/saturation/valeur où l'on
                cherche une couleur à l'aveugle. L'aire carrée montre d'un coup toutes les
                nuances d'une teinte — c'est le geste que tout le monde connaît. */}
            <button
              type="button"
              className={`ic-swatch ic-swatch-free${isCustom ? " is-custom" : ""}${free ? " is-on" : ""}`}
              aria-expanded={free}
              title={isCustom ? `Couleur personnalisée ${current?.bg}` : "Autre couleur…"}
              style={isCustom && current ? { background: current.bg } : undefined}
              onClick={() => setFree((f) => !f)}
            >
              <span className="sr-only">Choisir une autre couleur</span>
            </button>

            <button
              type="button"
              aria-label="Aucune couleur"
              className={`ic-swatch ic-swatch-none${value === "" ? " is-on" : ""}`}
              title="Aucune couleur"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
            >
              <span aria-hidden="true">✕</span>
            </button>
          </span>

          {free && (
            <span className="ic-free">
              {/* L'aire : saturation en abscisse, valeur en ordonnée, sur la teinte courante.
                  Deux dégradés superposés — blanc→transparent, puis transparent→noir — donnent
                  exactement le carré classique, sans une seule image. */}
              <div
                ref={areaRef}
                className="ic-free-area"
                style={{ backgroundColor: hsvToHex({ h: hsv.h, s: 1, v: 1 }) }}
                role="application"
                aria-label="Saturation et luminosité — flèches pour ajuster"
                tabIndex={0}
                onKeyDown={clavier}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  pointer(e);
                }}
                onPointerMove={(e) => {
                  if (e.buttons !== 0) pointer(e);
                }}
              >
                <span
                  className="ic-free-dot"
                  style={{
                    left: `${hsv.s * 100}%`,
                    top: `${(1 - hsv.v) * 100}%`,
                    background: current?.bg ?? "#888888",
                  }}
                />
              </div>

              {/* La teinte reste un curseur natif : une seule dimension, accessible au clavier
                  sans une ligne de code, et déjà annoncée par les lecteurs d'écran. Avec les
                  flèches sur l'aire, c'est ce qui garantit que tout se fait sans souris. */}
              <input
                className="ic-free-hue"
                type="range"
                min={0}
                max={359}
                value={Math.round(hsv.h)}
                aria-label="Teinte"
                onChange={(e) => pose({ ...hsv, h: Number(e.target.value) })}
              />

            </span>
          )}
        </span>
      )}
    </span>
  );
}

// --- Saisie d'un match -----------------------------------------------------
//
// La saisie A POSTERIORI : composition, couleurs de maillot, et les jeux TERMINÉS d'un match
// qu'on n'a pas marqué en direct. Elle ne remplace pas le marquage — elle le complète et le
// corrige.
//
// ⚠️ Ce formulaire REMPLACE intégralement la liste des jeux ; il porte donc `knownGameCount`,
// le nombre de jeux qu'il avait sous les yeux en s'ouvrant. Le serveur refuse l'écriture si la
// base en a davantage : sans cela, un écran resté ouvert pendant qu'un marqueur travaillait
// effaçait son travail en enregistrant, et aucune transaction n'aurait pu s'en apercevoir — les
// deux écritures ne sont pas concurrentes, la seconde est juste calculée sur un état périmé.

function MatchEditor({
  match,
  bestOf,
  roster,
  takenBy,
  orderSlots,
  teamName,
  busy,
  onCancel,
  onSave,
}: {
  match: MatchRow;
  bestOf: number;
  roster: RosterEntry[];
  /** Joueur déjà aligné → numéro du simple qui le retient, dans CETTE rencontre. */
  takenBy: Map<string, number>;
  /** Simples déjà désignés (hors CELUI-CI), pour griser un choix qui romprait l'ordre. */
  orderSlots: OrderedSlot[];
  teamName: string;
  busy: boolean;
  onCancel: () => void;
  onSave: (body: Record<string, unknown>) => void;
}) {
  // "" = non renseigné, sinon `member:<id>` ou `guest:<id>`. Pas de nom libre : la règle du
  // club veut que seuls les joueurs du roster de l'équipe soient alignés, et un joueur sans
  // compte y entre par l'espace admin — pas par une case de texte de cet écran.
  //
  // Le préfixe est nécessaire : rien ne garantit qu'un id de membre et un id d'invité ne se
  // ressemblent pas, et le serveur attend deux champs différents.
  const [pick, setPick] = useState(
    match.homeUserId ? `member:${match.homeUserId}` : match.homeGuestId ? `guest:${match.homeGuestId}` : "",
  );
  const [awayName, setAwayName] = useState(match.awayName === UNSET_PLAYER ? "" : match.awayName);
  const [homeColor, setHomeColor] = useState(match.homeColor ?? "");
  const [awayColor, setAwayColor] = useState(match.awayColor ?? "");
  /**
   * Les points sont gardés en TEXTE, pas en nombre — pour qu'une case vide reste vide.
   *
   * L'état numérique obligeait à choisir une valeur pour « rien saisi », et c'était `0`. Un
   * jeu ajouté s'ouvrait donc sur « 0 – 0 », qui se lit comme un score et non comme une case
   * à remplir : il faut effacer le zéro avant de taper, et un jeu oublié ressemble à un vrai
   * 0-0. La chaîne vide dit ce qu'elle est.
   *
   * La conversion se fait à un seul endroit (`nums`), et une case vide y vaut 0 : c'est
   * exactement ce que faisait l'ancien état, donc rien ne change ni pour la validation ni pour
   * ce qui part au serveur.
   */
  const [games, setGames] = useState<{ home: string; away: string }[]>(
    match.games.map((g) => ({ home: String(g.home), away: String(g.away) })),
  );
  const nums: GameScore[] = games.map((g) => ({
    home: g.home === "" ? 0 : Number(g.home),
    away: g.away === "" ? 0 : Number(g.away),
  }));

  // ⚠️ FIGÉ AU MONTAGE, comme tout ce qui précède — et pour la même raison.
  //
  // C'est le nombre de jeux que CET ÉCRAN a vus, celui qui doit être confronté à la base. Le
  // lire dans la prop `match` au moment du clic annulait la garde : `match` est dérivée de
  // l'état du parent, que `loadFixture` remplace à chaque retour au premier plan et après
  // chaque écriture, tandis que ce formulaire reste monté (aucune `key` ne le recrée) avec son
  // `games` d'origine. Un verrouillage d'écran suffisait donc à rafraîchir la prop sans
  // rafraîchir le formulaire : on envoyait le compte que le serveur allait lui-même lire, la
  // comparaison devenait tautologique, et le jeu saisi entre-temps par quelqu'un d'autre était
  // effacé sans un mot. Le mécanisme serveur était bon ; c'est ce qu'on lui donnait qui ne
  // décrivait plus l'écran.
  const [knownGameCount] = useState(match.games.length);

  const setGame = (i: number, side: "home" | "away", v: string) => {
    // La case vide est un état légitime, pas une valeur refusée.
    if (v !== "" && !/^\d+$/.test(v)) return;
    setGames((prev) => prev.map((g, k) => (k === i ? { ...g, [side]: v } : g)));
  };

  // Le moteur pur est le MÊME des deux côtés : ce que l'écran refuse, le serveur le refuse
  // aussi, et réciproquement. Un jeu qu'on vient d'ouvrir (0-0) n'est pas une erreur — il est
  // simplement vide, et ne remonte donc aucun message.
  const problem = describeSequenceProblem(nums, bestOf);

  // Un « à désigner » ne doit jamais commencer à jouer : on n'ouvre même pas de nouvelle ligne
  // de score tant que les deux joueurs de CET écran ne sont pas choisis. Le serveur refuse la
  // même chose (`lineupComplete`), mais tendre le bouton pour se le faire refuser ensuite serait
  // un piège — même logique que `takenBy` sur le sélecteur de joueur.
  const lineupUnready = !pick || !awayName.trim();

  // Les AUTRES simples désignés de la rencontre, celui-ci excepté (on le remplace, pas on
  // l'ajoute). Sert à griser, dans le sélecteur, le joueur dont l'alignement romprait l'ordre
  // par classement — même logique que `takenBy` juste au-dessus.
  const otherOrderSlots = orderSlots.filter((s) => s.order !== match.order);

  // Le sélecteur liste le roster du MIEUX classé au MOINS bien, pas alphabétiquement : à
  // classement égal (deux « 5A »), le rang mixte squashnet connu départage, le plus petit en
  // tête ; à défaut, l'ordre alphabétique reçu du serveur suffit (tri stable, cf.
  // `compareRosterOrder`). Refait à chaque rendu plutôt que mémoïsé : le roster est une petite
  // liste, et il change à chaque frappe de `pick`.
  const sortedRoster = [...roster].sort(compareRosterOrder);

  return (
    <div className="ic-editor">
      <label className="ic-field">
        Joueur
        <span className="ic-field-row">
          <select value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">— à désigner —</option>
            {sortedRoster.map((r) => {
              const key = `${r.kind}:${r.id}`;
              // Comparé au NUMÉRO du simple et non au choix courant : le joueur que ce
              // simple-ci retient doit rester sélectionnable ici (sinon on ne pourrait plus
              // revenir en arrière après avoir changé d'avis), mais nulle part ailleurs.
              const at = takenBy.get(key);
              const taken = at !== undefined && at !== match.order;
              // Sans classement connu, un joueur ne peut disputer AUCUN simple — pas seulement
              // ceux où une comparaison d'ordre est possible. Même logique que `taken` : on
              // grise plutôt que de laisser composer pour se faire refuser par le serveur.
              const noClt = r.clt == null;
              // Romprait-il l'ordre des simples par classement s'il jouait CELUI-CI ? Même
              // logique que `taken` : on grise plutôt que de laisser composer pour rien.
              const orderProblem =
                taken || noClt
                  ? null
                  : lineupOrderConflict([...otherOrderSlots, { order: match.order, name: r.name, clt: r.clt }]);
              const blocked = taken || noClt || !!orderProblem;
              return (
                <option key={key} value={key} disabled={blocked}>
                  {r.name}
                  {r.clt ? ` (${r.clt})` : ""}
                  {taken
                    ? ` — joue déjà le match n° ${at}`
                    : noClt
                      ? " — classement inconnu"
                      : orderProblem
                        ? " — hors ordre de classement"
                        : ""}
                </option>
              );
            })}
          </select>
          <ColorPicker value={homeColor} onChange={setHomeColor} label="Maillot du joueur" />
        </span>
      </label>

      {roster.length === 0 && (
        <p className="notice tiny" role="status">
          Aucun joueur n&apos;est rattaché à {teamName}. Un administrateur compose le roster de
          l&apos;équipe depuis l&apos;espace admin — les membres inscrits sur la page Membres,
          les joueurs sans compte dans la section « Équipes interclub ».
        </p>
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
          disabled={lineupUnready}
          title={lineupUnready ? "Désigne les deux joueurs avant de saisir un score" : undefined}
          onClick={() => setGames((prev) => [...prev, { home: "", away: "" }])}
        >
          + Ajouter un jeu
        </button>
      )}

      {lineupUnready && games.length === 0 && (
        <p className="notice tiny ic-problem" role="status">
          Désigne les deux joueurs avant de saisir un score.
        </p>
      )}

      {colorsTooClose(homeColor, awayColor) && (
        // Avertissement, jamais un blocage : peut-être que les deux équipes jouent VRAIMENT
        // dans des maillots voisins ce soir-là, et l'appli n'a pas à mentir sur le réel.
        <p className="notice tiny ic-problem" role="status">
          Ces deux maillots se ressemblent trop pour se distinguer d&apos;un coup d&apos;œil
          depuis le bord du terrain.
        </p>
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
              // Un joueur choisi : le serveur fige son nom d'affichage et vérifie au passage
              // qu'il est bien du roster de l'équipe. Les deux clés partent TOUJOURS ensemble,
              // y compris à `null` — c'est ce qui dit au serveur « la composition est touchée »,
              // et c'est ainsi qu'on revient à « à désigner » (le placeholder est posé
              // là-bas, jamais envoyé d'ici).
              homeUserId: pick.startsWith("member:") ? pick.slice(7) : null,
              homeGuestId: pick.startsWith("guest:") ? pick.slice(6) : null,
              awayName: awayName.trim() || UNSET_PLAYER,
              homeColor: homeColor || null,
              awayColor: awayColor || null,
              // Les lignes vides ou inachevées ne partent pas : `problem` a déjà bloqué les
              // secondes, les premières sont juste des lignes qu'on a ouvertes sans s'en servir.
              games: playedGames(nums),
              // Combien de jeux cet écran avait sous les yeux en s'ouvrant. Le serveur refuse
              // d'écrire si la base en compte un autre nombre : entre l'ouverture du
              // formulaire et l'enregistrement, quelqu'un a pu clore un jeu au bord du terrain,
              // et `games` — qui REMPLACE tout — l'effacerait sans que rien ne le signale.
              knownGameCount,
            })
          }
        >
          Enregistrer
        </button>
      </div>
    </div>
  );
}
