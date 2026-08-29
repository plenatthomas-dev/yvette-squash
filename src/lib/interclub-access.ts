// Qui a le droit d'entrer dans l'interclub — et jusqu'où.
//
// ⚠️ NE PAS CONFONDRE AVEC `interclub-gate.ts`, qui ne parle pas de droits du tout : celui-là
// est le CACHE du direct (« porte d'entrée bon marché »). Ici, c'est le contrôle d'accès.
//
// POURQUOI CE MODULE EXISTE
// Neuf routes recopiaient le même préambule : lire le flag de fonction, répondre 404 s'il est
// coupé, lire la session, répondre 401 sinon. Recopié, un préambule s'oublie — et l'oubli le
// plus coûteux est celui du FLAG : une route qui ne le teste pas reste ouverte en production
// alors que la fonction y est éteinte, et rien ne le signale puisque l'écran, lui, est caché.
//
// LE MODÈLE D'AUTORISATION DE L'INTERCLUB, ÉNONCÉ UNE FOIS POUR TOUTES
// Il n'y a qu'un seul rôle : MEMBRE CONNECTÉ. Tout membre peut créer une rencontre, composer
// une équipe, prendre le marquage d'un match et y saisir les points. C'est une décision de
// produit, pas un oubli — cf. `docs/interclub.md`, section « Autorisations ». Le club compte
// quelques dizaines de personnes qui se connaissent ; exiger un rôle de capitaine bloquerait
// la saisie exactement les soirs où le capitaine joue, et c'est le seul moment où elle sert.
//
// Trois exceptions seulement, et chacune protège quelqu'un d'un ÉCRASEMENT, jamais d'un accès :
//   * un match ENTAMÉ ne se modifie qu'au créateur de la rencontre, au joueur concerné, au
//     marqueur ou à un admin (PATCH …/matches/{mid}) ;
//   * un match dont quelqu'un TIENT le marquage ne s'écrit pas par-dessus lui, tant que sa
//     prise n'est pas périmée (POST …/claim, PUT …/live) ;
//   * supprimer une rencontre est réservé à son créateur et aux admins (DELETE …/{id}).
//
// La composition, elle, est bornée autrement : le ROSTER de l'équipe (cf. `interclub-roster.ts`)
// décide qui peut être aligné, et l'appartenance à une équipe est posée par un admin. On peut
// donc composer librement — mais seulement avec les joueurs de l'équipe qui dispute la
// rencontre.

import { NextResponse, type NextRequest } from "next/server";
import { getFeatures } from "./features-server";
import { getSession, type AppSession } from "./session";

/**
 * Résultat du contrôle d'accès. Union discriminée plutôt qu'un jet d'exception : l'appelant
 * voit dans sa signature qu'il y a deux chemins, et TypeScript refuse de lui laisser lire
 * `session` sans avoir traité le refus.
 */
export type InterclubAccess =
  | { ok: true; session: AppSession }
  | { ok: false; response: NextResponse };

/**
 * Fonction active + membre connecté. À appeler en tête de toute route `/api/interclub/**`.
 *
 *     const access = await requireInterclubMember(req);
 *     if (!access.ok) return access.response;
 *     const { session } = access;
 *
 * L'ordre des deux contrôles compte : le flag D'ABORD. Une fonction coupée doit répondre 404
 * — « cette route n'existe pas ici » — y compris à un visiteur non connecté. Tester la session
 * en premier lui répondrait 401, ce qui révèle qu'il existe quelque chose à cette adresse.
 */
export async function requireInterclubMember(req: NextRequest): Promise<InterclubAccess> {
  if (!(await getFeatures()).interclub) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Fonction indisponible" }, { status: 404 }),
    };
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Non authentifié" }, { status: 401 }),
    };
  }
  return { ok: true, session };
}

/**
 * Le flag seul, pour les routes d'ADMIN : elles ont déjà leur propre contrôle (`requireAdmin`)
 * et n'ont pas besoin d'une session de membre, mais elles doivent disparaître exactement comme
 * les autres quand la fonction est coupée.
 *
 * Renvoie la réponse 404 à retourner, ou `null` si la fonction est active.
 */
export async function interclubDisabledResponse(): Promise<NextResponse | null> {
  if ((await getFeatures()).interclub) return null;
  return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
}
