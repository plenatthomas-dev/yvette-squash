"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import AuService from "./AuService";
import { Dialog } from "@/components/Dialog";
import { readOk } from "@/lib/apiFetch";
import { onForeground } from "@/lib/onForeground";
import { EmptyState, Skeleton } from "@/components/Placeholders";
import InterclubScorer from "@/components/InterclubScorer";
import InterclubFollow from "@/components/InterclubFollow";
import InterclubLive from "@/components/InterclubLive";
import InterclubTally from "@/components/InterclubTally";
import { InterclubAvailability } from "@/components/InterclubAvailability";
import MatchDuration from "@/components/MatchDuration";
import { fixtureDurationMs, formatDuration } from "@/lib/interclub-duree";
import { useMinuteClock } from "@/lib/useMinuteClock";
import { CLUB_TZ } from "@/lib/time";
import { downloadFixtureIcs } from "@/lib/ics";
import type { TieOutcome } from "@/lib/interclub-db";
import { InterclubStats } from "@/components/InterclubStats";
import { TrophyIcon } from "@/components/icons";
import {
  FIXTURE_STATUS_LABEL,
  fixtureDisplayStatus,
  isValidBestOf,
  lineupComplete,
  resolveColor,
  UNSET_PLAYER,
} from "@/lib/interclub";
import { type OrderedSlot } from "@/lib/interclub-order";
import { normalize } from "@/lib/squashnet/match";
import { estEquipeFictive } from "@/lib/squashnet/fictive";
import { type KnownOpponent } from "@/lib/interclub-opponents";
import { AUTRE_CLUB, type MatchRow, type RosterEntry } from "./interclub-shared";
import MatchEditor from "./InterclubMatchEditor";

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

/** Une ligne du classement de la poule, telle que la fédération la publie. */
type StandingRow = {
  rank: number;
  name: string;
  code: string | null;
  /** L'identifiant FÉDÉRAL. C'est lui qui dit « c'est nous », jamais le nom. */
  snTeamId: string | null;
  points: number;
  played: number;
  won: number;
  drawWon: number;
  drawLost: number;
  lost: number;
  /** Colonne « P », lue mais NON INTERPRÉTÉE — et donc jamais affichée (cf. `standings.ts`). */
  penalties: number;
  matches: { won: number; lost: number; diff: number };
  games: { won: number; lost: number; diff: number };
  rallies: { won: number; lost: number; diff: number };
};

/**
 * Une équipe, telle que la liste et la fiche la rendent. `captainName` n'accompagne que la
 * FICHE d'une rencontre (`serializeInterclub`) : la liste des équipes du sélecteur n'en a pas
 * besoin, d'où un champ facultatif plutôt que deux types presque identiques.
 */
type Team = {
  id: string;
  name: string;
  captainName?: string | null;
  /** Le classement de la poule, en cache. NULL = pas d'ancrage, ou poule non publiée. */
  standings?: StandingRow[] | null;
  /** Quand il a été téléchargé. Sans cette date, un tableau figé a l'air à jour. */
  standingsAt?: string | null;
  /** Notre identifiant dans cette poule, pour surligner notre ligne. */
  snTeamId?: string | null;
};

// Le serveur ne renvoie QUE le roster de l'équipe qui dispute la rencontre : la restriction
// est appliquée là-bas, pas ici. Deux populations s'y mêlent — les MEMBRES (compte sur
// l'appli) et les joueurs sans compte, qu'un admin a inscrits au roster de l'équipe. Le
// `kind` sert à renvoyer le bon champ au serveur ; à l'écran, un joueur est un joueur.

type FixtureRow = {
  id: string;
  date: string;
  // Ce qui fait d'une rencontre un RENDEZ-VOUS et pas seulement une ligne de résultat. Tous
  // nullables : une rencontre inscrite avant la publication du calendrier fédéral n'en sait
  // rien encore.
  time: string | null;
  venue: string | null;
  venueAddress: string | null;
  /** Journée de championnat, « J1 ». */
  round: string | null;
  /**
   * Faux = date PRÉVISIONNELLE. La fédération publie les journées non planifiées avec une date
   * bouchon commune ; l'afficher comme une date ferme est ce qui ferait déplacer quelqu'un
   * pour rien, d'où une mention explicite à l'écran.
   */
  dateConfirmed: boolean;
  team: Team;
  opponent: string;
  home: boolean;
  matchCount: number;
  status: "scheduled" | "live" | "done";
  score: { home: number; away: number };
  /**
   * Comment la LIGUE compte cette rencontre. NULL tant qu'elle n'est pas finie.
   *
   * Le score seul ne dit pas ce qu'on a gagné : depuis le passage de la division 4 à quatre
   * simples, un 2-2 vaut DEUX points de classement ou UN selon l'average, et rien à l'écran ne
   * permettait de savoir lequel.
   */
  outcome: TieOutcome | null;
};


type Fixture = FixtureRow & {
  season: string | null;
  bestOf: number;
  winGames: number;
  isCreator: boolean;
  /** Le serveur autorise aussi les admins : l'écran doit suivre, pas deviner. */
  canDelete: boolean;
  /** Même règle que `canDelete` aujourd'hui, champ distinct : cf. la note côté serveur. */
  canEdit: boolean;
  matches: MatchRow[];
  roster: RosterEntry[];
};


/**
 * Le RÉSULTAT au sens de la ligue, en toutes lettres.
 *
 * « E+ » et « E- » sont les intitulés du classement fédéral, et personne ne les devine : le mot
 * porte le sens, le sigle sert à retrouver sa ligne sur squashnet. Les deux, donc.
 */
const OUTCOME_LABEL: Record<TieOutcome["result"], string> = {
  win: "Victoire",
  loss: "Défaite",
  drawWon: "Nul gagné",
  drawLost: "Nul perdu",
  drawUnbroken: "Nul",
};

/**
 * Les cinq issues ramenées aux TROIS couleurs qui se distinguent d'un coup d'œil.
 *
 * Gagné, perdu, et « quelque chose entre les deux » : distinguer visuellement le nul gagné du
 * nul perdu demanderait deux teintes voisines, que personne ne séparerait en parcourant une
 * liste. La nuance est dans la ligne de résultat, qui l'écrit en toutes lettres.
 */
function issueClass(r: TieOutcome["result"]): "win" | "loss" | "draw" {
  return r === "win" ? "win" : r === "loss" ? "loss" : "draw";
}

/** Le sigle du classement, quand il y en a un. */
const OUTCOME_TAG: Partial<Record<TieOutcome["result"], string>> = {
  drawWon: "E+",
  drawLost: "E-",
};

const DECIDED_BY_LABEL: Record<NonNullable<TieOutcome["decidedBy"]>, string> = {
  matches: "aux matchs",
  games: "à l'average de jeux",
  rallies: "à l'average de points",
};

/**
 * La ligne de RÉSULTAT d'une rencontre terminée : ce qu'elle rapporte, et ce qui l'a tranché.
 *
 * Elle existe parce que « 2-2 » ne se suffit plus. À quatre simples, la moitié des issues
 * possibles est un nul, et un nul vaut deux points ou un seul selon l'average — l'écart entre
 * une deuxième place et une quatrième sur une saison. Le chiffre qui départage est donc montré
 * À CÔTÉ du verdict, et signalé comme décisif quand c'est lui qui a tranché : sans ça, « Nul
 * gagné » ressemble à une décision arbitraire de l'appli.
 *
 * Aucun vert ici, malgré la victoire : Règle du Vert Actionnable — un résultat est un ÉTAT, et
 * le vert appartient à ce qu'on peut toucher. La distinction tient au mot et à la graisse, ce
 * qui la laisse lisible en niveaux de gris.
 */
