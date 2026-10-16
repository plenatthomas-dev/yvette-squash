"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import AuService from "./AuService";
import { readOk } from "@/lib/apiFetch";
import { onForeground } from "@/lib/onForeground";
import {
  FIXTURE_STATUS_LABEL,
  fixtureDisplayStatus,
  resolveColor,
  shiftISO,
} from "@/lib/interclub";
import { CLUB_TZ } from "@/lib/time";
import InterclubTally from "./InterclubTally";

// Suivi en direct, pour ceux qui ne sont pas sur place.
//
// LE POLLING EST LA PARTIE DÉLICATE. `PRODUCT.md` proscrit le polling agressif, et une soirée
// dure deux heures. Trois garde-fous, dans cet ordre d'importance :
//   1. on n'interroge QUE s'il y a quelque chose à voir aujourd'hui ;
//   2. on n'interroge QUE si l'onglet est visible — un téléphone en poche ne coûte rien ;
//   3. côté serveur, la requête lourde vient du Data Cache (cf. interclub-gate) : seule la
//      lecture de session subsiste par sondage.
//
// ⚠️ Le garde-fou n°1 a longtemps été FAUX, et c'est le plus coûteux des trois à manquer. Il
// annonçait « on n'interroge que si une rencontre est en cours » alors que le sondage de veille
// tournait INDÉFINIMENT, à raison d'un appel par minute. Un membre qui laissait l'onglet ouvert
// un dimanche après-midi payait une lecture de session par minute pendant des heures — de quoi
// empêcher à lui seul le scale-to-zero de Neon (5 min d'inactivité), hors de la fenêtre où
// `docs/neon-keep-alive.md` réveille délibérément la base.
//
// La formulation juste est « s'il y a quelque chose à voir » : le serveur ne renvoie que les
// rencontres du jour et celles restées en direct (cf. interclub-gate). Si cette liste est vide,
// ou si tout y est terminé, RIEN ne peut plus bouger d'ici la fin de la journée : on arrête le
// sondage et on s'en remet au retour au premier plan, qui est de toute façon le geste par
// lequel on demande « montre-moi où ça en est ».
const POLL_MS = 10_000;
/**
 * Cadence de veille : une rencontre est prévue aujourd'hui mais n'a pas commencé. Il FAUT
 * continuer à sonder dans ce cas précis — `anyLive` se déduit du dernier chargement, donc ne
 * peut devenir vrai que par un chargement. Sans cela, un membre qui ouvre l'onglet avant le
 * premier point ne verrait jamais la rencontre démarrer.
 */
const IDLE_POLL_MS = 60_000;
/**
 * Combien d'échecs CONSÉCUTIFS avant de cesser de sonder pour ce seul motif.
 *
 * Sans cette borne, la nuance qui distingue « je n'ai pas réussi à savoir » de « la journée est
 * finie » rouvrait le trou qu'elle est censée fermer : un 5xx durable — ou un 404 après qu'un
 * admin a coupé le flag — laissait le sondage de veille tourner un appel par minute pendant des
 * heures, exactement le coût que l'en-tête de ce fichier dit avoir éliminé. Réessayer est juste ;
 * réessayer sans fin ne l'est pas.
 *
 * Cinq essais, c'est-à-dire cinq minutes à la cadence de veille : de quoi traverser une coupure
 * réseau ou un réveil de base, pas de quoi tenir un après-midi. Au-delà on s'en remet au retour
 * au premier plan, qui recharge sans condition et remet le compteur à zéro.
 */
const MAX_POLL_FAILURES = 5;

type LiveMatch = {
  id: string;
  order: number;
  home: string;
  away: string;
  homeColor: string | null;
  awayColor: string | null;
  status: string;
  gamesHome: number | null;
  gamesAway: number | null;
  games: { home: number; away: number }[];
  live: { current: { home: number; away: number }; serving: "home" | "away" | null } | null;
};

type LiveFixture = {
  id: string;
  date: string;
  teamId: string;
  teamName: string;
  opponent: string;
  home: boolean;
  /** Combien de simples compte la rencontre — ce qui reste à jouer se déduit de là. */
  matchCount: number;
  status: string;
  score: { home: number; away: number };
  matches: LiveMatch[];
};

/** Date du jour en heure MURALE du club (règle unique du projet, cf. lib/time.ts). */
function todayISO(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: CLUB_TZ });
}

/** "2026-10-15" → "jeu. 15 oct." */
function shortDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
}

