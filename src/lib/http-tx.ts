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
 * Nombre total de tentatives. Quatre, c'est-à-dire trois réessais : au-delà, l'écriture n'est
 * plus en conflit ponctuel mais en contention durable, et insister ferait attendre le client
 * sans améliorer ses chances.
 */
const MAX_ATTEMPTS = 4;

/** P2034 = conflit d'écriture / échec de sérialisation, le cas qu'on rejoue. */
function isSerializationConflict(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2034";
}

/**
 * Recul entre deux tentatives : croissant, et TIRÉ AU SORT sur toute sa largeur.
 *
 * Le raisonnement qui justifie le nombre de tentatives — « au-delà, l'écriture n'est plus en
 * conflit ponctuel mais en contention durable » — suppose implicitement que du TEMPS passe entre
 * les essais. La boucle n'en laissait passer aucun : quatre tentatives pouvaient s'épuiser en
 * quelques millisecondes et rendre un 409 là où vingt millisecondes auraient suffi.
 *
 * Le tirage au sort compte autant que le recul lui-même : deux marqueurs qui entrent en conflit
 * rejouent sinon en cadence, et se retrouvent au même instant à chaque tour.
 *
 * BORNES EXACTES, parce qu'une borne approximative ne sert à rien : l'attente précédant la
 * tentative n vaut au plus `20 × n` ms, soit 20, 40 puis 60 ms avant la quatrième et dernière —
 * 120 ms cumulées au pire. Le commentaire annonçait « 40 ms au pire avant la dernière
 * tentative » : il comptait l'avant-dernière.
 *
 * Elles restent petites parce qu'un 40001 signifie que la transaction concurrente est déjà
 * retombée : on attend le temps de se désynchroniser, pas le temps qu'une écriture se termine.
 */
const BACKOFF_MS = 10;

/**
 * Exporté pour être ÉPROUVÉ, et non par commodité : la borne ci-dessus est un chiffre qu'on lit
 * pour dimensionner un délai côté client, et un chiffre qu'aucun test ne mesure finit toujours
 * par décrire une autre version du code.
 */
export function backoffFor(attempt: number): number {
  return Math.round(Math.random() * BACKOFF_MS * attempt * 2);
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
 * Entre deux tentatives, un court recul tiré au sort (cf. `backoffFor`) : sans lui, la boucle
 * épuisait ses quatre essais en quelques millisecondes, et deux écrivains en conflit se
 * retrouvaient au même instant à chaque tour.
 */
export async function serializableTransaction<T>(
  run: (tx: Prisma.TransactionClient) => Promise<T>,
  conflictMessage = "Écriture concurrente, réessaie",
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.$transaction(run, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (e) {
      if (!isSerializationConflict(e)) throw e;
      if (attempt >= MAX_ATTEMPTS) throw new HttpError(409, conflictMessage);
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
 */
export async function readJsonBody(req: { json: () => Promise<unknown> }): Promise<Record<string, unknown>> {
  const raw = await req.json().catch(() => null);
  return raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}
