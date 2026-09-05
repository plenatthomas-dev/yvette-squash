// Notifications du suivi interclub.
//
// LE VRAI SUJET EST LE DOSAGE, pas la technique. Une notification par échange, c'est ~200 par
// match et ~800 par soirée : personne ne garde ça activé plus d'une semaine, et une fonction
// qu'on désactive ne sert plus jamais. D'où trois paliers d'abonnement, aucun par défaut, et
// un `tag` unique par rencontre pour que l'écran verrouillé n'accumule jamais plus d'une ligne.

import { prisma } from "./db";
import { pushToUsers } from "./push";
import { FOLLOW_LEVELS, notifiesAt, type FollowLevel } from "./interclub";

/**
 * Les abonnés d'une équipe dont le niveau couvre `want`.
 *
 * Le filtre se fait EN BASE sur les niveaux concernés plutôt qu'en mémoire : c'est l'index
 * ([teamId, level]) qui porte cette requête, et c'est la raison d'être de la table.
 */
async function followersFor(teamId: string, want: FollowLevel): Promise<string[]> {
  // On s'appuie sur `notifiesAt`, la définition unique du recouvrement des paliers. La
  // recalculer ici en dupliquait la logique : une réorganisation de FOLLOW_LEVELS aurait
  // silencieusement désaccordé les deux, et seule l'autre version est testée directement.
  const covering = FOLLOW_LEVELS.filter((l) => notifiesAt(l, want));
  const rows = await prisma.interclubFollow.findMany({
    where: { teamId, level: { in: [...covering] } },
    select: { userId: true },
  });
  return rows.map((r) => r.userId);
}

interface Ctx {
  fixtureId: string;
  teamId: string;
  teamName: string;
  opponent: string;
}

/**
 * Longueurs maximales, alignées sur ce que `recordNotifications` écrit au journal (120 / 500)
 * et sur l'annonce admin. Au-delà, les systèmes tronquent eux-mêmes, et souvent au milieu d'un
 * nom — mieux vaut couper nous-mêmes, proprement.
 */
const MAX_TITLE = 120;
const MAX_BODY = 300;

/**
 * Envoi best-effort : une notification perdue ne doit jamais faire échouer la saisie d'un
 * score. `pushToUsers` ne jette pas, on ajoute une ceinture au cas où la requête, elle, jette.
 *
 * ⚠️ La TRONCATURE se fait ICI, et nulle part ailleurs. Deux des quatre notifications la
 * posaient à l'appel et les deux autres l'oubliaient, sans que rien ne distingue les deux cas ;
 * le titre, lui, n'était borné nulle part alors qu'il compose un nom d'équipe et un nom de club
 * adverse (jusqu'à `MAX_OPPONENT_LEN`). Une seule porte de sortie, un seul endroit à tenir, et
 * la prochaine notification en hérite sans y penser.
 */
async function send(ctx: Ctx, want: FollowLevel, title: string, body: string): Promise<void> {
  title = title.slice(0, MAX_TITLE);
  body = body.slice(0, MAX_BODY);
  try {
    const ids = await followersFor(ctx.teamId, want);
    if (ids.length === 0) return;
    await pushToUsers(ids, {
      title,
      body,
      url: "/?view=interclub",
      // Un tag par RENCONTRE : la nouvelle notification remplace la précédente au lieu
      // d'empiler la soirée entière sur l'écran verrouillé. Deux rencontres le même soir
      // (équipe 1 et équipe 2) ont donc deux tags, donc deux lignes distinctes.
      tag: `interclub-${ctx.fixtureId}`,
      // …mais on veut être ENTENDU à chaque fois : sans ceci, le remplacement serait
      // silencieux et seul le premier événement de la soirée alerterait.
      renotify: true,
    });
  } catch {
    /* best-effort */
  }
}

