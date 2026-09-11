import { prisma } from "./db";
import { loadRosters, refreshRosters } from "./interclub-roster-db";
import { fetchTieSheet, TieUnreadableError, type TieSheet } from "./squashnet/tie";

// ============================================================================
//  LA FEUILLE DE MATCH OFFICIELLE, CÔTÉ BASE : comment on l'atteint.
//
//  Le pendant IMPUR de `squashnet/tie.ts` (le parsing) et de
//  `captain-official.ts` (la confrontation). Même découpage que pour les
//  rosters — `squashnet/roster.ts`, `interclub-roster-db.ts`,
//  `interclub-opponents.ts` — et pour la même raison : la règle affichée à
//  l'écran doit être exactement celle qu'on applique, donc elle se teste sans
//  base ni réseau.
//
//  LE PROBLÈME QUE CE MODULE RÉSOUT, ET IL N'EST PAS ÉVIDENT. Pour lire la
//  feuille d'une rencontre, il faut son `tieid`. Or il n'est PAS dans le
//  calendrier de l'épreuve, d'où viennent pourtant toutes nos rencontres
//  importées : il n'existe que sur la FICHE DE NOTRE ÉQUIPE (`ic_a=393480`),
//  ligne par ligne. Atteindre une feuille de match commence donc par aller lire
//  la fiche de sa propre équipe — et cette fiche, on la range dans le cache qui
//  sert déjà aux rosters adverses, puisque c'en est un.
// ============================================================================

/** Ce qu'une passe de rapprochement a fait, de quoi le dire sans le deviner. */
export interface TieIdOutcome {
  /**
   * `posed`      — au moins un identifiant a été posé ;
   * `complete`   — rien de plus à poser. ⚠️ Ne veut PAS dire « toutes les rencontres en ont
   *                un » : une rencontre saisie à la main, ou dont la date ne désigne aucune
   *                rencontre fédérale, n'en aura jamais. C'est `missing` qui le dit ;
   * `noTeamId`   — l'équipe n'est pas ancrée sur squashnet (`snTeamId` absent) ;
   * `unread`     — la fiche d'équipe n'a pas pu être lue.
   *
   * `noTeamId` et `unread` ne se confondent pas : le premier est un défaut de CONFIGURATION
   * (Admin › Interclub), le second une panne passagère. Les afficher pareil enverrait
   * réessayer indéfiniment une lecture qui n'a pas de cible.
   */
  status: "posed" | "complete" | "noTeamId" | "unread";
  /** Combien d'identifiants ont été posés. */
  posed: number;
  /** Combien de rencontres restent sans identifiant après la passe. */
  missing: number;
}

/**
 * Pose le `tieid` fédéral sur les rencontres d'une équipe qui n'en portent pas.
 *
 * UNE SEULE REQUÊTE FÉDÉRALE POUR TOUTE LA SAISON, et encore : `refreshRosters` ne sort que si
 * la fiche manque ou date de plus d'une semaine. Le calendrier d'une équipe ne bouge pas d'un
 * jour à l'autre.
 *
 * ⚠️ LE RAPPROCHEMENT SE FAIT SUR LA DATE, ET SEULEMENT SI ELLE EST SANS AMBIGUÏTÉ. Ni le tour
 * ni l'adversaire ne peuvent servir de clé : une équipe joue deux phases renumérotées chacune
 * depuis 1 (deux « Tour 1 » à huit mois d'écart), les tours ne suivent pas l'ordre des dates, et
 * le même adversaire revient à l'aller et au retour. La date, elle, distingue chaque rencontre
 * réelle — ses seules collisions sur la fiche de référence sont les journées d'EXEMPTION, qui ne
 * se jouent pas. D'où la garde : deux rencontres fédérales le même jour, on ne pose rien. Poser
 * l'un des deux au hasard ferait confronter notre relevé à la feuille d'une autre rencontre, et
 * tous les écarts affichés seraient faux.
 *
 * NE REMPLACE JAMAIS UN IDENTIFIANT DÉJÀ POSÉ, sauf `force`. Un report de rencontre déplace la
 * date des DEUX côtés (la ligue republie son calendrier, notre import le recopie) : l'ancien
 * rapprochement reste donc valable, et le refaire à chaque passe ne ferait que le réexposer à
 * l'ambiguïté qu'on vient d'écarter.
 */
