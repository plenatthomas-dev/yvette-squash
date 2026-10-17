"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyPoint,
  replay,
  seedEvents,
  startServe,
  toggleServeBox,
  undo as undoEvent,
  winGamesFor,
  type Box,
  type ScoreEvent,
  type Side,
} from "@/lib/interclub";
import { liveMatchTimes, matchPhase, type MatchTimes } from "@/lib/interclub-duree";
import { useBreakTimer } from "@/lib/useBreakTimer";
import { keepAwake } from "@/lib/wake-lock";
import MatchClock from "./MatchClock";
import ScoreBoard, { hapticFor } from "./ScoreBoard";

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
// Les heures du chrono (premier point, point décisif), en ms. Clé séparée pour la même raison
// que `ACK_PREFIX` : un journal posé par une version antérieure reste lisible, et l'absence de
// cette clé se lit « on prend celles du serveur ».
const TIME_PREFIX = "ic:time:";
// L'ÉTAT que le serveur connaît de ce journal : empreinte (cf. `empreinte`) du dernier état
// dont il a CONFIRMÉ l'envoi — ou qu'on vient de lire chez lui à l'amorçage. Clé séparée, pour
// la même raison que `ACK_PREFIX` ; son absence se lit « on ne sait pas », et l'on garde alors
// le journal local comme avant.
//
// C'est elle qui permet de répondre, à la réouverture, à la seule question qui compte : « ce
// journal porte-t-il quelque chose que le serveur n'a pas ? » Sinon, il n'a plus rien à
// défendre, et le serveur — qui a pu avancer entre-temps sous les doigts d'un autre — fait foi.
const SENT_PREFIX = "ic:sent:";
// La RÉVISION du marquage confirmée par le serveur au dernier envoi réussi (cf. `PUT …/live`,
// migration 63). Annoncée à chaque envoi : si la base en a une autre, un autre appareil — même
// sur le même compte — a écrit entre-temps, et le serveur refuse en `stale-live` au lieu de
// laisser écraser. Absente ou « ? » (envoi au sort inconnu) : on n'annonce rien.
const REV_PREFIX = "ic:rev:";
const NO_TIMES: MatchTimes<number> = { startedAt: null, finishedAt: null };

type MatchInfo = {
  id: string;
  order: number;
  homeDisplayName: string;
  awayName: string;
  homeColor: string | null;
  awayColor: string | null;
  /** Les jeux TERMINÉS, et eux seuls. Le jeu en cours vit dans `live`. */
  games: { number: number; home: number; away: number }[];
  /**
   * Le jeu EN COURS tel que le serveur le connaît, ou `null`.
   *
   * Il manquait ici, et c'est ce qui faisait perdre des points : ce champ existe depuis
   * toujours dans la réponse de l'API (cf. `serializeInterclub`), la fiche de match l'affiche,
   * mais le marquage ne le regardait pas. On marquait jusqu'à 7-7, on rouvrait sur un autre
   * appareil, la fiche montrait 7-7 et le marquage repartait de 0-0.
   */
  live: { current: { home: number; away: number }; serving: Side | null; servingBox: Box | null } | null;
  /**
   * Heures posées par le SERVEUR (ISO), pour reprendre le chrono d'un match entamé sur un autre
   * téléphone. Facultatives : sans elles, le chrono part du premier point marqué ici.
   */
  startedAt?: string | null;
  finishedAt?: string | null;
  /** Révision du marquage lue chez le serveur (cf. `REV_PREFIX`). */
  liveRev?: number;
};

/** ISO → ms, `null` si absent ou illisible. */
function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function loadTimes(matchId: string): MatchTimes<number> | null {
  try {
    const raw = localStorage.getItem(TIME_PREFIX + matchId);
    if (!raw) return null;
    const o = JSON.parse(raw) as Record<string, unknown>;
    const ms = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    return { startedAt: ms(o?.startedAt), finishedAt: ms(o?.finishedAt) };
  } catch {
    return null;
  }
}

function saveTimes(matchId: string, times: MatchTimes<number>) {
  try {
    localStorage.setItem(TIME_PREFIX + matchId, JSON.stringify(times));
  } catch {
    // Même parti pris que `saveLog` : le chrono se perd au rechargement, le compte continue.
  }
}

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
    localStorage.removeItem(TIME_PREFIX + matchId);
    localStorage.removeItem(SENT_PREFIX + matchId);
    localStorage.removeItem(REV_PREFIX + matchId);
  } catch {
    /* sans importance */
  }
}