function TieOutcomeLine({ outcome }: { outcome: TieOutcome }) {
  const tag = OUTCOME_TAG[outcome.result];
  const pts = outcome.leaguePoints;
  const titre =
    outcome.decidedBy === null
      ? "Nul que ni les jeux ni les points ne départagent — la ligue tranche."
      : outcome.decidedBy === "matches"
        ? `${OUTCOME_LABEL[outcome.result]} — ${pts} point${pts === 1 ? "" : "s"} au classement.`
        : `Nul départagé ${DECIDED_BY_LABEL[outcome.decidedBy]} — ${pts} point${
            pts === 1 ? "" : "s"
          } au classement.`;

  return (
    <span className={`ic-outcome ic-outcome-${outcome.result}`} title={titre}>
      <span className="ic-outcome-verdict">
        {OUTCOME_LABEL[outcome.result]}
        {tag && <span className="ic-outcome-tag">{tag}</span>}
      </span>
      {pts !== null && (
        <span className="ic-outcome-pts">
          {pts} pt{pts === 1 ? "" : "s"}
        </span>
      )}
      <span className={`ic-outcome-avg${outcome.decidedBy === "games" ? " is-decisive" : ""}`}>
        jeux {outcome.games.home}–{outcome.games.away}
      </span>
      {/* Les points de jeu ne s'affichent que si TOUT le détail est saisi : un total partiel
          présenté comme un total désignerait le mauvais vainqueur d'un nul. */}
      {outcome.rallies && (
        <span
          className={`ic-outcome-avg${outcome.decidedBy === "rallies" ? " is-decisive" : ""}`}
        >
          points {outcome.rallies.home}–{outcome.rallies.away}
        </span>
      )}
    </span>
  );
}

/** « 2e », « 1er ». Le rang se lit d'un coup d'œil, pas en déchiffrant un nombre nu. */
function rangCourt(n: number): string {
  return n === 1 ? "1er" : `${n}e`;
}

/** « 4 sept. » — la fraîcheur du classement, à partir d'un horodatage complet. */
function jourCourt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

/**
 * Deux valeurs d'un simple, L'ÉQUIPE QUI REÇOIT D'ABORD. `nous` et `eux` sont dans le sens de la
 * donnée (`home` = notre joueur) ; `recoit` dit si c'est nous qui recevons.
 */
function dansLOrdre(recoit: boolean, nous: number, eux: number, sep = "–"): string {
  return recoit ? `${nous}${sep}${eux}` : `${eux}${sep}${nous}`;
}

/** Un écart signé, « +20 » / « -14 ». Le signe est l'information ; sans lui, tout se vaut. */
const signe = (n: number) => (n > 0 ? `+${n}` : `${n}`);

/**
 * Retire les équipes fictives (« EXEMPT », « Non Joue ») d'un classement DÉJÀ en cache, et
 * resserre les rangs derrière elles : sans quoi « 1, 2, 4 » laisse un trou qui se remarque.
 * Un rang n'est décalé que du nombre de lignes fictives classées STRICTEMENT devant lui, ce qui
 * garde les ex æquo publiés par la ligue.
 */
function sansFictives(rows: StandingRow[]): StandingRow[] {
  const fictifs = rows.filter((r) => estEquipeFictive(r.name)).map((r) => r.rank);
  if (fictifs.length === 0) return rows;
  return rows
    .filter((r) => !estEquipeFictive(r.name))
    .map((r) => ({ ...r, rank: r.rank - fictifs.filter((f) => f < r.rank).length }));
}

/** Un classement de poule, et celles de NOS équipes qui y figurent. */
type Poule = {
  key: string;
  rows: StandingRow[];
  standingsAt: string | null;
  /** Nos équipes présentes dans ce classement : `snTeamId` → nom chez nous (« Équipe 2 »). */
  ours: Map<string, string>;
};

/**
 * Les classements À AFFICHER, UN PAR POULE.
 *
 * Deux équipes du club dans la même poule rapportent chacune le même classement : l'afficher
 * deux fois ne dit rien de plus. On les regroupe sur l'ensemble des identifiants fédéraux du
 * tableau — deux relevés d'une même poule ont les mêmes équipes, même si l'un date de la veille.
 *
 * `ours` recense TOUTES nos équipes présentes dans la poule, pas seulement celles de l'onglet :
 * sur l'onglet « Équipe 1 », l'Équipe 2 reste surlignée, puisqu'elle est dans le même tableau.
 */
function poulesAffichees(teams: Team[], visibles: Team[]): Poule[] {
  const poules = new Map<string, Poule>();
  for (const t of visibles) {
    if (!t.standings?.length) continue;
    const rows = sansFictives(t.standings);
    if (rows.length === 0) continue;
    const key = rows
      .map((r) => r.snTeamId ?? r.name)
      .sort()
      .join("|");
    const deja = poules.get(key);
    if (deja) {
      // Le relevé le plus récent l'emporte : c'est lui qui est à jour.
      if ((t.standingsAt ?? "") > (deja.standingsAt ?? "")) {
        deja.rows = rows;
        deja.standingsAt = t.standingsAt ?? null;
      }
      continue;
    }
    const ours = new Map<string, string>();
    for (const e of teams) {
      if (e.snTeamId && rows.some((r) => r.snTeamId === e.snTeamId)) ours.set(e.snTeamId, e.name);
    }
    poules.set(key, { key, rows, standingsAt: t.standingsAt ?? null, ours });
  }
  return [...poules.values()];
}

/**
 * LE CLASSEMENT DE LA POULE.
 *
 * Replié par défaut, et c'est délibéré : c'est de la donnée de RÉFÉRENCE, consultée quand on se
 * demande où on en est, pas à chaque ouverture de l'écran. Le résumé porte déjà la réponse à la
 * question courante — notre rang — pour que l'ouvrir soit un choix et pas un passage obligé.
 *
 * Nos lignes sont reconnues par `snTeamId`, JAMAIS par le nom : la ligue écrit « Squash de
 * l'Yvette » là où nous écrivons « Équipe 2 », et deux équipes du club dans la même poule se
 * confondraient. Le jour où l'ancrage manque, aucune ligne n'est surlignée — c'est visible, et
 * c'est mieux qu'une ligne fausse mise en avant.
 *
 * Onze colonnes et pas dix-huit : le tableau fédéral en publie dix-huit, illisibles sur un
 * téléphone. Les trois ÉCARTS (matchs, jeux, points) y figurent pour toutes les équipes — ce
 * sont eux qui départagent une égalité de points ; le détail gagnés–perdus est donné en toutes
 * lettres SOUS le tableau, pour nos équipes seulement, là où il se lit.
 */
