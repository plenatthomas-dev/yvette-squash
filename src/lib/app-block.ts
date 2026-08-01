// Garde « appli bloquée » (cf. lib/settings, clé `block`), pilotée par le switch de /admin.
//
// Une seule règle, appliquée partout : si le blocage est actif ET que le demandeur n'est pas
// admin, la route refuse avec un 503 lisible portant le message choisi par l'admin. Les admins
// traversent tout — c'est le but : fermer l'appli aux membres sans se fermer la porte à soi-même.
//
// Deux entrées selon ce que la route connaît du demandeur :
//  • `appBlockForEmail`  — chemins de CONNEXION : on n'a que l'identifiant saisi, pas de session.
//  • `appBlockForUserId` — routes AUTHENTIFIÉES : la session est déjà ouverte, on part du userId.
//
// ⚠️ Sur les chemins de connexion, contrôler l'identifiant SAISI ne crée aucun contournement :
// taper l'email d'un admin fait juste sauter la garde, l'authentification réelle (mot de passe
// ResaMania / lien email / passkey) reste exigée juste après. On évite ainsi d'appeler ResaMania
// pour rien quand l'appli est fermée.
//
// COÛT : dans le cas courant (appli ouverte), la garde ne fait QU'UNE lecture `AppSetting` et
// s'arrête là — la résolution de l'email n'a lieu que si le blocage est effectivement actif.
// Ça compte : ces routes sont sur le chemin chaud, et chaque requête en plus réveille Neon.

import { NextResponse } from "next/server";
import { prisma } from "./db";
import { isAdminEmail } from "./admin";
import { getAppBlock, type AppBlock } from "./settings";

/** Blocage applicable à cet identifiant, ou `null` (appli ouverte, ou demandeur admin). */
export async function appBlockForEmail(email: string | null | undefined): Promise<AppBlock | null> {
  if (isAdminEmail(email)) return null; // l'admin n'est jamais bloqué
  return getAppBlock();
}

/** Blocage applicable à ce membre connecté, ou `null` (appli ouverte, ou membre admin). */
export async function appBlockForUserId(userId: string): Promise<AppBlock | null> {
  const block = await getAppBlock();
  if (!block) return null; // appli ouverte : on s'arrête ici, sans requête supplémentaire
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  return isAdminEmail(user?.email) ? null : block;
}

/**
 * Réponse standard d'une route fermée par le blocage. 503 (et non 403) : c'est une
 * indisponibilité temporaire et volontaire, pas un défaut de droits — même famille que la
 * réponse « base injoignable » (cf. lib/db-error), que le client sait déjà présenter.
 */
export function appBlockedResponse(block: AppBlock): NextResponse {
  return NextResponse.json({ error: block.message, blocked: true }, { status: 503 });
}
