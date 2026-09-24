// Erreur métier portant un code HTTP, et transaction Serializable avec réessai.
//
// POURQUOI CE MODULE EXISTE
// Cinq routes écrivaient exactement le même préambule : une classe `HttpError` locale, un
// prédicat `isSerializationConflict` local, et une boucle `for (let attempt = 0; ; attempt++)`
// recopiée à l'identique. Cinq copies d'une même mécanique, c'est cinq occasions de diverger
// sur le nombre d'essais, sur le code de sortie, ou d'oublier la boucle sur une route future —
// oubli SILENCIEUX, puisqu'un conflit de sérialisation est rare et ne se voit qu'en charge.
//
// CE QUE LA BOUCLE RÉSOUT, ET POURQUOI ELLE N'EST PAS FACULTATIVE
// En isolation Serializable, Postgres ne fait pas patienter les transactions concurrentes : il
// en laisse une aboutir et ANNULE l'autre (SQLSTATE 40001, que Prisma remonte en P2034). Ce
// n'est pas une erreur d'application, c'est le mode de fonctionnement normal du niveau
// d'isolation — la transaction annulée doit être REJOUÉE sur un état à jour. Sans réessai, deux
// marqueurs qui touchent la même rencontre au même instant se renvoient une erreur alors que
// rien n'est en faute.
//
// ⚠️ Le corps de la transaction est donc REJOUÉ TEL QUEL : il doit pouvoir tourner deux fois
// sans effet cumulatif. Concrètement, aucun effet de bord hors base ne doit s'y trouver — pas
// d'envoi de notification, pas d'appel réseau. Les routes qui notifient collectent ce qu'il
// faut annoncer dans une variable, remise à zéro EN ENTRÉE de la transaction, et n'envoient
// qu'après le commit.

import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { prisma } from "./db";

/**
 * Erreur métier levée DANS une transaction : elle annule tout (rollback), puis se retraduit en
 * réponse HTTP une fois dehors. C'est ce qui permet d'écrire un refus au milieu du code qui
 * lit, sans laisser une écriture partielle derrière soi.
 */
export class HttpError extends Error {
  /**
   * @param code Étiquette FACULTATIVE, lisible par le client, quand deux refus partagent un
   *   même statut et appellent deux réactions différentes. Le message reste destiné à l'œil
   *   humain ; c'est sur ce code, jamais sur le texte, qu'un client doit brancher. Sans lui, le
   *   marqueur ne saurait pas distinguer « quelqu'un d'autre marque » (on renonce) de « ton
   *   journal est périmé » (on repart du serveur) — deux 409 sur la même route.
   */
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Nombre total de tentatives. Six, c'est-à-dire cinq réessais.
 *
 * ⚠️ C'ÉTAIT QUATRE, ET C'ÉTAIT MESURABLEMENT TROP PEU. Le raisonnement d'origine — « au-delà,
 * l'écriture n'est plus en conflit ponctuel mais en contention durable » — reste juste. Ce qu'il
 * ratait, c'est que quatre tentatives à recul LINÉAIRE ne laissent que 120 ms cumulées au pire
 * pour se désynchroniser, alors que la transaction qu'on rejoue dure elle-même plus que ça (lire
 * un tricount, ses dépenses et toutes leurs parts). Deux écrivains se rattrapaient donc à chaque
 * tour et s'épuisaient ensemble — le 409 partait sans qu'aucun des deux ne soit en faute.
 *
 * MESURÉ le 2026-09-24, six exécutions de `npm run test:pg` sur Postgres local : un échec, sur
 * `tricount-refunds.pg.test.ts` — deux remboursements partiels simultanés reçoivent un 409 au
 * lieu d'aboutir. La CI documentait le même mode de panne sur `tricount-approve.pg.test.ts`,
 * « environ une fois sur trois ». Ce n'est donc pas un défaut d'une route, mais de cette boucle.
 *
 * Ce n'est pas le nombre seul qui corrige, c'est son couple avec le recul EXPONENTIEL de
 * `backoffFor` : six tentatives à recul linéaire n'auraient ajouté que 90 ms.
 */
const MAX_ATTEMPTS = 6;

/**
 * Le code du 409 rendu quand les tentatives s'épuisent — « réessaie », et rien d'autre.
 *
 * Ce module explique depuis toujours pourquoi `HttpError` porte un `code` : « le marqueur ne
 * saurait pas distinguer "quelqu'un d'autre marque" de "ton journal est périmé" — deux 409 sur
 * la même route ». La contention n'en portait pourtant aucun, et c'est justement le 409 qu'un
 * client rencontre sur une route qui en rend un AUTRE, plus riche : sans discriminant, il lit
 * le second dans le premier et va chercher un champ qui n'existe pas.
 */
export const WRITE_CONFLICT = "write_conflict";

