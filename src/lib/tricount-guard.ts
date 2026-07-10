import { NextResponse } from "next/server";
import type { AppSession } from "@/lib/session";

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