/** Un jeu vient de se terminer — niveau « détaillé » seulement. */
export function notifyGameDone(
  ctx: Ctx,
  player: string,
  opponentName: string,
  games: { home: number; away: number }[],
): Promise<void> {
  const last = games[games.length - 1];
  const won = games.reduce(
    (acc, g) => ({
      home: acc.home + (g.home > g.away ? 1 : 0),
      away: acc.away + (g.away > g.home ? 1 : 0),
    }),
    { home: 0, away: 0 },
  );
  return send(
    ctx,
    "detailed",
    `${ctx.teamName} – ${ctx.opponent}`,
    `${player} c. ${opponentName} : ${last.home}-${last.away} (${won.home}-${won.away} en jeux)`,
  );
}

/** Un match est gagné — niveau « temps forts ». */
export function notifyMatchDone(
  ctx: Ctx,
  player: string,
  opponentName: string,
  gamesHome: number,
  gamesAway: number,
  fixtureScore: { home: number; away: number },
): Promise<void> {
  const verdict = gamesHome > gamesAway ? "gagne" : "perd";
  return send(
    ctx,
    "highlights",
    `${ctx.teamName} – ${ctx.opponent}`,
    `${player} ${verdict} ${gamesHome}-${gamesAway} contre ${opponentName}. Rencontre : ${fixtureScore.home}-${fixtureScore.away}.`,
  );
}

/** Un simple, tel qu'on le résume dans la notification de fin de rencontre. */
export interface MatchLine {
  player: string;
  gamesHome: number | null;
  gamesAway: number | null;
}


/** « Tom 3-0, Marc 1-3 » — les matchs sans résultat sont passés sous silence. */
function summarize(lines: readonly MatchLine[]): string {
  return lines
    .filter((l) => l.gamesHome !== null && l.gamesAway !== null)
    .map((l) => `${l.player} ${l.gamesHome}-${l.gamesAway}`)
    .join(", ");
}

/**
 * La rencontre est terminée — tous les niveaux, y compris « résultat seul ».
 *
 * C'est LA notification que reçoivent ceux qui n'en veulent qu'une par soirée : elle doit donc
 * se suffire à elle-même, d'où le détail par joueur et pas seulement le score global.
 */
export function notifyFixtureDone(
  ctx: Ctx,
  score: { home: number; away: number },
  lines: readonly MatchLine[] = [],
): Promise<void> {
  const verdict =
    score.home > score.away ? "l'emporte" : score.home < score.away ? "s'incline" : "fait match nul";
  const detail = summarize(lines);
  const body = `${ctx.teamName} ${verdict} ${score.home}-${score.away}${detail ? ` · ${detail}` : ""}`;
  return send(ctx, "result", `${ctx.teamName} – ${ctx.opponent}`, body);
}

/**
 * Le premier point vient d'être marqué — niveau « temps forts ». On nomme le match qui
 * démarre : « la rencontre commence » tout court n'apprend rien qu'on ne sache déjà en
 * s'étant abonné.
 */
export function notifyFixtureStart(ctx: Ctx, player?: string, opponentName?: string): Promise<void> {
  const who = player && opponentName ? ` ${player} c. ${opponentName} entre sur le court.` : "";
  return send(
    ctx,
    "highlights",
    `${ctx.teamName} – ${ctx.opponent}`,
    `La rencontre commence.${who}`,
  );
}

// ============================================================================
//  CALENDRIER ET DISPONIBILITÉS — un autre public, donc un autre envoi.
//
//  ⚠️ TROIS POPULATIONS À NE PAS CONFONDRE, et c'est la seule chose difficile
//  de ce fichier :
//
//   * les ABONNÉS (`InterclubFollow`) suivent le SCORE. N'importe qui peut
//     s'abonner à n'importe quelle équipe : ce sont des spectateurs. Tout ce
//     qui précède dans ce fichier s'adresse à eux.
//   * l'ÉQUIPE (`User.teamId`) est convoquée. On lui demande si elle est
//     disponible, on la prévient quand la date bouge. Envoyer cela aux
//     abonnés convoquerait des spectateurs ; l'envoyer aux seuls abonnés
//     laisserait sans nouvelle un joueur qui ne suit pas les scores.
//   * le CAPITAINE reçoit ce que personne d'autre n'a à recevoir : l'état des
//     réponses, l'alerte « il manque du monde », les dérives de calendrier.
//     Diffusé à toute l'équipe, cela deviendrait un bruit que chacun ignore,
//     et le seul qui doit agir n'agirait pas.
//
//  D'où `sendTo`, jumeau de `send` mais sur une liste de destinataires DONNÉE
//  plutôt que déduite des abonnements. Même troncature, même `tag`, même
//  best-effort : ce qui change est le carnet d'adresses, pas la mécanique.
// ============================================================================