/**
 * La rencontre peut-elle encore bouger d'une minute à l'autre ? C'est la SEULE chose qui
 * justifie de sonder, et la seule qui mérite la carte détaillée.
 *
 * ⚠️ LA DATE COMPTE, ET PAS SEULEMENT L'ÉTAT. Ce panneau garde désormais les rencontres des
 * jours précédents (cf. `RECENT_FIXTURE_DAYS`), et une rencontre d'hier restée « en cours »
 * faute d'avoir saisi ses deux derniers simples n'a RIEN à sonder : personne ne la joue. Se
 * fier au seul statut, c'était sonder toutes les dix secondes pendant quatre jours — le coût
 * même que l'en-tête de ce fichier dit avoir éliminé. Il le faisait déjà, sur deux jours.
 *
 * La veille n'entre que si un simple y est EN COURS DE MARQUAGE : c'est la soirée qui déborde
 * après minuit, pas celle qu'on a laissée inachevée.
 */
function enJeu(f: LiveFixture, today: string): boolean {
  if (f.status === "done") return false;
  if (f.date === today) return true;
  return f.date === shiftISO(today, -1) && f.matches.some((m) => m.status === "live");
}

function Dot({ color }: { color: string | null }) {
  const c = resolveColor(color);
  if (!c) return null;
  return <span className="ic-dot ic-dot-lg" style={{ background: c.bg, borderColor: c.fg }} />;
}