function StandingsTable({ poule }: { poule: Poule }) {
  const { rows, standingsAt, ours } = poule;
  const nous = rows.filter((r) => r.snTeamId && ours.has(r.snTeamId));
  // Plusieurs de nos équipes dans le tableau : chaque rang, chaque stat porte son nom.
  const plusieurs = nous.length > 1;
  const nomDe = (r: StandingRow) => (r.snTeamId && ours.get(r.snTeamId)) || r.name;

  return (
    <details className="ic-standings">
      <summary>
        <span className="ic-standings-title">
          <TrophyIcon />
          Classement
        </span>
        {/* Le rang en PASTILLE : c'est la réponse qu'on vient chercher, et noyée dans la
            phrase elle se lisait comme une précision de plus. */}
        {nous.map((r) => (
          <span key={r.snTeamId} className="ic-standings-rank">
            {plusieurs ? `${nomDe(r)} · ${rangCourt(r.rank)}` : rangCourt(r.rank)}
          </span>
        ))}
        <span className="ic-standings-sub muted tiny">
          {nous.length > 0 ? `sur ${rows.length}` : `${rows.length} équipes`}
          {/* La date de relevé n'est pas décorative : sans elle, un classement figé depuis
              trois semaines s'affiche exactement comme un classement à jour. */}
          {standingsAt && ` · au ${jourCourt(standingsAt)}`}
        </span>
      </summary>

      {/* Le tableau défile DANS son cadre : huit colonnes ne rentrent pas toujours, et une
          page qui défile horizontalement casse tout le reste de l'écran. */}
      <div className="ic-standings-scroll">
        <table className="ic-standings-table">
          <thead>
            <tr>
              <th scope="col" className="ic-st-rank" title="Rang dans la poule">
                #
              </th>
              <th scope="col" className="ic-st-team">
                Équipe
              </th>
              {/* RÈGLE DU MICRO ÉTIQUETÉ (DESIGN.md) : sous 0,8rem, une abréviation porte son
                  intitulé. `E+` et `E-` en avaient un, `J`, `V` et `D` non — trois colonnes
                  d'un même tableau, deux traitements. Le tableau jumeau (`InterclubStats`)
                  étiquette toutes les siennes. */}
              <th scope="col" title="Rencontres jouées">J</th>
              <th scope="col" title="Victoires — 3 points">V</th>
              <th scope="col" title="Nul gagné à l'average — 2 points">
                E+
              </th>
              <th scope="col" title="Nul perdu à l'average — 1 point">
                E-
              </th>
              <th scope="col" title="Défaites — 0 point">D</th>
              <th scope="col" className="ic-st-pts">
                Pts
              </th>
              {/* LES TROIS ÉCARTS, À LA DEMANDE DU CLUB : ce sont eux qui départagent deux équipes
                  à égalité de points, et la ligue les publie pour toutes. APRÈS « Pts » et pas
                  avant : sur un téléphone, le tableau défile, et les points doivent rester dans
                  le premier écran. Le détail gagnés–perdus reste sous le tableau, pour nous. */}
              <th scope="col" className="ic-st-diff" title="Différence de matchs (simples) gagnés et perdus">
                M±
              </th>
              <th scope="col" className="ic-st-diff" title="Différence de jeux gagnés et perdus">
                J±
              </th>
              <th scope="col" className="ic-st-diff" title="Différence de points gagnés et perdus">
                P±
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const cestNous = !!r.snTeamId && ours.has(r.snTeamId);
              return (
                <tr key={`${r.rank}-${r.snTeamId ?? r.name}`} className={cestNous ? "is-us" : ""}>
                  <td className="ic-st-rank">{r.rank}</td>
                  <th scope="row" className="ic-st-team" title={r.name}>
                    {r.name}
                    {cestNous && (
                      <span className="sr-only">
                        {plusieurs ? ` (notre ${nomDe(r)})` : " (notre équipe)"}
                      </span>
                    )}
                  </th>
                  <td>{r.played}</td>
                  <td>{r.won}</td>
                  <td>{r.drawWon}</td>
                  <td>{r.drawLost}</td>
                  <td>{r.lost}</td>
                  <td className="ic-st-pts">{r.points}</td>
                  <td className="ic-st-diff">{signe(r.matches.diff)}</td>
                  <td className="ic-st-diff">{signe(r.games.diff)}</td>
                  <td className="ic-st-diff">{signe(r.rallies.diff)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* LES AVERAGES, en toutes lettres et pour nous seulement. Ce sont eux qui départagent
          un nul 2-2 et deux équipes à égalité de points ; les noyer dans dix colonnes de plus
          les rendrait illisibles sur un téléphone, les taire les rendrait introuvables. */}
      {nous.map((r) => (
        <p key={r.snTeamId} className="ic-standings-avg muted tiny">
          {plusieurs ? `Stats ${nomDe(r)}` : "Nos stats"} — matchs {r.matches.won}&ndash;
          {r.matches.lost} ({signe(r.matches.diff)}) · jeux {r.games.won}&ndash;{r.games.lost} (
          {signe(r.games.diff)}) · points {r.rallies.won}&ndash;{r.rallies.lost} (
          {signe(r.rallies.diff)})
        </p>
      ))}
    </details>
  );
}

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
  /**
   * CE QU'ON SAIT DES ÉQUIPES ET DES JOUEURS D'EN FACE, pour remplir deux menus : celui du club
   * adverse à la création, celui de l'adversaire à la composition.
   *
   * Chargé UNE FOIS pour toutes les équipes, pas une fois par rencontre ouverte : la liste
   * change au rythme des rencontres jouées, pas des écrans ouverts, et une requête par
   * ouverture de détail serait un aller-retour de plus au bord du terrain, là où le réseau est
   * mauvais. Le filtrage par équipe adverse se fait ici, sur une liste de quelques dizaines de
   * noms (`KnownOpponent.team`).
   */
  const [known, setKnown] = useState<{ teams: string[]; players: KnownOpponent[] }>({
    teams: [],
    players: [],
  });
  const [rows, setRows] = useState<FixtureRow[] | null>(null);
  /** La route a-t-elle coupé la liste ? Affiché, jamais tu — cf. `loadList`. */
  const [truncated, setTruncated] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [fixture, setFixture] = useState<Fixture | null>(null);
  const [creating, setCreating] = useState(false);
  /** Admin seulement : les rencontres viennent du calendrier de la ligue (cf. le POST). */
  const [canCreate, setCanCreate] = useState(false);
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

  // ⚠️ LA LIMITE EST DEMANDÉE, ET C'EST LE PLAFOND DE LA ROUTE.
  //
  // Cet appel partait NU, donc avec le défaut de la route : VINGT rencontres, toutes équipes
  // confondues. Ça a tenu tant qu'une saison en comptait cinq par équipe. La poule 2026-27 en
  // compte vingt, et nos deux équipes y jouent : quarante lignes, coupées à vingt.
  //
  // Et la coupe tombait du mauvais côté. Le serveur trie par date DÉCROISSANTE : les vingt
  // servies étaient donc les vingt DERNIÈRES de la saison, et ce qui manquait était exactement
  // ce qu'on vient chercher en ouvrant l'écran — les prochaines journées. Le calendrier
  // s'ouvrait sur J13. Le tri « à venir d'abord » plus bas ne pouvait rien y faire : on ne
  // trie pas ce qu'on n'a pas reçu.
  //
  // Le filtrage par onglet aggravait le tout, parce qu'il est CLIENT (`f.team.id === tab`) : il
  // découpait dans les vingt déjà coupées, laissant une dizaine de lignes par équipe.
  //
  // Cent, c'est le plafond de la route. Au format 2026-27 — deux équipes, vingt journées — cela
  // couvre deux saisons et demie, et ce qui tombe au-delà est TOUJOURS le plus ancien (tri
  // décroissant) : la saison en cours y est entière quoi qu'il arrive. `hasMore` dit le reste.
  const loadList = useCallback(async () => {
    try {
      const res = await fetch("/api/interclub?limit=100", { cache: "no-store" });
      if (onExpiredRef.current(res.status)) return;
      const data = await readOk<{
        teams: Team[];
        fixtures: FixtureRow[];
        hasMore?: boolean;
        canCreate?: boolean;
      }>(res);
      setTeams(data.teams);
      setRows(data.fixtures);
      setCanCreate(data.canCreate === true);
      // La route renvoyait `hasMore` depuis toujours et PERSONNE NE LE LISAIT : une liste
      // tronquée était indiscernable d'une liste complète. C'est ce silence qui a fait chercher
      // la panne du côté de l'import, où il n'y avait rien.
      setTruncated(Boolean(data.hasMore));
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

  // Silencieux en cas d'échec, et VOLONTAIREMENT : ces deux menus sont un confort de saisie,
  // pas une donnée dont dépend l'écran. Sans eux, la saisie libre reste là et rien n'est perdu —
  // un toast d'erreur ne ferait qu'inquiéter pour une commodité absente.
  const loadKnown = useCallback(async () => {
    try {
      const res = await fetch("/api/interclub/opponents", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { teams?: unknown; players?: unknown };
      // GARDE DE FORME, et pas une politesse : ce qu'on stocke ici alimente deux `.map()` et un
      // `.filter()` au rendu, sans error boundary au-dessus. Une réponse d'un autre format —
      // un proxy, un déploiement à cheval sur deux versions — ferait tomber TOUTE la vue
      // interclub pour un menu de confort.
      setKnown({
        teams: Array.isArray(data.teams) ? (data.teams as string[]) : [],
        players: Array.isArray(data.players) ? (data.players as KnownOpponent[]) : [],
      });
    } catch {
      /* menus vides : la saisie libre suffit */
    }
  }, []);

  useEffect(() => {
    loadList();
    loadKnown();
  }, [loadList, loadKnown]);

  useEffect(() => {
    if (openId) loadFixture(openId);
    else setFixture(null);
  }, [openId, loadFixture]);

  /**
   * À L'OUVERTURE D'UNE RENCONTRE, ON REMET À JOUR LES JOUEURS DE L'ÉQUIPE D'EN FACE.
   *
   * Composer une rencontre, c'est désigner les joueurs adverses : c'est exactement le moment où
   * il faut savoir qui le club a inscrit. Le demander par un bouton, dans un AUTRE écran,
   * revenait à exiger qu'on ait pensé à le faire avant — et à laisser un champ vide à celui qui
   * n'y avait pas pensé.
   *
   * ⚠️ CE N'EST PAS UNE REQUÊTE FÉDÉRALE À CHAQUE OUVERTURE. Le serveur ne va chez la ligue que
   * si le roster manque ou date de plus d'une semaine (`ROSTER_FRAIS_JOURS`) ; sinon il répond
   * « déjà à jour » sans sortir. Un soir de rencontre, où l'écran s'ouvre et se ferme vingt
   * fois, le premier appel coûte une seconde et les dix-neuf suivants rien du tout.
   *
   * Y COMPRIS QUAND LA FÉDÉRATION EST EN PANNE, et ça n'allait pas de soi : un échec n'écrit
   * rien en base (pour ne pas écraser un roster valide par un silence du site), donc la
   * fraîcheur reconcluait « à rafraîchir » à chaque ouverture et les vingt requêtes repartaient.
   * Un repos de quinze minutes après un échec ferme ce cas (`ECHEC_REPOS_MS`).
   *
   * ⚠️ IL NE BLOQUE PAS L'ÉCRAN, et ne le fait pas attendre : la rencontre s'affiche
   * immédiatement avec ce qu'on a déjà, et le menu se recharge SI quelque chose de nouveau est
   * arrivé. Le contraire ferait patienter une seconde devant un écran de composition pour un
   * confort de saisie — au bord d'un terrain, sur un réseau médiocre.
   *
   * ⚠️ SILENCIEUX EN CAS D'ÉCHEC, comme `loadKnown` : ces menus sont un confort, pas une donnée
   * dont l'écran dépend. La saisie libre reste là, et un toast d'erreur ne ferait qu'inquiéter
   * pour une commodité absente.
   *
   * SUR `openId`, DONC UNE FOIS PAR OUVERTURE — surtout pas dans `loadFixture`, qui se rejoue à
   * chaque retour au premier plan et après chaque enregistrement. Accroché là, un déverrouillage
   * de téléphone aurait relancé l'interrogation de la ligue.
   */
  useEffect(() => {
    if (!openId) return;
    let vivant = true;
    (async () => {
      try {
        const res = await fetch(`/api/interclub/opponents/refresh?fixtureId=${openId}`, {
          method: "POST",
        });
        if (!res.ok) return;
        const data = (await res.json()) as { fetched?: unknown };
        // On ne recharge le menu QUE si la ligue a effectivement rendu quelque chose de neuf.
        // « Déjà à jour » est le cas courant, et il n'a rien à réafficher.
        if (vivant && typeof data.fetched === "number" && data.fetched > 0) void loadKnown();
      } catch {
        /* menus inchangés : la saisie libre suffit */
      }
    })();
    // La rencontre a pu être refermée pendant l'aller-retour : ne pas recharger un menu dont
    // plus personne ne se sert.
    return () => {
      vivant = false;
    };
  }, [openId, loadKnown]);

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
    matchCount: number;
    bestOf: number;
    force?: boolean;
  }) {
    setBusy(true);
    try {
      const res = await fetch("/api/interclub", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      if (onExpired(res.status)) return;
      // Le serveur a vu une rencontre de cette équipe ce jour-là que notre liste ignorait
      // encore (créée ou importée depuis son chargement). On recharge : l'avertissement du
      // formulaire apparaît alors avec son bouton « Ouvrir », et le choix reste à la personne.
      if (res.status === 409) {
        const d = (await res.json().catch(() => null)) as { code?: string; error?: string } | null;
        if (d?.code === "same_day") {
          toast("info", d.error ?? "Cette équipe a déjà une rencontre ce jour-là.");
          await loadList();
          return;
        }
      }
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

  /**
   * Corrige la rencontre elle-même : date, heure, journée, adversaire, lieu, statut de la date.
   *
   * Le `PATCH` existait, complet et testé, SANS AUCUN APPELANT — l'aperçu du calendrier disait
   * pourtant « à corriger à la main sur la rencontre » (`confirmDrift`), et le contrôle
   * n'existait nulle part. Une rencontre saisie à la main ne pouvait ni recevoir d'heure, ni
   * être déplacée.
   *
   * `body` ne porte QUE les champs modifiés : la route distingue « absent » (on ne touche pas)
   * de « `null` explicite » (on efface), et envoyer le formulaire entier effacerait le lieu
   * qu'un import vient de renseigner.
   */
  async function saveFixture(id: string, body: Record<string, unknown>) {
    setBusy(true);
    try {
      const res = await fetch(`/api/interclub/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (onExpired(res.status)) return;
      await readOk(res);
      toast("ok", "Rencontre modifiée");
      await loadFixture(id);
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
  const filtered = activeTab === "all" ? rows : rows.filter((f) => f.team.id === activeTab);

  // LES RENCONTRES À VENIR D'ABORD, DE LA PLUS PROCHE À LA PLUS LOINTAINE, puis les passées de
  // la plus récente à la plus ancienne.
  //
  // Le serveur rend tout par date décroissante, ce qui convenait tant que cet écran servait
  // l'historique et le direct. Depuis qu'un calendrier de saison entier y figure, cet ordre
  // ouvrait sur la dernière journée de mars — la question qu'on se pose en ouvrant l'écran est
  // « c'est quand, la prochaine ? », et il fallait faire défiler pour y répondre.
  const aujourdhui = todayISO();
  const visibleRows = [...filtered].sort((a, b) => {
    // CE QUI EST JOUÉ DESCEND, D'ABORD ET AVANT TOUT.
    //
    // Le tri se faisait sur la seule date, et le résultat était contre-intuitif : une
    // rencontre terminée hier passait devant quatre rencontres de la semaine dernière
    // restées sans score, donc encore à traiter. On ouvrait l'écran sur du passé.
    //
    // L'état prime donc sur la date. « À venir » et « en cours » restent ensemble en tête —
    // c'est ce qu'on vient chercher — et le passé se consulte en dessous.
    const finiA = a.status === "done";
    const finiB = b.status === "done";
    if (finiA !== finiB) return finiA ? 1 : -1;
    // Les terminées : la plus récente d'abord, on remonte le temps.
    if (finiA) return b.date.localeCompare(a.date);
    // Les autres : la plus PROCHE d'abord. Une date déjà passée mais sans résultat reste
    // devant — c'est justement une rencontre dont il manque quelque chose.
    const aVenirA = a.date >= aujourdhui;
    const aVenirB = b.date >= aujourdhui;
    if (aVenirA !== aVenirB) return aVenirA ? -1 : 1;
    return aVenirA ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date);
  });

  return (
    <section className="interclub">
      {/* L'abonnement OUVRE la page, avant même le titre. Il vivait sous la liste
          des rencontres du jour, dans le bloc « En direct » : personne ne l'y trouvait, et on
          pouvait se croire abonné sans l'être. C'est le réglage le plus consulté de l'écran, et
          le seul qui décide de ce qu'on recevra les soirs où l'on n'ouvre pas l'appli. */}
      <InterclubFollow teams={teams} toast={stableToast} onExpired={stableExpired} />

      <div className="ic-head">
        <h3>Interclub</h3>
        {canCreate && (
          <button onClick={() => setCreating(true)} disabled={teams.length === 0}>
            Nouvelle rencontre
          </button>
        )}
      </div>

      {/* La carte du haut OUVRE la fiche : c'est le chemin court vers la rencontre de ce soir
          (ou d'hier, à finir de saisir), au lieu de la chercher dans le calendrier. */}
      <InterclubLive onExpired={stableExpired} onOpen={setOpenId} />

      {/* Les onglets ne s'affichent qu'à partir de DEUX équipes : avec une seule, un filtre
          qui ne filtre rien est du bruit. Le schéma prévoit la troisième. */}
      {teams.length > 1 && <TeamTabs teams={teams} value={activeTab} onChange={setTab} />}

      {/* LE CLASSEMENT SUIT L'ONGLET, UN SEUL PAR POULE. Deux équipes du club dans la même
          poule partagent un même tableau, où leurs deux lignes sont surlignées ; deux poules
          distinctes donnent deux tableaux. Il se place ICI, entre le filtre et les résultats,
          parce que c'est exactement la question que la liste de résultats fait naître. */}
      {poulesAffichees(
        teams,
        teams.filter((t) => activeTab === "all" || t.id === activeTab),
      ).map((p, _i, toutes) => (
        <div key={p.key} className="ic-standings-wrap">
          {/* Le nom de l'équipe n'est utile que s'il reste plusieurs tableaux à distinguer ;
              une poule partagée nomme déjà chaque équipe dans ses pastilles. */}
          {toutes.length > 1 && p.ours.size === 1 && (
            <p className="ic-standings-team muted tiny">{[...p.ours.values()][0]}</p>
          )}
          <StandingsTable poule={p} />
        </div>
      ))}

      {/* Le palmarès suit l'onglet comme le classement — il se recharge sur `teamId`, faute de
          `key` qui le remonterait —, et se place juste après lui : les deux
          répondent à la même curiosité — « où en est-on ? » — l'une pour l'équipe, l'autre pour
          les joueurs. Il ne charge rien tant qu'on ne l'ouvre pas. */}
      <InterclubStats teamId={activeTab === "all" ? null : activeTab} onExpired={stableExpired} />

      {/* L'ÉTAT VIDE PORTE LE PANNEAU, LUI AUSSI. Les onglets pointent tous sur
          `aria-controls="ic-fixtures"` : quand l'`<ul>` cédait la place à l'`EmptyState`,
          l'identifiant ne désignait plus rien et chaque onglet annonçait un panneau
          introuvable. Un club sans aucune rencontre est l'état où l'on a le plus besoin que
          l'écran se laisse explorer. */}
      {rows.length === 0 ? (
        <div
          id="ic-fixtures"
          role={teams.length > 1 ? "tabpanel" : undefined}
          aria-labelledby={teams.length > 1 ? `ic-tab-${activeTab}` : undefined}
        >
          <EmptyState icon="🏸" text="Aucune rencontre pour le moment." />
        </div>
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
          {/* Une liste coupée le DIT. Elle ne l'a pas dit pendant toute une saison, et le
              calendrier paraissait simplement commencer à J13. Ce qui manque est toujours le
              plus ancien (le serveur trie par date décroissante), donc jamais la saison en
              cours — d'où une phrase et pas un bouton. */}
          {truncated && (
            <li className="ic-empty-tab muted">
              Seules les cent rencontres les plus récentes sont affichées — les saisons les plus
              anciennes ne figurent pas dans cette liste.
            </li>
          )}
          {visibleRows.map((f) => {
            // L'état AFFICHÉ, qui tient compte de la date : une rencontre commencée il y a plus
            // de `RECENT_FIXTURE_DAYS` jours et jamais finie n'est plus « en cours », elle est
            // « non complétée » (cf. `fixtureDisplayStatus`). Le voile de ligne suit, puisqu'il
            // est réservé à ce qui se joue MAINTENANT.
            const etat = fixtureDisplayStatus(f, aujourdhui);
            return (
              <li key={f.id}>
                {/* L'issue de la rencontre passe DANS la classe de la ligne : « 2-2 » sans
                    couleur ne dit pas si la soirée a été bonne, et on parcourt une saison à
                    l'œil, pas en lisant chaque ligne. Le voile pleine ligne reste réservé à
                    « en cours » (DESIGN.md) : ici c'est un filet et le score, pas un fond. */}
                <button
                  className={`ic-row ic-row-${etat}${
                    f.outcome ? ` ic-issue-${issueClass(f.outcome.result)}` : ""
                  }`}
                  onClick={() => setOpenId(f.id)}
                >
                  <span className="ic-row-head">
                    <span className="ic-date" title={`Date de la rencontre : ${shortDate(f.date)}`}>
                      {f.round && <span className="ic-round">{f.round}</span>}
                      {shortDate(f.date)}
                      {f.time && <span className="ic-hour">{f.time}</span>}
                      {/* Une date prévisionnelle porte sa mention SUR LA LIGNE : c'est là qu'on
                          la lit quand on planifie sa semaine, pas dans la fiche qu'on n'ouvrira
                          peut-être jamais. */}
                      {!f.dateConfirmed && (
                        <span className="ic-provisoire-tag" title="La ligue n'a pas encore fixé cette date">
                          prévisionnelle
                        </span>
                      )}
                    </span>
                    <span className={`ic-status ic-${etat}`}>
                      <span className="sr-only">État : </span>
                      {FIXTURE_STATUS_LABEL[etat]}
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
                  {f.outcome && <TieOutcomeLine outcome={f.outcome} />}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {creating && (
        <CreateDialog
          teams={teams}
          knownTeams={known.teams}
          busy={busy}
          sameDay={(teamId, date) => rows?.find((r) => r.team.id === teamId && r.date === date)}
          onOpen={(id) => {
            setCreating(false);
            setOpenId(id);
          }}
          onClose={() => setCreating(false)}
          onSubmit={createFixture}
        />
      )}

      {scoringMatch && fixture && (
        <InterclubScorer
          fixtureId={fixture.id}
          match={scoringMatch}
          bestOf={fixture.bestOf}
          recoit={fixture.home}
          onClose={() => stopScoring(scoringMatch.id)}
          onExpired={stableExpired}
          toast={stableToast}
        />
      )}

      {openId && fixture && !scoringMatch && (
        <FixtureDialog
          knownOpponents={known.players}
          fixture={fixture}
          busy={busy}
          onClose={() => setOpenId(null)}
          onSaveMatch={saveMatch}
          onSaveFixture={(body) => saveFixture(fixture.id, body)}
          onDelete={() => deleteFixture(fixture.id)}
          onScore={startScoring}
          toast={stableToast}
          onExpired={stableExpired}
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
  knownTeams,
  busy,
  sameDay,
  onOpen,
  onClose,
  onSubmit,
}: {
  teams: Team[];
  /** Les clubs déjà rencontrés — après un import de calendrier, exactement ceux de notre poule. */
  knownTeams: string[];
  busy: boolean;
  /** La rencontre que cette équipe a déjà ce jour-là, s'il y en a une. */
  sameDay: (teamId: string, date: string) => FixtureRow | undefined;
  onOpen: (id: string) => void;
  onClose: () => void;
  onSubmit: (f: {
    date: string;
    teamId: string;
    opponent: string;
    home: boolean;
    matchCount: number;
    bestOf: number;
    force?: boolean;
  }) => void;
}) {
  const [date, setDate] = useState(todayISO());
  const [teamId, setTeamId] = useState(teams[0]?.id ?? "");
  /**
   * Le club adverse, CHOISI dans un menu plutôt que retapé — c'est l'orthographe de l'import
   * fédéral qui compte, et une variante saisie à la main (« chaville 4 ») casse silencieusement
   * le rapprochement des joueurs d'en face au moment de la vérification du capitaine.
   *
   * `AUTRE` rouvre la saisie libre, et ce n'est pas une échappatoire de confort : une poule
   * commence par une première rencontre contre un club qu'on n'a jamais croisé, et le menu est
   * alors forcément vide. Le menu enlève la ressaisie, il n'interdit rien.
   */
  const [opponent, setOpponent] = useState(knownTeams[0] ?? "");
  const [libre, setLibre] = useState(knownTeams.length === 0);
  const [home, setHome] = useState(true);
  const [matchCount, setMatchCount] = useState(4);
  const [bestOf, setBestOf] = useState(5);

  const canSubmit = !!date && !!teamId && opponent.trim().length > 0 && !busy;
  const deja = date && teamId ? sameDay(teamId, date) : undefined;

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
        {libre || knownTeams.length === 0 ? (
          <input
            value={opponent}
            onChange={(e) => setOpponent(e.target.value)}
            placeholder="ex. Squash de Massy"
            maxLength={60}
            autoFocus={libre && knownTeams.length > 0}
          />
        ) : (
          <select
            value={opponent}
            onChange={(e) => {
              if (e.target.value === AUTRE_CLUB) {
                setLibre(true);
                setOpponent("");
              } else {
                setOpponent(e.target.value);
              }
            }}
          >
            {knownTeams.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
            <option value={AUTRE_CLUB}>— un autre club —</option>
          </select>
        )}
      </label>
      {libre && knownTeams.length > 0 && (
        <button
          className="ic-linkish"
          onClick={() => {
            setLibre(false);
            setOpponent(knownTeams[0]);
          }}
        >
          Revenir à la liste des clubs déjà rencontrés
        </button>
      )}
      {/* PLUS DE DIVISION ICI. Le champ était libre, facultatif, saisi à la main et jamais
          renseigné par l'import fédéral : une rencontre sur deux le portait, l'autre non, et il
          ne servait qu'à afficher « D2 Hommes » sous le score. La division au sens de squashnet
          — celle dont dépend le classement — est ailleurs, sur l'ÉQUIPE (`snDrawId`), et n'a
          jamais eu de rapport avec ce champ malgré leur nom commun. */}
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
      {/* UNE ÉQUIPE, UNE RENCONTRE PAR JOUR. Le 15/10/2026, l'Équipe 1 a eu deux fiches contre
          CAL Squash : celle de l'import fédéral, et une seconde créée le soir même par quelqu'un
          qui ne l'avait pas vue — les scores sur l'une, les disponibilités sur l'autre. On le dit
          ici, avant d'écrire, avec le chemin vers la bonne. « Créer quand même » reste possible :
          un report peut faire tomber deux rencontres le même jour, et c'est à la personne d'en
          juger, pas au formulaire. Le serveur fait le même contrôle (409 `same_day`) pour le cas
          où la liste affichée ici serait en retard. */}
      {deja && (
        <div className="ic-cal-warn ic-same-day" role="status">
          <p>
            ⚠️ {teams.find((t) => t.id === teamId)?.name ?? "Cette équipe"} a déjà une rencontre
            ce jour-là : {deja.home ? "reçoit" : "se déplace à"} {deja.opponent}
            {deja.round ? ` (${deja.round})` : ""}.
          </p>
          <button onClick={() => onOpen(deja.id)}>Ouvrir cette rencontre</button>
        </div>
      )}

      <div className="modal-actions">
        <button className="secondary" onClick={onClose}>
          Annuler
        </button>
        <button
          className={deja ? "secondary" : undefined}
          disabled={!canSubmit}
          onClick={() =>
            onSubmit({
              date,
              teamId,
              opponent,
              home,
              matchCount,
              bestOf: isValidBestOf(bestOf) ? bestOf : 5,
              ...(deja ? { force: true } : {}),
            })
          }
        >
          {deja ? "Créer quand même" : "Créer"}
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
  knownOpponents,
  busy,
  onClose,
  onSaveMatch,
  onSaveFixture,
  onDelete,
  onScore,
  toast,
  onExpired,
}: {
  fixture: Fixture;
  /** Tous les adversaires connus, toutes équipes confondues — filtrés ci-dessous sur celle-ci. */
  knownOpponents: KnownOpponent[];
  busy: boolean;
  onClose: () => void;
  onSaveMatch: (matchId: string, body: Record<string, unknown>) => void;
  /** Les champs de la RENCONTRE, et eux seuls : cf. `saveFixture` plus haut. */
  onSaveFixture: (body: Record<string, unknown>) => void;
  onDelete: () => void;
  onScore: (matchId: string) => void;
  // Les deux rappels descendent au bloc de disponibilité, sous leur forme STABLE (cf. le long
  // commentaire sur `stableToast` / `stableExpired` plus haut) : ce bloc les met en dépendance
  // d'un `useCallback` qui émet une requête.
  toast: (type: "ok" | "err" | "info", msg: string) => void;
  onExpired: (status: number) => boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  // Confirmation en deux temps plutot qu'un confirm() natif : la suppression emporte tous les
  // matchs et leurs jeux, et une boîte de dialogue bloquante fige l'onglet.
  const [confirmDel, setConfirmDel] = useState(false);
  /** La FICHE de la rencontre est-elle en cours de correction ? (date, heure, lieu…) */
  const [editHead, setEditHead] = useState(false);
  // La durée d'un simple EN COURS doit avancer à l'écran : la fiche, elle, n'est pas sondée.
  const now = useMinuteClock(fixture.matches.some((m) => m.status === "live" && m.startedAt));
  const fixtureMs = fixtureDurationMs(fixture.matches);

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
  // Les DEUX critères de l'ordre, relus depuis le roster : le classement n'est pas stocké sur
  // le match (seul le nom l'est, figé), le rang mixte non plus.
  const rosterRanking = new Map(
    fixture.roster.map((r) => [`${r.kind}:${r.id}`, { clt: r.clt, rangM: r.rangM }]),
  );
  const orderSlots: OrderedSlot[] = fixture.matches
    .filter((m) => m.homeDisplayName !== UNSET_PLAYER)
    .map((m) => {
      const key = m.homeUserId
        ? `member:${m.homeUserId}`
        : m.homeGuestId
          ? `guest:${m.homeGuestId}`
          : null;
      const r = key ? rosterRanking.get(key) : undefined;
      return {
        order: m.order,
        name: m.homeDisplayName,
        clt: r?.clt ?? null,
        rangM: r?.rangM ?? null,
      };
    });

  // Les adversaires connus de CE club. Le nom d'équipe se compare replié (casse, accents,
  // espaces) : la rencontre porte l'orthographe de son import, la liste celle de la sienne, et
  // rien ne garantit qu'elles coïncident au caractère près.
  //
  // ⚠️ `normalize`, ET PAS `toLowerCase()`. Le commentaire ci-dessus promettait les accents et
  // les espaces depuis l'origine ; `toLowerCase()` n'en replie aucun. « Élancourt 2 » dans la
  // rencontre et « Elancourt 2 » dans la liste ne coïncidaient donc pas : le menu disparaissait,
  // `awayLibre` s'initialisait à `true`, et on retapait le nom à la main — exactement ce que ce
  // menu existe pour éviter.
  //
  // C'est aussi LA MÊME FONCTION QUE LE SERVEUR, qui filtre l'équipe de la même façon dans
  // `awayLineupConflict`. Deux replis différents referaient l'écart qu'on vient de fermer : un
  // écran qui propose un joueur que la route refuse ensuite.
  const clubOpponents = knownOpponents.filter(
    (o) => normalize(o.team) === normalize(fixture.opponent),
  );

  // L'ORDRE DÉJÀ POSÉ EN FACE, pour griser dans le sélecteur un adversaire qui le romprait —
  // exactement ce que fait `orderSlots` pour notre camp. La règle employée ici est CELLE DU
  // SERVEUR (`awayLineupConflict`, module pur) : ce que l'écran grise, la route le refuse, et
  // réciproquement.
  const awayLines = fixture.matches.map((m) => ({ order: m.order, awayName: m.awayName }));

  return (
    <Dialog onClose={onClose} label="Rencontre" className="ic-detail">
      {editHead ? (
        <FixtureEditor
          fixture={fixture}
          busy={busy}
          onCancel={() => setEditHead(false)}
          onSave={(body) => {
            onSaveFixture(body);
            setEditHead(false);
          }}
        />
      ) : (
        <>
          {/* En-tête COLLANT avec sa croix : la fiche est longue, et « Fermer » n'était
              atteignable qu'au bas du défilement. Même motif que les Paramètres. */}
          <div className="settings-head ic-detail-head">
            <h3>
              {/* Convention du sport : l'équipe qui REÇOIT d'abord. */}
              {fixture.home
                ? `${fixture.team.name} – ${fixture.opponent}`
                : `${fixture.opponent} – ${fixture.team.name}`}
            </h3>
            <button
              type="button"
              className="secondary settings-close"
              onClick={onClose}
              aria-label="Fermer la rencontre"
              title="Fermer"
            >
              ✕
            </button>
          </div>
          <p className="muted tiny">
            {fixture.round && `${fixture.round} · `}
            {shortDate(fixture.date)}
            {fixture.time && ` à ${fixture.time}`} · au meilleur des {fixture.bestOf} jeux (
            {fixture.winGames} gagnants)
          </p>
          {/* La date prévisionnelle SE DIT. La fédération publie les journées non planifiées avec
              une date bouchon commune : l'afficher comme une date ferme est ce qui ferait déplacer
              quelqu'un pour rien. */}
          {!fixture.dateConfirmed && (
            <p className="ic-provisoire">
              ⚠️ Date prévisionnelle — la ligue ne l&apos;a pas encore fixée.
            </p>
          )}
          {/* Le lieu, quand on le connaît. À l'extérieur, c'est l'information la plus utile de tout
              l'écran : on ne sait pas d'avance chez qui l'on va. */}
          {fixture.venue && (
            <p className="muted tiny ic-venue">
              {fixture.home ? "Chez nous : " : "Déplacement : "}
              <strong>{fixture.venue}</strong>
              {fixture.venueAddress && (
                // L'ADRESSE EST UN ITINÉRAIRE, pas un texte à recopier dans une autre appli. Une
                // URL Maps plutôt qu'un schéma propriétaire : `maps:` ne s'ouvre pas sur Android
                // et `geo:` pas sur iOS, alors qu'une URL https est reprise par l'application de
                // cartes des deux côtés.
                <a
                  className="ic-venue-addr"
                  href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
                    `${fixture.venue} ${fixture.venueAddress}`,
                  )}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {fixture.venueAddress}
                </a>
              )}
            </p>
          )}
          {/* PRÈS DE CE QU'ELLES CONCERNENT, et non dans la barre du bas avec « Supprimer » :
              la date, l'heure et le lieu se lisent ici, et c'est ici qu'on veut les emporter
              dans son agenda — ou s'apercevoir qu'ils sont faux. */}
          <p className="ic-fix-tools">
            <button
              type="button"
              className="secondary tiny"
              title="Ajouter la rencontre à mon agenda (.ics)"
              onClick={() => downloadFixtureIcs({ ...fixture, teamName: fixture.team.name })}
            >
              📅 Agenda
            </button>
            {fixture.canEdit && (
              <button
                type="button"
                className="secondary tiny"
                onClick={() => setEditHead(true)}
              >
                ✎ Modifier la rencontre
              </button>
            )}
          </p>
        </>
      )}
      {fixture.team.captainName && (
        <p className="muted tiny">Capitaine&nbsp;: {fixture.team.captainName}</p>
      )}
      <p className="ic-total">
        {fixture.score.home}–{fixture.score.away}{" "}
        <span className="muted tiny">
          {FIXTURE_STATUS_LABEL[fixtureDisplayStatus(fixture, todayISO())]}
          {/* Du premier point au point décisif du dernier simple — seulement si tous ont été
              marqués en direct (cf. `fixtureDurationMs`). */}
          {fixtureMs !== null && ` en ${formatDuration(fixtureMs)}`}
        </span>
      </p>
      {/* La fiche dit la MÊME chose que la carte, calculée par la même fonction : deux écrans
          qui annonceraient des points de classement différents sur la même rencontre seraient
          pires que pas de points du tout. */}
      {fixture.outcome && (
        <p className="ic-outcome-line">
          <TieOutcomeLine outcome={fixture.outcome} />
        </p>
      )}
      {/* PENDANT la rencontre, à la place exacte qu'occupera la ligne de résultat une fois
          qu'elle sera finie — et jamais les deux à la fois : l'une compte ce qui se joue,
          l'autre dit ce que ça a rapporté. Le calcul se fait sur les simples DÉJÀ CHARGÉS de
          la fiche, sans requête de plus. */}
      {fixture.status === "live" && (
        <InterclubTally matchCount={fixture.matchCount} matches={fixture.matches} />
      )}

      {/* LES DISPONIBILITÉS AVANT LA COMPOSITION, et c'est l'ordre du geste réel : on demande
          qui peut venir, PUIS on compose avec ceux qui peuvent. Les placer sous les simples
          aurait laissé composer d'abord et découvrir ensuite qu'il manque deux joueurs.
          Rien à afficher sur une rencontre terminée : la question ne se pose plus. */}
      {fixture.status !== "done" && (
        <InterclubAvailability fixtureId={fixture.id} toast={toast} onExpired={onExpired} />
      )}

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
                clubOpponents={clubOpponents}
                awayLines={awayLines}
                opponentTeamName={fixture.opponent}
                teamName={fixture.team.name}
                recoit={fixture.home}
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
                  <span className="ic-order">
                    Simple {m.order}
                    <MatchDuration match={m} now={now} />
                  </span>
                  <span className={`ic-status ic-${m.status}`}>
                    <span className="sr-only">État : </span>
                    {m.outcome
                      ? `${m.outcome === "forfait" ? "Forfait" : "Abandon"} · ${
                          m.outcomeWinner === "home" ? fixture.team.name : fixture.opponent
                        } gagne`
                      : (MATCH_STATUS_LABEL[m.status] ?? m.status)}
                  </span>
                </span>
                {/* L'ÉQUIPE QUI REÇOIT EN PREMIER, à la demande du club : c'est l'ordre de la
                    feuille de match et du titre de la rencontre (« Verrieres 4 – Équipe 2 »).
                    Chez l'adversaire, son joueur passe donc devant le nôtre — et TOUT ce qui se
                    lit sur la carte suit (jeux, jeu en cours, total) : un « 11-8 » sous
                    « FAUVEAU c. Pegot » qui serait resté dans notre sens se lirait comme une
                    victoire de Fauveau. La donnée, elle, ne bouge pas : `home` reste NOUS. */}
                <span className="ic-players">
                  {(fixture.home ? (["home", "away"] as const) : (["away", "home"] as const)).map(
                    (cote, i) => {
                      const nom = cote === "home" ? m.homeDisplayName : m.awayName;
                      return (
                        <Fragment key={cote}>
                          {i === 1 && (
                            <span className="ic-versus" title="contre">
                              <span className="sr-only">contre</span>
                              <span aria-hidden="true">c.</span>
                            </span>
                          )}
                          <span className="ic-player">
                            <ColorDot
                              color={cote === "home" ? m.homeColor : m.awayColor}
                              size="lg"
                            />
                            <span className={nom === UNSET_PLAYER ? "muted" : undefined}>{nom}</span>
                            {/* AU SERVICE. La donnée arrivait déjà — `getLiveFixtures` la met dans
                                la charge utile, cet écran la déclarait dans son type — et il ne
                                l'affichait pas. Or « 7–5 » sans savoir qui sert ne se lit pas : au
                                squash le service change de main à chaque échange perdu, et c'est
                                lui qui dit si le meneur conclut ou subit. Coût serveur nul, elle
                                est déjà payée. */}
                            {m.live?.serving === cote && <AuService />}
                          </span>
                        </Fragment>
                      );
                    },
                  )}
                </span>
                {(m.live || m.gamesHome !== null) && (
                  <span className="ic-games">
                    {m.games.length > 0 && (
                      <span className="ic-gamelist">
                        {m.games.map((g) => dansLOrdre(fixture.home, g.home, g.away, "-")).join(" · ")}
                      </span>
                    )}
                    {m.live && (
                      <span className="ic-inplay" title="Jeu en cours">
                        {dansLOrdre(fixture.home, m.live.current.home, m.live.current.away)}
                      </span>
                    )}
                    {m.gamesHome !== null && (
                      <span
                        className="ic-gamescore"
                        aria-label={`Jeux gagnés : ${dansLOrdre(fixture.home, m.gamesHome, m.gamesAway ?? 0, " à ")}`}
                      >
                        {dansLOrdre(fixture.home, m.gamesHome, m.gamesAway ?? 0)}
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

// --- Correction de la fiche d'une rencontre --------------------------------
//
// LA ROUTE EXISTAIT, PERSONNE NE L'APPELAIT. `PATCH /api/interclub/[id]` sait depuis toujours
// déplacer une rencontre, lui donner une heure, un lieu, une journée, et corriger le statut de
// sa date — mais aucun écran ne l'appelait. Deux conséquences, toutes deux invisibles :
//
//  * l'aperçu du calendrier fédéral dit « à corriger à la main sur la rencontre » quand la
//    ligue et la base divergent sur `dateConfirmed` (cf. `confirmDrift`). Toute la doctrine
//    « la déduction informe, elle ne tranche plus » reposait donc sur un geste impossible ;
//  * une rencontre saisie à la main naissait sans heure ni lieu — le formulaire de création ne
//    les demande pas — et rien ne pouvait les lui donner ensuite.
//
// ON N'ENVOIE QUE CE QUI A CHANGÉ. La route distingue « champ absent » (on ne touche pas) de
// « `null` explicite » (on efface) : poster le formulaire entier effacerait le lieu qu'un
// import vient de renseigner, pour le seul motif qu'on a corrigé l'heure.

function FixtureEditor({
  fixture,
  busy,
  onCancel,
  onSave,
}: {
  fixture: Fixture;
  busy: boolean;
  onCancel: () => void;
  onSave: (body: Record<string, unknown>) => void;
}) {
  const [date, setDate] = useState(fixture.date);
  const [time, setTime] = useState(fixture.time ?? "");
  const [round, setRound] = useState(fixture.round ?? "");
  const [opponent, setOpponent] = useState(fixture.opponent);
  const [home, setHome] = useState(fixture.home);
  const [venue, setVenue] = useState(fixture.venue ?? "");
  const [venueAddress, setVenueAddress] = useState(fixture.venueAddress ?? "");
  const [dateConfirmed, setDateConfirmed] = useState(fixture.dateConfirmed);
  /** Le report est annoncé avant d'être écrit : il efface des réponses déjà données. */
  const [confirmDate, setConfirmDate] = useState(false);

  // Une rencontre commencée ne se déplace plus — le serveur refuse en 409, et le refuser ici
  // évite de le découvrir après avoir tout ressaisi. Le RESTE reste corrigible : un lieu mal
  // orthographié se corrige aussi bien après le coup d'envoi.
  const figee = fixture.status !== "scheduled";

  const net = (v: string) => v.trim().replace(/\s+/g, " ");
  /** Ce qui a bougé, et rien d'autre. Chaîne vide = « efface ce champ » (la route rend null). */
  const modifs = (): Record<string, unknown> => {
    const body: Record<string, unknown> = {};
    if (!figee && date !== fixture.date) body.date = date;
    if (net(time) !== (fixture.time ?? "")) body.time = net(time);
    if (net(round) !== (fixture.round ?? "")) body.round = net(round);
    if (net(opponent) !== fixture.opponent) body.opponent = net(opponent);
    if (home !== fixture.home) body.home = home;
    if (net(venue) !== (fixture.venue ?? "")) body.venue = net(venue);
    if (net(venueAddress) !== (fixture.venueAddress ?? "")) body.venueAddress = net(venueAddress);
    if (dateConfirmed !== fixture.dateConfirmed) body.dateConfirmed = dateConfirmed;
    return body;
  };

  const body = modifs();
  const dateBouge = "date" in body;
  // L'adversaire est le seul champ que la route refuse vide : le dire ici plutôt que de laisser
  // partir un 400 qu'il faudra traduire.
  const valide = net(opponent).length > 0 && date.length > 0 && Object.keys(body).length > 0;

  const enregistrer = () => {
    if (dateBouge && !confirmDate) {
      setConfirmDate(true);
      return;
    }
    onSave(body);
  };

  return (
    <div className="ic-fix-edit">
      <h3>Modifier la rencontre</h3>
      <div className="ic-form-row">
        <label>
          Date
          <input
            type="date"
            value={date}
            disabled={figee}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        <label>
          Heure
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            // Vide = heure inconnue, et c'est un état légitime : la ligue publie des journées
            // avant d'en fixer l'horaire.
            placeholder="—"
          />
        </label>
      </div>
      {figee && (
        <p className="muted tiny">
          Rencontre commencée : sa date ne peut plus changer. Le reste reste corrigible.
        </p>
      )}
      <div className="ic-form-row">
        <label>
          Journée
          <input
            value={round}
            onChange={(e) => setRound(e.target.value)}
            placeholder="ex. J3"
            maxLength={12}
          />
        </label>
        <label>
          Club adverse
          <input value={opponent} onChange={(e) => setOpponent(e.target.value)} maxLength={60} />
        </label>
      </div>
      <fieldset>
        <legend className="tiny muted">Lieu</legend>
        <label>
          <input type="radio" checked={home} onChange={() => setHome(true)} /> À domicile
        </label>
        <label>
          <input type="radio" checked={!home} onChange={() => setHome(false)} /> À l&apos;extérieur
        </label>
      </fieldset>
      <label>
        Club hôte
        <input
          value={venue}
          onChange={(e) => setVenue(e.target.value)}
          placeholder="ex. Squash de Massy"
          maxLength={80}
        />
      </label>
      <label>
        Adresse
        <input
          value={venueAddress}
          onChange={(e) => setVenueAddress(e.target.value)}
          placeholder="ex. 12 rue du Stade, 91300 Massy"
          maxLength={200}
        />
      </label>
      {/* LE RATTRAPAGE QUE LE CALENDRIER RÉCLAME. La détection automatique a deux angles morts
          (deux vraies journées le même soir passent pour prévisionnelles, une seule journée non
          planifiée passe pour ferme) ; c'est cette case qui les corrige, et l'import ne la
          réécrit jamais. Sans elle, l'équipe n'était jamais convoquée pour une rencontre bien
          réelle — ou l'était pour une date bouchon. */}
      <label className="ic-date-sure">
        <input
          type="checkbox"
          checked={dateConfirmed}
          onChange={(e) => setDateConfirmed(e.target.checked)}
        />{" "}
        Date confirmée par la ligue
        <span className="muted tiny">
          Décochée, la rencontre s&apos;affiche « prévisionnelle » et l&apos;équipe n&apos;est ni
          convoquée ni relancée.
        </span>
      </label>

      {/* CE QUE LE REPORT COÛTE, dit AVANT de l'écrire — les mêmes mots que l'aperçu du
          calendrier fédéral, qui fait exactement la même chose. Le découvrir après, c'est le
          découvrir quand les réponses sont déjà perdues. */}
      {dateBouge && confirmDate && (
        <p className="ic-cal-warn">
          ⚠️ Changer la date efface les disponibilités déjà recueillies pour cette rencontre, et
          l&apos;équipe est prévenue du report.
        </p>
      )}

      <div className="modal-actions">
        <button className="secondary" disabled={busy} onClick={onCancel}>
          Annuler
        </button>
        <button disabled={busy || !valide} onClick={enregistrer}>
          {dateBouge && confirmDate ? "Déplacer et prévenir" : "Enregistrer"}
        </button>
      </div>
    </div>
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