/** P2034 = conflit d'écriture / échec de sérialisation, le cas qu'on rejoue. */
function isSerializationConflict(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2034";
}

/**
 * P2002 = violation d'unicité. « Quelqu'un l'a déjà écrit », et non « c'est cassé ».
 *
 * Exportée pour les écritures IDEMPOTENTES par nature — celles qu'on peut rejouer parce que le
 * second passage n'a plus rien à faire. Deux clics sur « Appliquer » ne sont pas une faute de
 * l'admin : c'est un bouton qui a mis deux secondes à répondre.
 *
 * ⚠️ À ne pas confondre avec un rattrapage général : avaler un P2002 là où l'unicité EXPRIME une
 * règle métier (« une seule réponse par personne ») masquerait le conflit au lieu de le régler.
 */
export function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}
/**
 * P2025 = « l'enregistrement visé n'existe pas / plus ». Un `delete` ou un `update` qui ne
 * trouve plus sa cible.
 *
 * Le pendant de `isUniqueViolation` pour l'autre moitié d'une BASCULE : re-cliquer sur
 * « supprimer » ne doit pas rendre un 500 parce que le premier clic avait déjà abouti. Le geste
 * a le résultat demandé — la ligne n'est plus là — donc c'est un succès, pas une faute.
 *
 * ⚠️ Même réserve que pour P2002 : à n'avaler que là où l'ABSENCE est le résultat voulu. Sur une
 * route qui doit affirmer que la cible existait (un droit, un paiement), le confondre avec un
 * succès masquerait un 404 légitime.
 */
export function isMissingRecord(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025";
}

/**
 * P2003 = violation de clé étrangère. La ligne référencée a disparu entre la vérification et
 * l'écriture.
 *
 * Exportée pour les écritures qui ont un REPLI : citer un message que quelqu'un supprime au même
 * instant ne doit pas faire perdre la réponse — on la réécrit sans citation. Là où il n'y a pas
 * de repli, laisser remonter : un 500 sur une référence cassée est le bon signal.
 */
export function isForeignKeyViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2003";
}

/**
 * Recul entre deux tentatives : EXPONENTIEL, et TIRÉ AU SORT sur toute sa largeur.
 *
 * Le raisonnement qui justifie le nombre de tentatives — « au-delà, l'écriture n'est plus en
 * conflit ponctuel mais en contention durable » — suppose implicitement que du TEMPS passe entre
 * les essais. La boucle n'en laissait passer aucun : quatre tentatives pouvaient s'épuiser en
 * quelques millisecondes et rendre un 409 là où vingt millisecondes auraient suffi.
 *
 * Le tirage au sort compte autant que le recul lui-même : deux marqueurs qui entrent en conflit
 * rejouent sinon en cadence, et se retrouvent au même instant à chaque tour.
 *
 * ⚠️ LA CROISSANCE ÉTAIT LINÉAIRE, ET C'EST CE QUI RENDAIT LE 409. `20 × n` ms plafonne à
 * 120 ms cumulées sur quatre tentatives — moins que la durée de la transaction qu'on cherche
 * justement à ne plus chevaucher. Le doublement corrige à l'endroit exact du défaut : il ne
 * coûte rien quand le conflit se résout tôt (les deux premiers reculs sont inchangés), et il
 * n'ouvre l'écart que là où la contention dure.
 *
 * BORNES EXACTES, parce qu'une borne approximative ne sert à rien : l'attente précédant la
 * tentative n vaut au plus `10 × 2ⁿ` ms, soit 20, 40, 80, 160 puis 320 ms avant la sixième et
 * dernière — 620 ms cumulées au pire, contre 120 auparavant. En moyenne la moitié, le tirage
 * étant uniforme sur toute la largeur.
 *
 * 620 ms au pire est un plafond ASSUMÉ, et il ne se paie que sur cinq conflits d'affilée. En
 * face, un 409 demande à l'utilisateur de recliquer : plus long, et à sa charge.
 */
const BACKOFF_MS = 10;

/**
 * Temps accordé pour OBTENIR une connexion, avant même le premier ordre SQL.
 *
 * Le défaut de Prisma est de 2 s — mesuré à 2005 ms, cf. `http-tx.pg.test.ts` cas B3. Ce
 * plafond-là ne court pas sur le travail de la transaction : il court AVANT, sur l'ouverture de
 * la connexion. Or `interclub-gate.ts` décrit le réveil de la base Neon comme « visible à l'œil
 * nu », et c'est exactement ce que paie la PREMIÈRE écriture d'une soirée — le premier point du
 * premier jeu, sur un compute endormi depuis la veille. Dépassé, on sort en `P2028`, que la
 * boucle ne rejoue pas (elle ne peut pas : le même code recouvre aussi « transaction expirée »,
 * qu'il serait faux de rejouer quatre fois). Le marqueur voit donc un 500, au pire moment.
 *
 * Dix secondes, c'est-à-dire « le temps qu'une base froide se réveille », et non « le temps
 * qu'une écriture se termine » : une fois la connexion obtenue, cette valeur ne coûte plus rien.
 * Elle n'allonge une attente que là où le défaut rendait une erreur.
 *
 * ⚠️ `timeout` (durée de la transaction elle-même) reste au défaut de 5 s, et c'est délibéré :
 * mesuré, ce plafond N'INTERROMPT PAS la requête en cours — elle va au bout, et c'est au retour
 * qu'elle est refusée. Le relever ne ferait donc gagner du temps à personne ; il changerait
 * seulement le moment où l'on jette un travail abouti. Les huit allers-retours du `PATCH` se
 * comptent en centaines de millisecondes une fois la connexion ouverte.
 */