export async function refreshOwnTieIds(
  teamId: string,
  opts: { force?: boolean } = {},
): Promise<TieIdOutcome> {
  const equipe = await prisma.interclubTeam.findUnique({
    where: { id: teamId },
    select: { snTeamId: true },
  });
  if (!equipe?.snTeamId) return { status: "noTeamId", posed: 0, missing: 0 };
  const snTeamId = equipe.snTeamId;

  const rencontres = await prisma.interclub.findMany({
    where: { teamId },
    select: { id: true, date: true, snTieId: true },
  });
  const aFaire = opts.force ? rencontres : rencontres.filter((r) => !r.snTieId);
  if (aFaire.length === 0) {
    return { status: "complete", posed: 0, missing: 0 };
  }

  // LA FICHE DE NOTRE PROPRE ÉQUIPE, rangée dans le cache des rosters — c'en est un. Elle
  // apporte deux choses d'un coup : le `tieid` de chaque rencontre, et NOTRE SIGLE, qui est ce
  // qui permettra de reconnaître notre côté sur la feuille de match.
  try {
    await refreshRosters([snTeamId]);
  } catch {
    // Best-effort : une fiche déjà en cache reste exploitable. L'échec se verra au `status`.
  }
  const roster = (await loadRosters([snTeamId])).get(snTeamId);
  if (!roster || roster.ties.length === 0) {
    return { status: "unread", posed: 0, missing: aFaire.length };
  }

  // Les dates fédérales qui ne désignent qu'UNE rencontre. Les autres sont écartées ici, une
  // fois pour toutes, plutôt qu'au cas par cas dans la boucle.
  const parDate = new Map<string, string | null>();
  for (const t of roster.ties) {
    if (!t.date) continue;
    // Déjà vue = ambiguë. On marque `null` plutôt que de supprimer : une troisième occurrence
    // ne doit pas la faire réapparaître.
    parDate.set(t.date, parDate.has(t.date) ? null : t.snTieId);
  }

  let posed = 0;
  for (const r of aFaire) {
    const tieId = parDate.get(r.date) ?? null;
    if (!tieId || tieId === r.snTieId) continue;
    await prisma.interclub.update({ where: { id: r.id }, data: { snTieId: tieId } });
    posed += 1;
  }

  const missing = aFaire.filter((r) => !(parDate.get(r.date) ?? r.snTieId)).length;
  return { status: posed > 0 ? "posed" : "complete", posed, missing };
}

/** Ce que la lecture d'une feuille a donné — la feuille, ou la raison de son absence. */
export interface SheetRead {
  sheet: TieSheet | null;
  /**
   * `unreadable` = la ligue a répondu autre chose que ce qu'on sait lire (recapter une fixture),
   * `failed` = elle n'a pas répondu (réessayer). La distinction est celle de `RosterOutcome`, et
   * elle vaut ici pour la même raison : les confondre envoie chercher un bug qui n'existe pas.
   */
  error: "unreadable" | "failed" | null;
}

/**
 * Télécharge la feuille de match d'une rencontre, sans jamais jeter.
 *
 * L'écran capitaine doit s'afficher même quand squashnet est muet : le reste du rapport (nos
 * scores, nos joueurs, l'ordre des simples) ne dépend pas de la ligue, et le priver de tout
 * parce qu'une lecture d'appoint a échoué serait un mauvais échange.
 */
export async function readTieSheet(snTieId: string): Promise<SheetRead> {
  try {
    return { sheet: await fetchTieSheet(snTieId), error: null };
  } catch (e) {
    return { sheet: null, error: e instanceof TieUnreadableError ? "unreadable" : "failed" };
  }
}

/**
 * Le sigle fédéral d'une équipe, si sa fiche est en cache. Null sinon — jamais deviné.
 *
 * C'est le premier témoin de `ourSide` : il vient de la ligue elle-même et ne souffre aucune
 * ambiguïté, là où les noms alignés peuvent se ressembler d'une équipe à l'autre d'un même club.
 */
export async function teamCode(snTeamId: string | null): Promise<string | null> {
  if (!snTeamId) return null;
  const row = await prisma.squashnetTeamRoster.findUnique({
    where: { snTeamId },
    select: { code: true },
  });
  return row?.code ?? null;
}
