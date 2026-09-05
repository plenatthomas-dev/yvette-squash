"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { readOk } from "@/lib/apiFetch";
import { onForeground } from "@/lib/onForeground";
import { resolveColor } from "@/lib/interclub";

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
  status: string;
  score: { home: number; away: number };
  matches: LiveMatch[];
};

function Dot({ color }: { color: string | null }) {
  const c = resolveColor(color);
  if (!c) return null;
  return <span className="ic-dot ic-dot-lg" style={{ background: c.bg, borderColor: c.fg }} />;
}

export default function InterclubLive({
  onExpired,
}: {
  onExpired: (status: number) => boolean;
}) {
  const [fixtures, setFixtures] = useState<LiveFixture[] | null>(null);
  /** Échecs consécutifs : tant qu'il y en a, on ne conclut RIEN sur ce qu'il y a à voir. */
  const [failures, setFailures] = useState(0);
  const anyLive = (fixtures ?? []).some((f) => f.status === "live");
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
    !givenUp && (fixtures === null || failures > 0 || fixtures.some((f) => f.status !== "done"));

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

  // Une rencontre TERMINÉE n'est plus en direct, et n'a rien à faire sous ce titre. Elle y
  // restait pourtant jusqu'à minuit, ses matchs avec elle : le bandeau annonçait « En direct »
  // au-dessus d'un écran entier de scores figés, en doublon de la liste des rencontres juste
  // en dessous — où la même rencontre porte déjà son score final, sa pastille « Terminée », et
  // le détail de tous les jeux à un appui.
  //
  // Le filtrage est ici, à L'AFFICHAGE, et non dans la requête. La réponse COMPLÈTE est ce qui
  // permet de distinguer « rien de prévu aujourd'hui » de « c'est fini pour ce soir », et c'est
  // elle aussi que lit `somethingToWatch` pour décider d'arrêter de sonder ; un serveur qui ne
  // renverrait que le vivant rendrait ces deux cas indiscernables, vides tous les deux.
  //
  // Ce qui est PRÉVU aujourd'hui reste affiché, lui : c'est la raison d'être de la cadence de
  // veille (`IDLE_POLL_MS`), qui existe précisément pour voir la rencontre démarrer.
  const shown = (fixtures ?? []).filter((f) => f.status !== "done");

  return (
    <section className="ic-live">
      <h4 className="ic-live-title">En direct</h4>

      {fixtures === null ? (
        <p className="muted tiny">Chargement…</p>
      ) : shown.length === 0 ? (
        <p className="muted tiny">
          {fixtures.length === 0
            ? "Aucune rencontre aujourd'hui."
            : "Les rencontres du jour sont terminées."}
        </p>
      ) : (
        shown.map((f) => (
          <article
            key={f.id}
            className={`ic-live-card${f.status === "live" ? " is-live" : ""}`}
          >
            <header className="ic-live-head">
              <span className="ic-live-who">
                {f.teamName} {f.home ? "reçoit" : "chez"} {f.opponent}
              </span>
              {/* La pastille d'état du reste de l'interclub, reprise telle quelle. Ce panneau
                  montre les rencontres du jour, PAS seulement celles qui ont commencé — c'est
                  ce qui permet de voir la sienne démarrer. Sans état affiché, une rencontre
                  qui n'a pas commencé et une rencontre à 0–0 étaient le même écran. */}
              <span className={`ic-status ic-${f.status}`}>
                <span className="sr-only">État : </span>
                {f.status === "live" ? "En cours" : "À venir"}
              </span>
              <span className="ic-live-score">
                {f.score.home}–{f.score.away}
              </span>
            </header>
            <ul className="ic-live-matches">
              {f.matches.map((m) => (
                <li key={m.id}>
                  <span className="ic-order">#{m.order}</span>
                  <span className="ic-player">
                    <Dot color={m.homeColor} />
                    {m.home}
                  </span>
                  <span className="ic-versus" title="contre">
                    <span className="sr-only">contre</span>
                    <span aria-hidden="true">c.</span>
                  </span>
                  <span className="ic-player">
                    <Dot color={m.awayColor} />
                    {m.away}
                  </span>
                  <span className="ic-games">
                    {m.live ? (
                      <span className="ic-inplay">
                        {m.live.current.home}–{m.live.current.away}
                      </span>
                    ) : null}
                    {m.gamesHome !== null ? (
                      <span className="ic-gamescore">
                        {m.gamesHome}–{m.gamesAway}
                      </span>
                    ) : !m.live ? (
                      <span className="muted tiny">—</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </article>
        ))
      )}

    </section>
  );
}
