import { cookies } from "next/headers";
import { loadMe } from "@/lib/me";
import HomeApp, { type InitialMe } from "./HomeApp";

// L'ACCUEIL, RENDU CÔTÉ SERVEUR JUSQU'À LA SESSION (audit 2026-10, point 26).
//
// Le layout est déjà dynamique (nonce de la CSP) : lire la session ici ne coûte aucune
// propriété de cache, et supprime l'aller-retour `/api/auth/me` que l'écran attendait avant de
// pouvoir s'afficher. En cas d'échec (base injoignable…), on ne tranche rien : `undefined`
// laisse le client interroger l'API comme avant — et afficher la bannière de maintenance.
export default async function Page() {
  const sid = (await cookies()).get("sid")?.value;
  let initialMe: InitialMe;
  try {
    initialMe = await loadMe(sid);
  } catch {
    initialMe = undefined;
  }
  return <HomeApp initialMe={initialMe} />;
}