export default function InterclubLive({
  onExpired,
  onOpen,
}: {
  onExpired: (status: number) => boolean;
  /** Ouvre la fiche de la rencontre — la carte y mène d'un appui, sans chercher dans la liste. */
  onOpen?: (fixtureId: string) => void;
}) {
  const [fixtures, setFixtures] = useState<LiveFixture[] | null>(null);
  /** Échecs consécutifs : tant qu'il y en a, on ne conclut RIEN sur ce qu'il y a à voir. */
  const [failures, setFailures] = useState(0);
  const today = todayISO();
  const anyLive = (fixtures ?? []).some((f) => f.status === "live" && enJeu(f, today));
  const anyLiveRef = useRef(false);
  anyLiveRef.current = anyLive;

  // Y a-t-il encore quelque chose à attendre aujourd'hui ? `null` = on n'a pas encore chargé,
  // et il faut alors sonder pour le découvrir. Une liste vide, ou dont tout est terminé, ferme
  // le sujet jusqu'au prochain retour au premier plan.
  //
  // ⚠️ Le compteur d'échecs est indispensable : en cas d'échec réseau, `load` retombe sur une
  // liste VIDE pour ne pas bloquer l'affichage — ce qui, sans cette nuance, se lirait « rien à
  // voir aujourd'hui » et arrêterait le sondage pour toute la session. Une coupure de trois
  // secondes en début de soirée aurait éteint le direct jusqu'au prochain changement d'onglet.
  //
  // …mais il est BORNÉ (cf. `MAX_POLL_FAILURES`), et la borne l'emporte sur TOUT le reste : un
  // échec qui dure n'est plus une coupure, c'est un état, et insister n'y change rien. Elle
  // couvre donc aussi le cas où la liste garde une rencontre en cours — `load` conserve la
  // dernière liste connue sur échec, et on sonderait sinon pour une rencontre dont on ne peut
  // plus rien apprendre.
  const givenUp = failures >= MAX_POLL_FAILURES;
  const somethingToWatch =
    !givenUp && (fixtures === null || failures > 0 || fixtures.some((f) => enJeu(f, today)));

  // ⚠️ `onExpired` PASSE PAR UNE REF, ET N'ENTRE PAS EN DÉPENDANCE — c'est ici que se joue la
  // valeur de tout ce qui précède.
  //
  // `load` est la dépendance des trois effets ci-dessous. Si son identité change, les trois se
  // rejouent : le chargement de montage repart SANS consulter `somethingToWatch` ni `givenUp`,
  // l'intervalle est démonté puis remonté — donc `ticks` retombe à zéro et la cadence de veille
  // (`ticks % 6`) ne peut plus jamais atteindre 6 —, et `onForeground` se réabonne, remettant à
  // zéro le dédoublonnage qu'il existe pour garantir.
  //
  // Or `onExpired` arrivait en fonction NUE du parent : identité neuve à chaque rendu de la
  // page. Les trois garde-fous décrits en tête de fichier étaient donc contournés par le
  // chemin le plus banal qui soit — un toast affiché ailleurs dans l'appli, puis sa
  // disparition 3,5 s plus tard, suffisaient à relancer le sondage un dimanche sans rencontre.
  // Le garde-fou n° 1, dont l'en-tête raconte qu'il a « longtemps été FAUX », l'était encore,
  // par un autre chemin.
  const onExpiredRef = useRef(onExpired);
  onExpiredRef.current = onExpired;

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/interclub/live", { cache: "no-store" });
      if (onExpiredRef.current(res.status)) return;
      const data = await readOk<{ fixtures: LiveFixture[] }>(res);
      setFixtures(data.fixtures);
      setFailures(0);
    } catch {
      // Silencieux : un direct qui ne se rafraîchit pas ne mérite pas d'interrompre la
      // lecture. Le prochain passage réessaiera — d'où `failed`, qui distingue « la journée
      // est finie » (on peut cesser de sonder) de « je n'ai pas réussi à savoir » (surtout pas).
      setFixtures((f) => f ?? []);
      setFailures((n) => n + 1);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    // Rien à voir aujourd'hui : AUCUN intervalle. C'est le cas le plus fréquent de loin — la
    // vue est ouverte un jour sans rencontre — et c'est celui qui coûtait le plus cher, parce
    // qu'il durait aussi longtemps que l'onglet restait ouvert.
    if (!somethingToWatch) return;

    // Sinon on sonde tant que l'onglet est visible, mais six fois moins vite tant que rien
    // n'est en cours : assez pour voir la rencontre démarrer, sans peser avant le premier point.
    let ticks = 0;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      ticks += 1;
      if (!anyLiveRef.current && ticks % (IDLE_POLL_MS / POLL_MS) !== 0) return;
      load();
    };
    const t = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(t);
  }, [load, somethingToWatch]);

  // Au retour sur l'onglet on rafraîchit tout de suite, en cours ou non : c'est le geste qui
  // exprime « montre-moi où ça en est ». Effet SÉPARÉ du sondage, et sans condition : c'est ce
  // qui rattrape une rencontre créée après le chargement, un jour où l'on avait justement
  // arrêté de sonder faute de quoi que ce soit à attendre.
  useEffect(() => onForeground(load), [load]);

  // DEUX GROUPES, ET DEUX FORMES DE CARTE.
  //
  // « En direct » : ce qui se joue aujourd'hui, et la soirée d'hier si elle déborde après
  // minuit. Carte DÉTAILLÉE — avance, simples, jeu en cours — tant que la rencontre peut encore
  // bouger.
  //
  // « Ces derniers jours » : les rencontres des `RECENT_FIXTURE_DAYS` jours précédents,
  // terminées ou non. Elles restent EN HAUT de l'écran pour qu'on puisse finir d'en saisir les
  // scores sans les chercher dans la liste (demande du club, 2026-10-16).
  //
  // ⚠️ CE QUI EST JOUÉ SE RÉSUME EN UNE LIGNE. Une rencontre terminée restait ici avec tous ses
  // simples, et le bandeau annonçait « En direct » au-dessus d'un écran entier de scores figés,
  // en doublon de la liste juste en dessous ; on l'avait donc retirée. La demande inverse —
  // la garder à portée — ne rouvre pas ce défaut : une ligne, l'état, le score, et un appui
  // pour ouvrir la fiche, où tout le détail se trouve.
  //
  // Le tri est celui du serveur (date décroissante) : aujourd'hui d'abord, puis on remonte.
  const all = fixtures ?? [];
  const live = all.filter((f) => f.date === today || enJeu(f, today));
  const recent = all.filter((f) => !live.includes(f));

  /** La carte entière ouvre la fiche : un seul bouton, étiré sur toute sa surface (CSS). */
  const ouvrir = (f: LiveFixture, who: string) =>
    onOpen && (
      <button type="button" className="ic-live-open" onClick={() => onOpen(f.id)}>
        {/* L'espace HORS du `sr-only` : dedans, le calcul du nom accessible le rogne et
            colle les deux moitiés (« rencontre :Équipe 1 »). */}
        <span className="sr-only">Ouvrir la rencontre :</span>{" "}
        <span className="ic-live-who">{who}</span>
      </button>
    );

  const carte = (f: LiveFixture) => {
    const etat = fixtureDisplayStatus(f, today);
    const detail = enJeu(f, today);
    // L'ÉQUIPE QUI REÇOIT EN PREMIER, partout dans la carte (demande du club, 2026-10-09) : le
    // titre, le score de la rencontre, chaque simple et ses chiffres. La donnée garde son sens
    // — `home` est toujours NOUS.
    const who = f.home ? `${f.teamName} reçoit ${f.opponent}` : `${f.opponent} reçoit ${f.teamName}`;
    return (
      <article
        key={f.id}
        className={`ic-live-card${f.status === "live" && detail ? " is-live" : ""}${
          detail ? "" : " is-compact"
        }${onOpen ? " is-link" : ""}`}
      >
        <header className="ic-live-head">
          {onOpen ? ouvrir(f, who) : <span className="ic-live-who">{who}</span>}
          {/* Hors du direct, la DATE : « hier » ne se devine pas d'une ligne parmi trois. */}
          {f.date !== today && <span className="ic-live-date muted">{shortDate(f.date)}</span>}
          {/* La pastille d'état du reste de l'interclub, reprise telle quelle. Ce panneau
              montre les rencontres du jour, PAS seulement celles qui ont commencé — c'est
              ce qui permet de voir la sienne démarrer. Sans état affiché, une rencontre
              qui n'a pas commencé et une rencontre à 0–0 étaient le même écran. */}
          <span className={`ic-status ic-${etat}`}>
            <span className="sr-only">État : </span>
            {FIXTURE_STATUS_LABEL[etat]}
          </span>
          <span className="ic-live-score">
            {f.home ? `${f.score.home}–${f.score.away}` : `${f.score.away}–${f.score.home}`}
          </span>
          {onOpen && (
            <span className="ic-live-chevron" aria-hidden="true">
              ›
            </span>
          )}
        </header>
        {/* L'AVANCE, sous le score et au-dessus des simples : elle porte sur la rencontre
            entière, pas sur un match. Réservée à ce qui a COMMENCÉ — une rencontre du soir
            encore à venir n'a pas d'avance, et une ligne de zéros ne dirait rien. */}
        {detail && f.status === "live" && (
          <InterclubTally matchCount={f.matchCount} matches={f.matches} compact />
        )}
        {detail && (
          <ul className="ic-live-matches">
            {f.matches.map((m) => (
              <li key={m.id}>
                <span className="ic-order">#{m.order}</span>
                {(f.home ? (["home", "away"] as const) : (["away", "home"] as const)).map(
                  (cote, i) => (
                    <Fragment key={cote}>
                      {i === 1 && (
                        <span className="ic-versus" title="contre">
                          <span className="sr-only">contre</span>
                          <span aria-hidden="true">c.</span>
                        </span>
                      )}
                      <span className="ic-player">
                        <Dot color={cote === "home" ? m.homeColor : m.awayColor} />
                        {cote === "home" ? m.home : m.away}
                        {/* AU SERVICE. La donnée arrivait déjà — `getLiveFixtures` la met dans
                          la charge utile, les deux vues la déclaraient dans leur type — et
                          aucune ne l'affichait. Or « 7–5 » sans savoir qui sert ne se lit pas :
                          c'est l'information qui transforme un score en cours en score suivi.
                          Coût serveur nul, elle est déjà payée. */}
                        {m.live?.serving === cote && <AuService />}
                      </span>
                    </Fragment>
                  ),
                )}
                <span className="ic-games">
                  {m.live ? (
                    <span className="ic-inplay">
                      {f.home
                        ? `${m.live.current.home}–${m.live.current.away}`
                        : `${m.live.current.away}–${m.live.current.home}`}
                    </span>
                  ) : null}
                  {m.gamesHome !== null ? (
                    <span className="ic-gamescore">
                      {f.home ? `${m.gamesHome}–${m.gamesAway}` : `${m.gamesAway}–${m.gamesHome}`}
                    </span>
                  ) : !m.live ? (
                    <span className="muted tiny">—</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </article>
    );
  };

  return (
    <section className="ic-live">
      <h4 className="ic-live-title">En direct</h4>

      {fixtures === null ? (
        <p className="muted tiny">Chargement…</p>
      ) : live.length === 0 ? (
        <p className="muted tiny">Aucune rencontre aujourd&apos;hui.</p>
      ) : (
        live.map(carte)
      )}

      {recent.length > 0 && (
        <>
          <h4 className="ic-live-title ic-live-title-recent">Ces derniers jours</h4>
          {recent.map(carte)}
        </>
      )}
    </section>
  );
}
