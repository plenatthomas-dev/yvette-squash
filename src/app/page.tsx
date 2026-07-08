import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { buildMePayload, type MePayload } from "@/lib/me-payload";
import { loadPlanningForSession } from "@/lib/planning-load";
import { defaultOpenDateParis } from "@/lib/date";
import HomeClient from "./HomeClient";
import type { PlanningDay } from "@/lib/resamania/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Server Component : précharge la session + le planning du jour par défaut pendant le
// rendu serveur, pour que le premier HTML envoyé au navigateur contienne déjà les
// vraies données (au lieu d'un écran "Chargement…" suivi de deux allers-retours
// fetch("/api/auth/me") puis fetch("/api/planning") après hydratation). Le reste de
// l'appli (semaine, tricount, annuaire, alertes…) reste chargé côté client comme avant.
export default async function Page() {
  const date = defaultOpenDateParis();

  let initialMe: MePayload | null | undefined = undefined;
  let initialPlanning: PlanningDay | null = null;

  try {
    const cookieStore = await cookies();
    const session = await getSession(cookieStore.get("sid")?.value);
    if (!session) {
      initialMe = null; // pas de session : écran de connexion, direct au premier rendu
    } else {
      initialMe = await buildMePayload(session);
      try {
        initialPlanning = await loadPlanningForSession(session, date);
      } catch {
        // ResaMania/DB indisponible pendant le SSR → le client refera l'appel normalement.
        initialPlanning = null;
      }
    }
  } catch {
    // Statut de session indéterminé (erreur inattendue) → NE PAS forcer "déconnecté" :
    // on laisse `initialMe` à `undefined`, le client retombe sur son comportement d'origine
    // (écran de chargement, puis fetch("/api/auth/me") normal).
    initialMe = undefined;
  }

  return (
    <HomeClient initialMe={initialMe} initialPlanning={initialPlanning} initialDate={date} />
  );
}
