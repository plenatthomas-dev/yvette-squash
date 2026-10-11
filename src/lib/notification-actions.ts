// Les boutons des notifications, exécutés par le service worker sans ouvrir l'appli.
//
// Le contrat se lit des deux côtés : ici ce que le serveur envoie, dans `public/sw.js` ce que
// le worker en fait. Le worker est un fichier statique qui n'importe rien : les noms d'action
// y sont recopiés tels quels, et c'est à ces deux endroits qu'il faut les changer ensemble.

import { NextResponse } from "next/server";

type NotificationAction = { action: string; title: string };

/** « Un terrain s'est libéré » → le réserver d'un geste. */
export const BOOK_ACTION: NotificationAction = { action: "book", title: "Réserver" };

/**
 * « Dis si tu es disponible » → répondre d'un geste. Pas de « Peut-être » : Android n'affiche
 * que deux boutons, et une réponse incertaine mérite l'écran, où l'on peut la commenter.
 */
export const AVAILABILITY_ACTIONS: NotificationAction[] = [
  { action: "avail-yes", title: "Dispo" },
  { action: "avail-no", title: "Pas dispo" },
];

/**
 * Le geste vient-il du bon compte ?
 *
 * Un bouton de notification agit avec la session ouverte sur l'appareil, pas avec celle du
 * destinataire : un téléphone qui a changé de compte depuis l'abonnement réserverait au nom du
 * nouveau venu. Le worker renvoie donc le destinataire (`to` du push, cf. `envoyerA` dans
 * push.ts) sous le nom `forUserId`, et la route refuse s'il ne correspond pas.
 *
 * Absent = appel de l'appli elle-même, qui agit pour la session ouverte : rien à vérifier.
 */
export function otherAccountResponse(forUserId: unknown, sessionUserId: string): NextResponse | null {
  if (forUserId === undefined || forUserId === null || forUserId === sessionUserId) return null;
  return NextResponse.json(
    {
      error: "Cette notification était destinée à un autre compte que celui connecté sur cet appareil.",
      code: "other_account",
    },
    { status: 409 },
  );
}
