"use client";

// Détection centralisée d'une indisponibilité de la base (Neon en veille / au-delà du quota
// compute du plan Free, coupure réseau côté serveur…).
//
// Symptôme typique : une route serveur qui touche Prisma jette AVANT d'avoir pu répondre en
// JSON → réponse 500 au corps VIDE → côté client `await res.json()` lève « Unexpected end of
// JSON input », message technique illisible pour l'utilisateur. On transforme ce symptôme en un
// signal clair : on interroge /api/health (un simple `SELECT 1`, public, cf. api/health) et, si
// la base ne répond pas, on lève une MaintenanceError « lisible » ET on déclenche la bannière
// « Appli en maintenance » (cf. components/MaintenanceBanner).

export const MAINTENANCE_EVENT = "app-maintenance";

/** Erreur signalant que l'appli est (probablement) indisponible car la base ne répond pas.
 *  Son message EST le texte affiché à l'utilisateur : self-contained, sans jargon. */
export class MaintenanceError extends Error {
  constructor(
    message = "Appli momentanément en maintenance : la base de données ne répond pas. Réessaie dans quelques minutes.",
  ) {
    super(message);
    this.name = "MaintenanceError";
  }
}

/**
 * Déclenche la bannière de maintenance (best-effort, no-op côté serveur).
 * `confirmedDown` : `true` quand l'appelant a DÉJÀ confirmé via /api/health que la base est à
 * terre → la bannière s'affiche sans re-sonder. Sinon (simple soupçon, ex. un 5xx au démarrage)
 * elle confirmera elle-même avant d'apparaître, pour ne pas crier « maintenance » sur un
 * incident applicatif ponctuel sans rapport avec la base.
 */
export function reportMaintenance(confirmedDown?: boolean): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(MAINTENANCE_EVENT, { detail: { confirmed: confirmedDown === true } }),
  );
}

/**
 * Vérifie la disponibilité de la base via /api/health (`SELECT 1`). `true` = base injoignable.
 * Best-effort : au moindre doute (health elle-même KO, réseau coupé) on renvoie `true`, puisqu'on
 * n'appelle cette fonction qu'après un échec déjà suspect.
 */
export async function isDbDown(): Promise<boolean> {
  try {
    const r = await fetch("/api/health", { cache: "no-store" });
    // 404 = la route /api/health N'EXISTE PLUS (supprimée). On ne peut alors RIEN conclure sur la
    // base → on renvoie `false` pour NE PAS crier « maintenance » à tort sur chaque incident. La
    // détection via health se désactive proprement ; le reste (message lisible au login via
    // readJson, drapeau `maintenance` renvoyé par le serveur) continue de fonctionner sans elle.
    if (r.status === 404) return false;
    if (!r.ok) return true; // 503 = le SELECT 1 a échoué (base en veille/quota), ou autre non-ok
    const d = (await r.json().catch(() => null)) as { ok?: boolean } | null;
    return d?.ok === false;
  } catch {
    return true; // /api/health injoignable (réseau) → on suppose l'indisponibilité
  }
}

/**
 * Lit le corps JSON d'une réponse en distinguant une VRAIE panne de base d'une erreur applicative
 * ordinaire. À utiliser à la place de `await res.json()` là où l'on préfère afficher la bannière
 * de maintenance plutôt qu'un message technique.
 *
 * - serveur qui signale EXPLICITEMENT la panne (`503 { maintenance: true }`, cf. lib/db-error) →
 *   déclenche la bannière et lève MaintenanceError, SANS sonder /api/health : le login reste
 *   couvert même si /api/health est un jour supprimée ;
 * - corps JSON valide par ailleurs (que `res.ok` soit vrai ou non) → renvoie l'objet ; l'appelant
 *   gère `res.ok` exactement comme avant (`if (!res.ok) throw new Error(data.error …)`) ;
 * - corps illisible / vide (500 sans JSON d'une route qui a jeté avant de répondre — filet pour
 *   celles qui ne renvoient pas encore le 503 ci-dessus) → sonde /api/health : si la base est à
 *   terre, bannière + MaintenanceError ; sinon lève une erreur générique lisible.
 */
export async function readJson<T = unknown>(res: Response): Promise<T> {
  let data: T;
  try {
    data = (await res.json()) as T;
  } catch {
    if (await isDbDown()) {
      reportMaintenance(true);
      throw new MaintenanceError();
    }
    throw new Error(`Réponse inattendue du serveur (${res.status}).`);
  }
  // Le serveur a explicitement dit « base injoignable » : autoritaire, aucune sonde /api/health.
  if (res.status === 503 && (data as { maintenance?: boolean } | null)?.maintenance) {
    reportMaintenance(true);
    throw new MaintenanceError((data as { error?: string }).error);
  }
  return data;
}