const MAX_WAIT_MS = 10_000;

/**
 * Exporté pour être ÉPROUVÉ, et non par commodité : la borne ci-dessus est un chiffre qu'on lit
 * pour dimensionner un délai côté client, et un chiffre qu'aucun test ne mesure finit toujours
 * par décrire une autre version du code.
 */
export function backoffFor(attempt: number): number {
  return Math.round(Math.random() * BACKOFF_MS * 2 ** attempt);
}

/**
 * Exécute `run` dans une transaction Serializable, en la rejouant sur conflit.
 *
 * Renvoie ce que renvoie `run`. Relaie tel quel ce que `run` jette — une `HttpError` traverse
 * donc intacte, et n'est JAMAIS confondue avec un conflit : un refus métier ne doit pas être
 * rejoué, il se reproduirait à l'identique.
 *
 * Après épuisement des tentatives, lève une `HttpError` 409 portant `conflictMessage` : au
 * client de réessayer, c'est un état transitoire et non une faute de sa part.
 *
 * Entre deux tentatives, un recul tiré au sort qui DOUBLE à chaque tour (cf. `backoffFor`) :
 * sans lui, la boucle épuisait ses essais plus vite que la transaction concurrente ne se
 * terminait, et deux écrivains en conflit se retrouvaient au même instant à chaque tour.
 */
export async function serializableTransaction<T>(
  run: (tx: Prisma.TransactionClient) => Promise<T>,
  conflictMessage = "Écriture concurrente, réessaie",
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.$transaction(run, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: MAX_WAIT_MS,
      });
    } catch (e) {
      if (!isSerializationConflict(e)) throw e;
      if (attempt >= MAX_ATTEMPTS) throw new HttpError(409, conflictMessage, WRITE_CONFLICT);
      await new Promise((r) => setTimeout(r, backoffFor(attempt)));
    }
  }
}

/**
 * Traduit une `HttpError` en réponse JSON ; renvoie `null` pour tout le reste.
 *
 * Le `null` est délibéré, et c'est le point : une erreur inattendue doit continuer de remonter
 * jusqu'au 500 de Next, avec sa trace. Avaler tout ce qui passe transformerait un bug en
 * message poli, et on ne le verrait jamais dans les journaux.
 *
 *     } catch (e) {
 *       const res = httpErrorResponse(e);
 *       if (res) return res;
 *       throw e;
 *     }
 */
export function httpErrorResponse(e: unknown): NextResponse | null {
  if (!(e instanceof HttpError)) return null;
  return NextResponse.json(
    e.code ? { error: e.message, code: e.code } : { error: e.message },
    { status: e.status },
  );
}

/**
 * Lit le corps JSON d'une requête en OBJET — ou rend `{}`.
 *
 * `await req.json().catch(() => ({}))` ne rattrape que le JSON ILLISIBLE. Or `null`, `5` et
 * `"x"` sont du JSON parfaitement valide : `json()` résout, et c'est la ligne suivante qui
 * casse — `const { date, teamId } = body as …` lève « Cannot destructure property of null », et
 * `"homeUserId" in body` lève sur une primitive. Un corps que toutes les autres formes de
 * malformation font finir en 400 propre sortait donc en 500 non géré.
 *
 * Rendre `{}` remet ces corps sur le chemin ordinaire : la validation manuelle qui suit les
 * refuse comme elle refuse un corps vide, avec le même message et le même statut.
 *
 * ⚠️ UN TABLEAU N'EST PAS UN OBJET, même si `typeof` le prétend. `[1,2,3]` ressortait tel
 * quel, typé `Record<string, unknown>` : la promesse ci-dessus n'était alors tenue que par
 * ACCIDENT — les routes valident champ par champ, et `tableau.date` vaut `undefined`, donc ça
 * finissait bien en 400. Mais rien ne garantit que la prochaine route lira un champ plutôt
 * qu'une longueur ou un index, et `Array.isArray` coûte moins cher que ce raisonnement.
 */
export async function readJsonBody(req: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  const raw = await req.json().catch(() => null);
  return raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}
