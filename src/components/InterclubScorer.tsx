"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyPoint,
  applyServe,
  BREAK_SECONDS,
  replay,
  resolveColor,
  seedEvents,
  undo as undoEvent,
  winGamesFor,
  type Box,
  type GameScore,
  type ScoreEvent,
  type Side,
} from "@/lib/interclub";
import { isSoundEnabled } from "@/lib/sound";

// Écran de marquage, au bord du terrain. Trois partis pris commandent tout le reste :
//
//  1. LOCAL-FIRST. Le journal des points vit dans `localStorage`, l'écran ne bloque JAMAIS sur
//     le réseau. Une salle de squash est un sous-sol : si compter dépendait d'une requête, le
//     marqueur abandonnerait au troisième échange.
//  2. L'état se DÉRIVE du journal (`replay`). L'undo est donc un `pop()` suivi d'un rejeu :
//     un seul chemin de code, aucune divergence possible entre l'écran et les données.
//  3. La synchro envoie l'ÉTAT COMPLET, jamais un delta — donc idempotente, donc une reprise
//     après coupure ne demande ni file ordonnée ni numéro de séquence.

const SYNC_MS = 5_000;
const LOG_PREFIX = "ic:log:";
// Combien de jeux le SERVEUR a confirmés à ce journal. Clé séparée, et non un champ ajouté au
// journal : les journaux déjà posés sur les téléphones du club restent lisibles tels quels, et
// son absence se traite comme « on ne sait pas ».
const ACK_PREFIX = "ic:ack:";

type MatchInfo = {
  id: string;
  order: number;
  homeDisplayName: string;
  awayName: string;
  homeColor: string | null;
  awayColor: string | null;
  games: { number: number; home: number; away: number }[];
};

function loadLog(matchId: string): ScoreEvent[] | null {
  try {
    const raw = localStorage.getItem(LOG_PREFIX + matchId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ScoreEvent[]) : null;
  } catch {
    return null;
  }
}

function saveLog(matchId: string, events: ScoreEvent[]) {
  try {
    localStorage.setItem(LOG_PREFIX + matchId, JSON.stringify(events));
  } catch {
    // Quota plein ou stockage refusé : on continue en mémoire. Perdre la reprise après
    // rechargement est regrettable, empêcher de compter le serait bien plus.
  }
}

export function clearLog(matchId: string) {
  try {
    localStorage.removeItem(LOG_PREFIX + matchId);
    localStorage.removeItem(ACK_PREFIX + matchId);
  } catch {
    /* sans importance */
  }
}

/**
 * Nombre de jeux que le serveur a confirmés au dernier envoi réussi, ou `null` si on l'ignore.
 *
 * C'est la BASE de la concurrence optimiste du marquage, et non le compte qu'on s'apprête à
 * envoyer : un undo qui défait un jeu gagnant raccourcit le second sans toucher au premier, et
 * doit rester légal. Ce que ce nombre affirme, c'est « voilà l'état du serveur sur lequel mon
 * journal est bâti » ; s'il ne s'y retrouve plus, c'est que quelqu'un d'autre a écrit.
 */
/**
 * Base de la concurrence optimiste, telle qu'on la connaît vraiment : un nombre CONFIRMÉ par le
 * serveur, ou `"unsure"` — « j'ai écrit, je n'ai pas entendu la réponse ».
 *
 * Ce troisième état n'est pas un raffinement, il ferme une perte de données. Un envoi qui part,
 * que le serveur COMMIT, et dont la réponse se perd en route — le sous-sol du club, précisément
 * le cas que ce fichier revendique de savoir traiter — laissait le marqueur affirmer au coup
 * suivant un compte que la base avait déjà dépassé de un. Le serveur refusait alors en
 * `stale-games`, et la réaction à ce refus est la plus destructrice de tout le fichier :
 * `clearLog`. Les points du jeu en cours, qui n'existaient que là, disparaissaient — au nom
 * d'un conflit avec soi-même.
 *
 * On ne peut pas affirmer ce qu'on n'a pas entendu. Dans le doute on n'annonce rien : le champ
 * devient absent, et le serveur applique alors sa propre règle — il laisse CROÎTRE une liste
 * sans base annoncée (le chemin du marqueur, qui ne détruit rien) et refuse toujours d'en
 * RETIRER (cf. l'en-tête de `PUT …/live`). La garde ne s'affaiblit donc que là où elle ne
 * protégeait rien.
 */