/** Envoi direct à des destinataires nommés (équipe, capitaine), hors abonnements. */
async function sendTo(
  userIds: string[],
  ctx: Ctx,
  title: string,
  body: string,
  /**
   * Suffixe de `tag`, pour les envois qui ne doivent PAS se remplacer entre eux.
   *
   * Un tag par rencontre est le bon défaut : le soir du match, dix notifications ne doivent
   * laisser qu'une ligne sur l'écran verrouillé. Mais à J-3 la relance et le récapitulatif
   * partent le même jour, et le capitaine — qui est aussi un joueur, donc relançable — ne
   * voyait que le dernier des deux. Ce sont deux messages différents pour deux gestes
   * différents ; ils cohabitent.
   */
  tagSuffix = "",
): Promise<void> {
  if (userIds.length === 0) return;
  try {
    await pushToUsers(userIds, {
      title: title.slice(0, MAX_TITLE),
      body: body.slice(0, MAX_BODY),
      url: "/?view=interclub",
      tag: `interclub-${ctx.fixtureId}${tagSuffix}`,
      renotify: true,
    });
  } catch {
    /* best-effort : une notification perdue ne doit rien faire échouer */
  }
}

/** Les membres rattachés à l'équipe — ceux qu'on peut aligner, donc ceux qu'on convoque. */
export async function teamMemberIds(teamId: string): Promise<string[]> {
  const rows = await prisma.user.findMany({
    // `disabledAt` exclu : un compte désactivé ne joue plus, et le relancer chaque semaine
    // serait le seul signe de vie que l'appli lui donnerait encore.
    where: { teamId, disabledAt: null },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * Date lisible : « jeudi 9 octobre ». L'année est tue — une rencontre annoncée se joue dans les
 * semaines qui viennent, et « 2026 » n'apprend rien à personne dans une notification courte.
 *
 * Une date HORS BORNES ressort telle quelle, comme une date illisible. `Date.UTC` déborde
 * volontiers — « 2026-13-45 » devenait « samedi 14 février », une date parfaitement crédible et
 * fausse de six semaines, dans un message qui convoque une équipe. Mieux vaut afficher
 * « 2026-13-45 », qu'on ne peut pas prendre pour un rendez-vous.
 */
export function frenchDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  if (m > 12 || d > 31) return iso;
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Le débordement de jour se voit après coup : le 31 février devient le 3 mars.
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return iso;
  return dt.toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

/** Un lieu en une ligne : « à domicile » / « chez X », plus l'heure si on la connaît. */
function whereWhen(home: boolean, opponent: string, time: string | null): string {
  const lieu = home ? "à domicile" : `chez ${opponent}`;
  return time ? `${lieu} à ${time}` : lieu;
}

/**
 * « Dis si tu es dispo » — à TOUTE L'ÉQUIPE, une fois par rencontre.
 *
 * Cette notification est la seule raison pour laquelle le reste existe : sans elle, personne
 * ne va spontanément ouvrir un écran pour déclarer une disponibilité qu'on ne lui a pas
 * demandée.
 */
export async function notifyAvailabilityCall(
  ctx: Ctx,
  fixture: { date: string; time: string | null; home: boolean },
): Promise<void> {
  const ids = await teamMemberIds(ctx.teamId);
  await sendTo(
    ids,
    ctx,
    `${ctx.teamName} – ${ctx.opponent}`,
    `Rencontre le ${frenchDate(fixture.date)} ${whereWhen(fixture.home, ctx.opponent, fixture.time)}. Dis si tu es disponible.`,
  );
}

/**
 * Relance — aux SEULS non-répondants.
 *
 * Relancer tout le monde punirait ceux qui ont répondu vite, qui sont exactement ceux qu'on
 * veut garder. La liste est donc calculée par l'appelant, qui sait qui a répondu.
 */
export async function notifyAvailabilityReminder(
  ids: string[],
  ctx: Ctx,
  fixture: { date: string },
): Promise<void> {
  await sendTo(
    ids,
    ctx,
    `${ctx.teamName} – ${ctx.opponent}`,
    `Rencontre le ${frenchDate(fixture.date)} : tu n'as pas encore dit si tu étais disponible.`,
  );
}

/** La rencontre a été déplacée — à toute l'équipe, y compris ceux qui avaient déjà répondu. */
export async function notifyFixtureMoved(
  ctx: Ctx,
  from: string,
  to: { date: string; time: string | null },
): Promise<void> {
  const ids = await teamMemberIds(ctx.teamId);
  await sendTo(
    ids,
    ctx,
    `${ctx.teamName} – ${ctx.opponent}`,
    // On répète l'ancienne date : « déplacée au 16 » ne dit pas laquelle des trois rencontres
    // à venir a bougé, et c'est justement ce que le lecteur cherche.
    `Déplacée du ${frenchDate(from)} au ${frenchDate(to.date)}${to.time ? ` à ${to.time}` : ""}. Ta réponse est à redonner.`,
  );
}

/**
 * Récapitulatif au CAPITAINE, à l'approche de la rencontre.
 *
 * Deux informations qu'il est le seul à devoir traiter : combien de joueurs fermes il a, et
 * QUI il doit appeler parce qu'aucune relance ne l'atteindra (joueurs sans compte, membres sans
 * notifications). Sans cette seconde liste, il relance en aveugle des gens qui ne verront rien.
 */
export async function notifyCaptainDigest(
  captainId: string,
  ctx: Ctx,
  fixture: { date: string; matchCount: number },
  counts: { yes: number; maybe: number; no: number },
  toCall: string[],
): Promise<void> {
  const manque = counts.yes < fixture.matchCount;
  const tete = manque
    ? `⚠️ ${counts.yes}/${fixture.matchCount} dispo pour le ${frenchDate(fixture.date)}`
    : `${counts.yes} dispo pour le ${frenchDate(fixture.date)}`;
  const detail = `${counts.maybe} incertain(s), ${counts.no} absent(s).`;
  const appels = toCall.length ? ` À appeler : ${toCall.join(", ")}.` : "";
  await sendTo(
    [captainId],
    ctx,
    `${ctx.teamName} – ${ctx.opponent}`,
    `${tete}. ${detail}${appels}`,
    "-recap",
  );
}

/**
 * Le calendrier fédéral a bougé — au capitaine et aux admins.
 *
 * On NE MODIFIE RIEN ici : on prévient, et l'écart s'applique d'un geste dans l'espace admin.
 * Un scraping qui casse ne doit pas pouvoir déplacer une convocation tout seul.
 */
export async function notifyCalendarDrift(
  userIds: string[],
  team: { id: string; name: string },
  changes: string[],
): Promise<void> {
  const teamName = team.name;
  if (userIds.length === 0) return;
  const head = changes.slice(0, 3).join(" · ");
  const rest = changes.length > 3 ? ` (+${changes.length - 3})` : "";
  try {
    await pushToUsers(userIds, {
      title: `${teamName} : le calendrier a changé`.slice(0, MAX_TITLE),
      body: `${head}${rest}. À vérifier dans l'espace admin avant d'appliquer.`.slice(0, MAX_BODY),
      url: "/admin",
      // Un tag par ÉQUIPE et non par rencontre : la dérive porte sur le calendrier entier,
      // et deux alertes successives doivent se remplacer l'une l'autre.
      //
      // Bâti sur l'IDENTIFIANT, comme tous les autres tags de ce fichier. Sur le NOM, renommer
      // « Équipe 2 » en « Équipe B » faisait cohabiter deux alertes pour la même équipe — et
      // deux équipes homonymes n'auraient jamais pu se remplacer l'une l'autre.
      tag: `interclub-calendrier-${team.id}`,
      renotify: true,
    });
  } catch {
    /* best-effort */
  }
}