/** Révision confirmée, `"unsure"` si le dernier envoi est au sort inconnu, `null` si inconnue. */
function loadRev(matchId: string): number | "unsure" | null {
  try {
    const raw = localStorage.getItem(REV_PREFIX + matchId);
    if (raw === null) return null;
    if (raw === "?") return "unsure";
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

function saveRev(matchId: string, rev: number | "unsure" | null) {
  try {
    if (rev === null) localStorage.removeItem(REV_PREFIX + matchId);
    else localStorage.setItem(REV_PREFIX + matchId, rev === "unsure" ? "?" : String(rev));
  } catch {
    /* même parti pris que `saveLog` */
  }
}

type LiveState = { current: { home: number; away: number }; serving: Side | null; servingBox: Box | null };

/**
 * Empreinte d'un état de match, sous la forme exacte de ce que la synchro ENVOIE (jeux terminés
 * + jeu en cours) — donc comparable à ce que le serveur rend.
 *
 * On compare des ÉTATS et non des nombres d'événements : annuler un point déjà envoyé puis en
 * marquer un autre redonne la même longueur de journal avec un score différent, et un simple
 * compteur aurait déclaré « rien de neuf » un point qui n'est jamais parti.
 *
 * Un jeu en cours à 0-0 sans serveur désigné ne dit rien : il s'écrit `null`, comme l'absence
 * d'instantané côté serveur, pour que « rien » se compare égal à « rien ».
 */
function empreinte(games: readonly { home: number; away: number }[], live: LiveState | null): string {
  const vide = !live || (live.serving === null && live.current.home === 0 && live.current.away === 0);
  return JSON.stringify({
    games: games.map((g) => [g.home, g.away]),
    live: vide
      ? null
      : [live.current.home, live.current.away, live.serving ?? null, live.servingBox ?? null],
  });
}

/** Empreinte de l'état que DÉRIVE un journal (cf. `empreinte`). */
function empreinteJournal(events: readonly ScoreEvent[], bestOf: number): string {
  const st = replay(events, bestOf);
  return empreinte(
    st.games,
    st.status === "done" ? null : { current: st.current, serving: st.serving, servingBox: st.servingBox },
  );
}

function loadSent(matchId: string): string | null {
  try {
    return localStorage.getItem(SENT_PREFIX + matchId);
  } catch {
    return null;
  }
}

function saveSent(matchId: string, fp: string) {
  try {
    localStorage.setItem(SENT_PREFIX + matchId, fp);
  } catch {
    // Même parti pris que `saveLog`. Sans cette clé, la réouverture garde le journal local —
    // le comportement d'avant, prudent pour les points non envoyés.
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
  recoit = true,
}: {
  fixtureId: string;
  match: MatchInfo;
  bestOf: number;
  /** Notre équipe reçoit-elle ? Sinon, le joueur adverse s'affiche en premier (cf. `ScoreBoard`). */
  recoit?: boolean;
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
  const { remaining, startBreak, stopBreak } = useBreakTimer();
  // Le chrono, tenu comme le journal : état pour l'affichage, référence pour les appuis
  // rapprochés. Horloge de CE téléphone — il part au premier appui, réseau ou pas (cf.
  // `interclub-duree.ts` sur les deux horloges).
  const [times, setTimes] = useState<MatchTimes<number>>(NO_TIMES);
  const timesRef = useRef<MatchTimes<number>>(NO_TIMES);

  const state = replay(events, bestOf);
  const needed = winGamesFor(bestOf);

  // --- journal local ---------------------------------------------------------
  // Amorcé UNE SEULE FOIS par match. `match.games` est une référence de tableau reconstruite à
  // chaque rechargement du parent — donc à chaque retour au premier plan. Sans ce verrou,
  // l'amorçage se rejouait, et lorsque `localStorage` est indisponible (mode privé, quota) il
  // repartait des jeux connus du serveur : les points du jeu en cours étaient effacés, alors
  // que `saveLog` promet précisément de « continuer en mémoire ».
  const seededFor = useRef<string | null>(null);
  const ackRef = useRef<Ack | null>(null);
  const revRef = useRef<number | "unsure" | null>(null);
  useEffect(() => {
    if (seededFor.current === match.id) return;
    seededFor.current = match.id;
    const serverGames = match.games.map((g) => ({ home: g.home, away: g.away }));
    // QUEL JOURNAL FAIT FOI : celui de ce téléphone, seulement s'il a quelque chose à défendre.
    //
    // Le journal local gagnait TOUJOURS, et c'était une perte de données. Il est enregistré dès
    // l'amorçage — même vide — et n'est purgé que sur un match terminé confirmé. D'où ce
    // scénario, sans malveillance ni concurrence : A ouvre « Marquer » puis « Retour » (journal
    // `[]` conservé) ; B marque 6-4 au jeu 1 puis rend la main ; A rouvre → écran à 0-0, et son
    // premier envoi `{ games: [], knownGameCount: 0, live: 0-0 }` passait la garde serveur
    // (`staleGamesReason` ne compare que les jeux TERMINÉS) et remettait le simple à zéro.
    //
    // Deux règles, de la plus évidente à la plus fine :
    //   1. un journal VIDE ne défend rien — il vaut absence ;
    //   2. un journal dont l'état est exactement celui que le serveur a confirmé (`SENT_PREFIX`)
    //      ne défend rien non plus : s'il diffère de l'état actuel du serveur, c'est que le
    //      serveur a avancé sans lui, et le serveur fait foi. S'il est identique, on garde le
    //      local — même score, mais le VRAI déroulé, que `seedEvents` ne sait que réinventer
    //      (l'undo défait alors les points réellement joués).
    // Un journal porteur de points non envoyés — ou dont on ignore le sort : clé absente,
    // envoi au résultat inconnu — reste prioritaire, exactement comme avant : c'est lui qui
    // détient les cinq dernières secondes de jeu.
    //
    // La règle 2 dépend de ce que CE téléphone a noté, et un journal porteur de points non
    // envoyés l'emporte encore sur un serveur qui a avancé sans lui. C'est la RÉVISION
    // (`REV_PREFIX`, migration 63) qui ferme ce cas : annoncée au premier envoi, elle fait
    // refuser l'écrasement (`stale-live`) au lieu de le laisser passer.
    let local = loadLog(match.id);
    if (local && local.length === 0) local = null;
    if (local) {
      const envoye = loadSent(match.id);
      const ici = empreinteJournal(local, bestOf);
      if (envoye !== null && ici === envoye && ici !== empreinte(serverGames, match.live)) local = null;
    }
    // Pas de journal ici (ou plus rien à défendre) ? Le match a pu être entamé sur un autre
    // téléphone, sur un autre compte, ou saisi à la main. On repart de ce que le serveur
    // connaît : ses jeux terminés ET son jeu en cours (score fidèle, déroulé reconstitué,
    // service rétabli tel quel).
    //
    // `match.live` est la moitié qui manquait. Sans elle, reprendre un match entamé ailleurs
    // effaçait silencieusement le jeu en cours — la fiche affichait 7-7, le marquage 0-0.
    const seed = local ?? seedEvents(serverGames, bestOf, match.live);
    eventsRef.current = seed;
    setEvents(seed);
    // Les heures suivent le journal : les nôtres s'il vient d'ici, celles du serveur sinon — un
    // match entamé sur un autre téléphone reprend son chrono où il en était.
    const t = (local ? loadTimes(match.id) : null) ?? {
      startedAt: toMs(match.startedAt),
      finishedAt: toMs(match.finishedAt),
    };
    timesRef.current = t;
    setTimes(t);
    if (!local) {
      // Repartis du serveur, on le NOTE aussitôt — état connu, base confirmée, heures. Sans
      // cela, les clés d'un journal écarté survivaient : marquer un point puis fermer l'appli
      // avant tout envoi, et la réouverture relisait l'ancien `ic:ack:` — un compte que la base
      // a dépassé, donc un `stale-games` et la purge des points tout juste marqués.
      saveSent(match.id, empreinteJournal(seed, bestOf));
      saveAck(match.id, replay(seed, bestOf).games.length);
      saveTimes(match.id, t);
    }
    // Sur quel état du serveur ce journal est-il bâti ? Amorcé depuis le serveur, la réponse
    // est immédiate. Repris d'un journal local, elle a été notée au dernier envoi réussi ; à
    // défaut — journal d'avant cette clé, stockage vidé — on retient ce que le journal lui-même
    // a fait connaître, c'est-à-dire ses propres jeux terminés. Ce choix fait pencher le doute
    // du côté du SERVEUR, qui est la copie partagée.
    ackRef.current = (local ? loadAck(match.id) : null) ?? replay(seed, bestOf).games.length;
    // La révision suit la même règle : repartis du serveur, c'est la sienne ; repris d'un
    // journal local, c'est celle du dernier envoi réussi D'ICI — si un autre appareil a écrit
    // depuis, le premier envoi sera refusé (`stale-live`) au lieu d'écraser son travail.
    revRef.current = local ? loadRev(match.id) : (match.liveRev ?? null);
    if (!local) saveRev(match.id, revRef.current);
    setReady(true);
    // `match.live` figure ici comme `match.games` : le verrou `seededFor` empêche de toute
    // façon un second amorçage, et les lister honnêtement vaut mieux qu'une exception de lint
    // qui masquerait le jour où le verrou disparaîtrait. Même chose pour les heures.
  }, [match.id, match.games, match.live, match.startedAt, match.finishedAt, match.liveRev, bestOf]);

  useEffect(() => {
    if (ready) saveLog(match.id, events);
  }, [ready, match.id, events]);

  // --- l'écran reste allumé --------------------------------------------------
  //
  // TANT QUE CET ÉCRAN EST OUVERT, ET SEULEMENT LUI. Un téléphone posé au bord du court se
  // verrouille au bout de trente secondes : le marqueur le reprend, le déverrouille, retrouve
  // l'écran, tape le point — entre chaque échange. C'est ce geste-là qui fait abandonner le
  // marquage au milieu du deuxième jeu, et rien dans le code ne le montrait.
  //
  // Le verrou n'est JAMAIS une garantie (refusé, ignoré, relâché par le système) et rien ici
  // n'en dépend : cf. `wake-lock.ts`. C'est du confort, et son échec est silencieux.
  useEffect(() => keepAwake(), []);

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
            // Même règle pour la révision : on n'annonce que ce que le serveur a confirmé.
            rev: typeof revRef.current === "number" ? revRef.current : undefined,
            // `awaitingServeBox` n'est plus envoyé : le carré ne s'attend plus, il se propose
            // (cf. `interclub.ts`). Le serveur lit son absence comme `false`.
            live: st.status === "done" ? null : {
              current: st.current,
              serving: st.serving,
              servingBox: st.servingBox,
            },
          }),
        });
        if (onExpired(res.status)) {
          deadRef.current = true;
          return "expired";
        }
        if (res.status === 409) {
          setOffline(false);
          // Plusieurs refus partagent ce statut, et ils demandent des réactions opposées : d'où
          // le code renvoyé par le serveur, sur lequel on branche — jamais sur le message.
          const code = await res
            .json()
            .then((d) => (d as { code?: string } | null)?.code)
            .catch(() => undefined);
          if (code === "write_conflict") {
            // ⚠️ TROIS REFUS PARTAGENT CE STATUT, ET CELUI-CI N'ACCUSE PERSONNE. C'est la
            // transaction `Serializable` qui a épuisé ses quatre tentatives — deux écritures sur
            // la même rencontre, quelques dizaines de millisecondes de contention. Aucun tiers ne
            // marque ce match-là : dire « quelqu'un d'autre marque » envoyait chercher un marqueur
            // qui n'existe pas, et ne donnait aucune raison de retaper le point. `http-tx.ts` pose
            // ce code exactement pour ça — « sans discriminant, le client lit le second dans le
            // premier ». Le journal local est intact, l'état complet repartira au prochain envoi.
            toast("err", "Écriture simultanée — retape le point.");
            return "conflict";
          }
          if (code === "stale-games" || code === "stale-live") {
            // Le serveur a dépassé ce journal : quelqu'un a saisi un jeu pendant qu'on avait le
            // dos tourné. Le journal ne décrit plus rien — on le jette, et on ferme pour que le
            // parent recharge la rencontre. Rouvrir « Reprendre le marquage » repartira du
            // score enregistré, seule version que tout le monde partage.
            clearLog(match.id);
            ackRef.current = null;
            revRef.current = null;
            deadRef.current = true;
            toast("err", "Le score a changé ailleurs — rouvre le marquage pour repartir du score enregistré.");
            onClose();
            return "stale";
          }
          if (code === "match-done") {
            // Le match est TERMINÉ côté serveur, et ce n'est pas nous qui l'avons clos : son score
            // final est enregistré, et seule la correction a posteriori (`PATCH`) peut encore y
            // toucher. Ce refus était lu comme « quelqu'un d'autre marque » : le journal restait
            // alors À VIE, chaque réouverture renvoyait le même état et recevait le même refus.
            // Il ne décrit plus rien qu'on puisse envoyer — on le jette et on ferme, comme pour
            // `stale-games`.
            clearLog(match.id);
            ackRef.current = null;
            deadRef.current = true;
            toast("info", "Score déjà enregistré — ce match est terminé.");
            onClose();
            return "stale";
          }
          // Le refus de PRISE DE MARQUAGE : un autre appareil tient ce match (cf. `claim`).
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
          revRef.current = "unsure";
          saveRev(match.id, "unsure");
          return "offline";
        }
        // Le serveur a pris ce corps : c'est désormais l'état sur lequel le journal est bâti.
        ackRef.current = st.games.length;
        saveAck(match.id, st.games.length);
        // La révision qu'il vient de poser. Un serveur qui ne la rend pas (déploiement
        // antérieur) laisse la révision inconnue : on n'annoncera rien.
        const rendu = await res
          .json()
          .then((d) => (d as { rev?: unknown } | null)?.rev)
          .catch(() => undefined);
        revRef.current = Number.isInteger(rendu) ? (rendu as number) : null;
        saveRev(match.id, revRef.current);
        // Et l'ÉTAT ainsi confirmé : c'est ce qui dira, à la réouverture, si le journal porte
        // encore quelque chose que le serveur n'a pas (cf. `SENT_PREFIX` et l'amorçage).
        saveSent(
          match.id,
          empreinte(
            st.games,
            st.status === "done" ? null : { current: st.current, serving: st.serving, servingBox: st.servingBox },
          ),
        );
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
        revRef.current = "unsure";
        saveRev(match.id, "unsure");
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

  // --- actions ---------------------------------------------------------------
  function commit(build: (prev: ScoreEvent[]) => ScoreEvent[]) {
    const prev = eventsRef.current;
    const next = build(prev);
    const before = replay(prev, bestOf);
    const after = replay(next, bestOf);
    eventsRef.current = next;
    setEvents(next);

    const nextTimes = liveMatchTimes(
      { status: matchPhase(before), ...timesRef.current },
      { status: matchPhase(after), games: after.games.length },
      Date.now(),
    );
    timesRef.current = nextTimes;
    setTimes(nextTimes);
    saveTimes(match.id, nextTimes);

    const gameEnded = after.games.length > before.games.length;
    const finished = after.status === "done";

    hapticFor(before, after);

    if (gameEnded && !finished) startBreak();
    scheduleSync(next);
  }

  // Cf. `ScoreBoard` : sans premier serveur désigné, un point n'a pas de sens.
  const attendServeur = state.serving === null;

  const scorePoint = (side: Side) => {
    if (attendServeur || state.status === "done" || remaining > 0) return;
    commit((prev) => applyPoint(prev, bestOf, side));
  };

  const toggleBox = () => commit((prev) => toggleServeBox(prev, bestOf));

  const chooseFirstServer = (side: Side) => commit((prev) => startServe(prev, bestOf, side));

  const doUndo = () => {
    stopBreak();
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

  return (
    <ScoreBoard
      state={state}
      bestOf={bestOf}
      homeName={match.homeDisplayName}
      awayName={match.awayName}
      homeColor={match.homeColor}
      awayColor={match.awayColor}
      first={recoit ? "home" : "away"}
      metaTitle={`Match numéro ${match.order}, ${needed} jeux gagnants`}
      meta={
        <>
          Match #{match.order} · {needed} jeux gagnants
          {offline && (
            <span className="ics-offline" title="Les points sont gardés sur cet appareil">
              hors-ligne
            </span>
          )}
        </>
      }
      canUndo={events.length > 0}
      remaining={remaining}
      onPoint={scorePoint}
      onFirstServe={chooseFirstServer}
      onToggleBox={toggleBox}
      onUndo={doUndo}
      onSkipBreak={stopBreak}
      onBack={() => void finish()}
      onFinish={() => void finish()}
      clock={<MatchClock times={times} />}
    />
  );
}
