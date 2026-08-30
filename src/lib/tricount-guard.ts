import { NextResponse } from "next/server";
import type { AppSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { isSettled } from "@/lib/tricount";

/** Un compte « email seul » n'a aucun jeton ResaMania rattaché (`resa === null`). */
export function isEmailOnly(session: AppSession): boolean {
  return session.resa === null;
}

/**
 * Politique Tricount pour les comptes « email seul » (connectés par email, sans
 * compte ResaMania) : ils peuvent lire, déclarer leurs remboursements, discuter
 * (messagerie) ET valider un tricount. Seule la gestion des dépenses leur est
 * interdite : pas de création/modification/suppression de ligne de dépense.
 * Renvoie une réponse 403 si l'action est interdite, sinon null.
 */
export function blockEmailOnlyExpenseWrite(session: AppSession): NextResponse | null {
  if (isEmailOnly(session)) {
    return NextResponse.json(
      {
        error:
          "Compte email seul : la gestion des dépenses est réservée aux comptes ResaMania. Tu peux consulter, déclarer tes remboursements, discuter et valider.",
      },
      { status: 403 },
    );
  }
  return null;
}

/**
 * Refuse en 409 la réécriture d'un tricount SOLDÉ — tout le monde a validé, plus aucun
 * virement n'est dû. Rend la réponse à retourner, ou `null` si l'écriture peut se faire.
 * `where` vise le tricount par son id (édition, suppression) ou par sa date (création).
 *
 * Cette règle n'existait que dans l'écran, qui masque « Modifier » et « Suppr. » sur un
 * tricount soldé. Le serveur ne la connaissait pas : un appel direct recalculait les parts,
 * effaçait les validations et rouvrait un tricount clos — un état que l'interface présentait
 * comme impossible. Une règle que seul le client applique n'est pas une règle.
 *
 * ⚠️ ELLE NE S'APPLIQUE QU'AUX VRAIES DÉPENSES, et c'est délibéré. Un remboursement mal saisi
 * est précisément ce qui peut rendre un tricount « soldé » alors que l'argent n'a pas bougé :
 * interdire de le défaire enfermerait le membre dans son erreur, sans autre recours qu'un
 * admin. La règle protège l'historique ; elle ne doit pas verrouiller sa correction.
 *
 * ⚠️ Elle vit ICI, et non dans une route, parce que les TROIS écritures de dépense la
 * partagent — créer, modifier, supprimer. La laisser dans la route d'édition l'aurait rendue
 * contournable en trois clics : ajouter une dépense à un tricount soldé le rouvrait, puisque
 * la création remet toutes les validations à zéro.
 */
export async function refuseSiSolde(
  where: { id: string } | { date: string },
): Promise<NextResponse | null> {
  const t = await prisma.tricount.findUnique({
    where: where as { id: string },
    select: {
      expenses: {
        select: {
          payerId: true,
          payerGuestId: true,
          isRefund: true,
          shares: { select: { userId: true, guestId: true, amountCents: true } },
        },
      },
      approvals: { select: { userId: true } },
    },
  });
  // Tricount inexistant (première dépense d'une date) ou ligne parente disparue : rien à
  // refuser — les gardes suivantes trancheront.
  if (!t) return null;
  if (!isSettled(t.expenses, t.approvals.map((a) => a.userId))) return null;
  return NextResponse.json(
    {
      error:
        "Ce tricount est soldé : tout le monde a validé et plus rien n'est dû. Pour le rouvrir, supprime d'abord un remboursement.",
    },
    { status: 409 },
  );
}