type Ack = number | "unsure";

/** Marque écrite à la place du compte quand le sort d'un envoi est inconnu. */
const ACK_UNSURE = "?";

function loadAck(matchId: string): Ack | null {
  try {
    const raw = localStorage.getItem(ACK_PREFIX + matchId);
    if (raw === null) return null;
    // Le doute SURVIT au rechargement : sans cela, refermer puis rouvrir l'appli après une
    // réponse perdue rejouait la perte à l'identique, le journal ayant survécu et le compte
    // enregistré étant resté au dernier succès.
    if (raw === ACK_UNSURE) return "unsure";
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

function saveAck(matchId: string, ack: Ack) {
  try {
    localStorage.setItem(ACK_PREFIX + matchId, ack === "unsure" ? ACK_UNSURE : String(ack));
  } catch {
    // Même parti pris que `saveLog` : le stockage refusé ne doit pas empêcher de compter.
  }
}

/** mm:ss */
function mmss(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Issue d'un envoi, telle que `finish` a besoin de la connaître.
 *
 * `push` reste best-effort : il n'interrompt JAMAIS le marquage, c'est le parti pris n° 1 de ce
 * fichier. Mais il ne peut pas pour autant AVALER son issue, car `finish` purge le journal
 * local — seule copie du match tant que le serveur n'a rien accepté. Sans cette valeur de
 * retour, un match compté de bout en bout dans le sous-sol disparaissait au « Terminer ».
 */
type PushOutcome = "ok" | "conflict" | "offline" | "expired" | "stale";

export default function InterclubScorer({
  fixtureId,
  match,
  bestOf,
  onClose,
  onExpired,
  toast,
}: {
  fixtureId: string;
  match: MatchInfo;
  bestOf: number;
  onClose: () => void;
  onExpired: (status: number) => boolean;
  toast: (type: "ok" | "err" | "info", msg: string) => void;
}) {
  const [events, setEvents] = useState<ScoreEvent[]>([]);
  // Miroir toujours à jour du journal. Deux appuis très rapprochés — deux échanges gagnés coup
  // sur coup — ne doivent pas dépendre du fait que React ait rendu entre les deux : `commit`
  // part de cette référence, jamais de la valeur capturée par la fermeture de rendu.
  const eventsRef = useRef<ScoreEvent[]>([]);
  const [ready, setReady] = useState(false);
  const [offline, setOffline] = useState(false);
  const [breakUntil, setBreakUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const state = replay(events, bestOf);
  const needed = winGamesFor(bestOf);
  const homeC = resolveColor(match.homeColor);
  const awayC = resolveColor(match.awayColor);

  // --- journal local ---------------------------------------------------------
  // Amorcé UNE SEULE FOIS par match. `match.games` est une référence de tableau reconstruite à
  // chaque rechargement du parent — donc à chaque retour au premier plan. Sans ce verrou,
  // l'amorçage se rejouait, et lorsque `localStorage` est indisponible (mode privé, quota) il
  // repartait des jeux connus du serveur : les points du jeu en cours étaient effacés, alors
  // que `saveLog` promet précisément de « continuer en mémoire ».
  const seededFor = useRef<string | null>(null);
  const ackRef = useRef<Ack | null>(null);
  useEffect(() => {
    if (seededFor.current === match.id) return;
    seededFor.current = match.id;
    const local = loadLog(match.id);
    // Pas de journal ici ? Le match a pu être entamé sur un autre téléphone, ou saisi à la
    // main. On repart des jeux connus du serveur (score fidèle, déroulé reconstitué).
    const seed = local ?? seedEvents(match.games.map((g) => ({ home: g.home, away: g.away })), bestOf);
    eventsRef.current = seed;
    setEvents(seed);
    // Sur quel état du serveur ce journal est-il bâti ? Amorcé depuis le serveur, la réponse
    // est immédiate. Repris d'un journal local, elle a été notée au dernier envoi réussi ; à
    // défaut — journal d'avant cette clé, stockage vidé — on retient ce que le journal lui-même
    // a fait connaître, c'est-à-dire ses propres jeux terminés. Ce choix fait pencher le doute
    // du côté du SERVEUR, qui est la copie partagée.
    ackRef.current = (local ? loadAck(match.id) : null) ?? replay(seed, bestOf).games.length;
    setReady(true);
  }, [match.id, match.games, bestOf]);

  useEffect(() => {
    if (ready) saveLog(match.id, events);
  }, [ready, match.id, events]);

  // --- synchro serveur -------------------------------------------------------
  const lastSentRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const pendingRef = useRef<ScoreEvent[] | null>(null);
  /** Envoi en cours, s'il y en a un : deux envois ne se croisent jamais (cf. `push`). */
  const inFlightRef = useRef<Promise<void> | null>(null);
  /** Le marquage est clos — journal périmé, session expirée. Plus rien ne doit partir. */
  const deadRef = useRef(false);

  const sendNow = useCallback(
    async (evts: ScoreEvent[]): Promise<PushOutcome> => {
      // Un envoi mis en file DERRIÈRE celui qui vient de clore le marquage n'a plus lieu
      // d'être : le journal a été purgé, ou la session a expiré. Le laisser partir renverrait
      // au serveur un état qu'on vient précisément de déclarer mort — et, `knownGameCount`
      // ayant été remis à zéro par la purge, sans même la garde qui l'aurait refusé.
      if (deadRef.current) return "stale";
      const st = replay(evts, bestOf);
      // Horodaté AVANT la requête, et non après un succès.
      //
      // Cette marque borne la cadence d'envoi (cf. `scheduleSync`), et c'est sur cette borne —
      // « une écriture toutes les 5 s au plus » — que reposent le modèle de coût de
      // `interclub-gate.ts` et le commentaire de `schema.prisma` sur `liveJson`. En ne la
      // posant qu'en cas de SUCCÈS, l'ancienne version la laissait à sa valeur ancienne dès
      // qu'un envoi échouait : `wait` retombait à 0, et CHAQUE point tapé déclenchait aussitôt
      // un PUT — donc une transaction Serializable — au lieu d'un toutes les 5 secondes. Deux
      // onglets sur le même match (409 en boucle) ou un réseau intermittent suffisaient à
      // transformer la borne en son contraire, exactement quand la base souffrait déjà.
      //
      // Ce qu'on veut borner, c'est le nombre de REQUÊTES ÉMISES ; leur issue n'y change rien.
      lastSentRef.current = Date.now();
      try {
        const res = await fetch(`/api/interclub/${fixtureId}/matches/${match.id}/live`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            games: st.games,
            // L'état du serveur sur lequel ce journal est bâti (cf. `loadAck`). `undefined`
            // disparaît de la sérialisation, et le serveur retombe alors sur sa propre règle —
            // le champ est facultatif de son côté pour une écriture qui ne retire rien.
            //
            // On n'annonce QUE ce qui a été confirmé : `"unsure"` — un envoi dont la réponse
            // s'est perdue — ne s'annonce pas, sous peine de se déclarer en conflit avec sa
            // propre écriture et d'y perdre le journal.
            knownGameCount: typeof ackRef.current === "number" ? ackRef.current : undefined,
            live: st.status === "done" ? null : {
              current: st.current,
              serving: st.serving,
              servingBox: st.servingBox,
              awaitingServeBox: st.awaitingServeBox,
            },
          }),
        });
        if (onExpired(res.status)) {
          deadRef.current = true;
          return "expired";
        }
        if (res.status === 409) {
          setOffline(false);
          // Deux refus partagent ce statut, et ils demandent l'inverse l'un de l'autre : d'où
          // le code renvoyé par le serveur, sur lequel on branche — jamais sur le message.
          const code = await res
            .json()
            .then((d) => (d as { code?: string } | null)?.code)
            .catch(() => undefined);
          if (code === "stale-games") {
            // Le serveur a dépassé ce journal : quelqu'un a saisi un jeu pendant qu'on avait le
            // dos tourné. Le journal ne décrit plus rien — on le jette, et on ferme pour que le
            // parent recharge la rencontre. Rouvrir « Reprendre le marquage » repartira du
            // score enregistré, seule version que tout le monde partage.
            clearLog(match.id);
            ackRef.current = null;
            deadRef.current = true;
            toast("err", "Le score a changé ailleurs — rouvre le marquage pour repartir du score enregistré.");
            onClose();
            return "stale";
          }
          toast("err", "Quelqu'un d'autre marque ce match.");
          return "conflict";
        }
        setOffline(!res.ok);
        if (!res.ok) {
          // Un 5xx est SANS DOUTE une transaction annulée, donc aucune écriture — mais
          // « sans doute » ne suffit pas : une passerelle qui rend 502 après que le serveur a
          // commité ressemble exactement à cela. On ne sait pas, donc on ne l'affirmera pas.
          ackRef.current = "unsure";
          saveAck(match.id, "unsure");
          return "offline";
        }
        // Le serveur a pris ce corps : c'est désormais l'état sur lequel le journal est bâti.
        ackRef.current = st.games.length;
        saveAck(match.id, st.games.length);
        return "ok";
      } catch {
        // Hors-ligne : on garde la main, la prochaine tentative renverra l'état COMPLET.
        //
        // Et l'on note qu'on NE SAIT PAS si celle-ci a abouti : `fetch` jette aussi bien avant
        // d'atteindre le serveur qu'après qu'il a commité, la réponse s'étant perdue au retour.
        // Rien ne distingue les deux ici, et c'est tout le propos de `"unsure"`.
        setOffline(true);
        ackRef.current = "unsure";
        saveAck(match.id, "unsure");
        return "offline";
      }
    },
    [fixtureId, match.id, bestOf, onExpired, onClose, toast],
  );

  /**
   * DEUX ENVOIS NE SE CROISENT JAMAIS.
   *
   * `sendNow` lit `ackRef` au départ de la requête et ne le met à jour qu'au retour. Deux
   * envois en vol portent donc le MÊME compte, alors que le premier à commiter le périme pour
   * l'autre — qui se voyait refuser en `stale-games`, purger le journal et fermer l'écran sur
   * un « le score a changé ailleurs » alors que personne d'autre n'avait rien touché.
   *
   * Le cas n'avait rien d'exotique : c'est le geste normal de fin de match. Le jeu décisif se
   * clôt, `scheduleSync` lâche son envoi, le marqueur tape « Terminer » dans la foulée, et
   * `finish` en lâche un second — il annulait bien le minuteur, mais pas une requête déjà
   * partie.
   *
   * Mis en file, le second part APRÈS que le premier a rendu son verdict, donc avec le compte
   * à jour : le serveur l'accepte comme la réécriture idempotente qu'il est.
   */
  const push = useCallback(
    (evts: ScoreEvent[]): Promise<PushOutcome> => {
      const run = (inFlightRef.current ?? Promise.resolve()).then(() => sendNow(evts));
      // La file ne retient JAMAIS une erreur : `sendNow` rend toujours une issue plutôt que de
      // jeter, et ce maillon ne doit de toute façon pas empêcher le suivant de partir.
      inFlightRef.current = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    [sendNow],
  );

  const scheduleSync = useCallback(
    (evts: ScoreEvent[]) => {
      pendingRef.current = evts;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      // La borne s'applique à TOUT le marquage, sans porte de sortie.
      //
      // Il existait une option `immediate` qui mettait `wait` à 0 sans même regarder
      // `lastSentRef` : elle court-circuitait donc la seule chose qui borne la cadence. Elle
      // était vraie pour chaque fin de jeu, chaque fin de match, et chaque UNDO — or annuler
      // cinq points d'affilée, geste ordinaire quand on rattrape une inattention, envoyait cinq
      // PUT en trois secondes, donc cinq transactions Serializable et cinq invalidations du
      // direct. La borne annoncée partout ailleurs (`schema.prisma`, `interclub-gate.ts`,
      // `docs/interclub.md`) était fausse d'un facteur ~8 sur cette fenêtre.
      //
      // Rien ne se perd à la refermer : chaque appui replanifie l'envoi à `lastSent + SYNC_MS`,
      // le premier appui après une accalmie part immédiatement (`wait` vaut 0), les spectateurs
      // sondent de toute façon toutes les 10 s — plus lentement que la borne elle-même — et le
      // seul envoi réellement urgent, celui du score final, part hors de cette file par
      // `finish`, qui appelle `push` directement.
      const wait = Math.max(0, SYNC_MS - (Date.now() - lastSentRef.current));
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        const p = pendingRef.current;
        pendingRef.current = null;
        if (p) push(p);
      }, wait);
    },
    [push],
  );

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  // --- minuteur de pause -----------------------------------------------------
  useEffect(() => {
    if (breakUntil === null) return;
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [breakUntil]);

  const remaining = breakUntil === null ? 0 : Math.max(0, Math.ceil((breakUntil - now) / 1000));
  useEffect(() => {
    if (breakUntil === null || remaining > 0) return;
    if (isSoundEnabled()) {
      // Réutilise le bip déjà connu des membres plutôt que d'inventer un son de plus.
      import("@/lib/sound").then((m) => m.playAlert()).catch(() => {});
    }
    // La pause est FINIE : on l'éteint ici, et pas seulement sur « Reprendre maintenant » ou
    // sur un undo. Sans cela `breakUntil` restait posé, donc l'intervalle de 500 ms continuait
    // de battre — deux rendus complets de l'écran par seconde jusqu'au jeu suivant, alors que
    // le panneau de pause a déjà disparu et que plus rien ne dépend de `now`.
    setBreakUntil(null);
  }, [breakUntil, remaining]);

  // --- actions ---------------------------------------------------------------
  function commit(build: (prev: ScoreEvent[]) => ScoreEvent[]) {
    const prev = eventsRef.current;
    const next = build(prev);
    const before = replay(prev, bestOf);
    const after = replay(next, bestOf);
    eventsRef.current = next;
    setEvents(next);

    const gameEnded = after.games.length > before.games.length;
    const finished = after.status === "done";
    if (gameEnded && !finished) setBreakUntil(Date.now() + BREAK_SECONDS * 1000);
    scheduleSync(next);
  }

  /**
   * Tant que le premier serveur n'est pas désigné, marquer n'a pas de sens — et `applyPoint`
   * IGNORE d'ailleurs un point dans cet état (« on ne devine pas un serveur »). Sans cette
   * condition, les deux grandes cases restaient actives et absorbaient les appuis en silence :
   * le pire des états pour un écran qu'on utilise sans le regarder, au bord du terrain.
   */
  const attendServeur = state.serving === null;

  const scorePoint = (side: Side) => {
    if (attendServeur || state.awaitingServeBox || state.status === "done" || remaining > 0) return;
    commit((prev) => applyPoint(prev, bestOf, side));
  };

  const chooseBox = (box: Box) => {
    if (!state.serving) return;
    const who = state.serving;
    commit((prev) => applyServe(prev, bestOf, who, box));
  };

  const chooseFirstServer = (side: Side, box: Box) =>
    commit((prev) => applyServe(prev, bestOf, side, box));

  const doUndo = () => {
    setBreakUntil(null);
    commit((prev) => undoEvent(prev));
  };

  async function finish() {
    // On ATTEND l'envoi avant de fermer. `scheduleSync` pose un `setTimeout`, que le nettoyage
    // de l'effet annule au démontage : la dernière synchro reposait donc sur une course, et
    // les derniers points pouvaient ne jamais partir.
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;
    const latest = eventsRef.current;
    const outcome = await push(latest);
    // Session périmée : `onExpired` a déjà pris la main (redirection) ; journal périmé : `push`
    // a déjà purgé et fermé. Dans les deux cas il n'y a plus rien à faire ici.
    if (outcome === "expired" || outcome === "stale") return;

    // ⚠️ LE JOURNAL NE SE PURGE QUE SUR UN ENVOI CONFIRMÉ.
    //
    // `clearLog` supprime la seule copie du match tant que le serveur n'a rien accepté. Purger
    // sans regarder l'issue de `push` — ce que faisait la version précédente — perdait un match
    // entier dans le cas que ce fichier revendique pourtant de savoir traiter : compté du
    // premier au dernier point sans réseau, le badge « hors-ligne » affiché tout du long, puis
    // « Terminer ». Le score disparaissait alors des deux côtés à la fois.
    //
    // En cas d'échec on GARDE le journal et on ferme quand même : l'écran ne piège personne, et
    // rouvrir « Reprendre le marquage » relit le journal et renvoie l'état complet — la synchro
    // étant idempotente, un renvoi ne coûte rien.
    if (outcome === "ok") {
      if (replay(latest, bestOf).status === "done") clearLog(match.id);
    } else if (outcome === "offline") {
      toast("err", "Score gardé sur cet appareil : rouvre le marquage pour l'envoyer.");
    }
    // `conflict` : `push` a déjà prévenu, et le journal reste — c'est la version du marqueur.
    onClose();
  }

  if (!ready) return null;

  const side = (who: Side) => {
    const isHome = who === "home";
    const c = isHome ? homeC : awayC;
    const name = isHome ? match.homeDisplayName : match.awayName;
    const pts = isHome ? state.current.home : state.current.away;
    const won = isHome ? state.gamesWon.home : state.gamesWon.away;
    const serving = state.serving === who;
    return (
      <button
        className="ics-side"
        style={c ? { background: c.bg, color: c.fg, borderColor: c.fg } : undefined}
        onClick={() => scorePoint(who)}
        disabled={
          attendServeur || state.awaitingServeBox || state.status === "done" || remaining > 0
        }
        aria-label={`Point pour ${name}`}
      >
        <span className="ics-name">{name}</span>
        <span className="ics-points">{pts}</span>
        {/* Barre du bas : jeux gagnés à gauche, carré de service à droite. Groupés plutôt que
            posés chacun dans son coin — sur une case étroite (téléphone debout), « sert à
            gauche » et « 1 jeu » ne tiennent pas côte à côte, et se chevauchaient. Ici la
            barre se replie sur deux lignes au lieu de les superposer. */}
        <span className="ics-foot">
          <span className="ics-won">
            <span className="sr-only">Jeux gagnés : </span>
            {won} jeu{won > 1 ? "x" : ""}
          </span>
          {serving && (
            <span className="ics-serve" title={`${name} sert`}>
              sert {state.servingBox === "left" ? "à gauche" : state.servingBox === "right" ? "à droite" : ""}
            </span>
          )}
        </span>
      </button>
    );
  };

  return (
    <div className="ics" role="dialog" aria-label="Marquage du match">
      <header className="ics-head">
        <button className="secondary" onClick={() => void finish()}>
          ← Retour
        </button>
        <span className="ics-meta" title={`Match numéro ${match.order}, ${needed} jeux gagnants`}>
          Match #{match.order} · {needed} jeux gagnants
          {offline && (
            <span className="ics-offline" title="Les points sont gardés sur cet appareil">
              hors-ligne
            </span>
          )}
        </span>
        <button className="secondary" onClick={doUndo} disabled={events.length <= 1}>
          ↶ Annuler
        </button>
      </header>

      {state.games.length > 0 && (
        <p className="ics-history">
          {state.games.map((g: GameScore, i: number) => (
            <span key={i}>
              {g.home}-{g.away}
              {i < state.games.length - 1 ? " · " : ""}
            </span>
          ))}
        </p>
      )}

      <div className="ics-board">
        {side("home")}
        {side("away")}
      </div>

      {/* Premier service du match : il faut désigner qui sert ET de quel carré. */}
      {state.serving === null && state.status !== "done" && (
        <div className="ics-ask">
          <p>Qui engage&nbsp;?</p>
          <div className="ics-ask-row">
            <button onClick={() => chooseFirstServer("home", "right")}>
              {match.homeDisplayName} · droite
            </button>
            <button onClick={() => chooseFirstServer("home", "left")}>
              {match.homeDisplayName} · gauche
            </button>
          </div>
          <div className="ics-ask-row">
            <button onClick={() => chooseFirstServer("away", "right")}>
              {match.awayName} · droite
            </button>
            <button onClick={() => chooseFirstServer("away", "left")}>
              {match.awayName} · gauche
            </button>
          </div>
        </div>
      )}

      {/* Reprise de service : le carré ne se déduit pas, le joueur le CHOISIT. */}
      {state.awaitingServeBox && state.serving && state.status !== "done" && remaining === 0 && (
        <div className="ics-ask">
          <p>
            {state.serving === "home" ? match.homeDisplayName : match.awayName} sert&nbsp;:
          </p>
          <div className="ics-ask-row">
            <button onClick={() => chooseBox("right")}>Carré droit</button>
            <button onClick={() => chooseBox("left")}>Carré gauche</button>
          </div>
        </div>
      )}

      {/* Pause réglementaire entre deux jeux. Interruptible : les pauses réelles ne suivent
          pas toujours le règlement, et un minuteur qu'on ne peut pas passer devient un
          obstacle plutôt qu'une aide. */}
      {remaining > 0 && (
        <div className="ics-ask">
          <p className="ics-timer">{mmss(remaining)}</p>
          <p className="muted tiny">Pause entre les jeux</p>
          <div className="ics-ask-row">
            <button onClick={() => setBreakUntil(null)}>Reprendre maintenant</button>
          </div>
        </div>
      )}

      {state.status === "done" && (
        <div className="ics-ask">
          <p className="ics-done">
            {state.winner === "home" ? match.homeDisplayName : match.awayName} l&apos;emporte{" "}
            {state.gamesWon.home}–{state.gamesWon.away}
          </p>
          <div className="ics-ask-row">
            <button onClick={() => void finish()}>Terminer</button>
          </div>
        </div>
      )}
    </div>
  );
}
