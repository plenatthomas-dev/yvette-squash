// CONNEXION FORCÉE PAR CSRF (audit 2026-10, point 23).
//
// Les cookies `SameSite=Lax` protègent les routes qui LISENT une session : un site tiers ne
// peut pas faire porter la nôtre à une requête POST. Mais une route de CONNEXION n'a pas besoin
// de cookie — elle en POSE un. Un formulaire caché sur un autre site pouvait donc connecter le
// navigateur d'un membre au compte de l'attaquant (« login CSRF ») : ce que le membre saisit
// ensuite (alertes, messages…) atterrit chez l'attaquant.
//
// Le navigateur dit d'où vient la requête : `Sec-Fetch-Site` (tous les navigateurs actuels),
// et `Origin` à défaut. On refuse ce qui vient d'AILLEURS ; une requête sans aucun des deux
// (outil en ligne de commande, très vieux navigateur) passe — elle ne peut pas venir d'un site
// tiers dans un navigateur qui les envoie.

import { NextResponse, type NextRequest } from "next/server";

/** Vrai si la requête vient de notre propre site (ou d'un contexte sans site, ex. favori). */
export function isSameOriginRequest(req: Pick<NextRequest, "headers">): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    return !!host && new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** Réponse 403 à renvoyer quand `isSameOriginRequest` refuse, `null` sinon. */
export function crossSiteRefusal(req: Pick<NextRequest, "headers">): NextResponse | null {
  if (isSameOriginRequest(req)) return null;
  return NextResponse.json({ error: "Requête refusée." }, { status: 403 });
}
