"use client";

// Relevé de l'état des notifications de CET appareil, pour le tableau de bord admin
// (cf. `notif-state.ts`). Silencieux et économe : rien n'est envoyé si l'état n'a pas changé
// depuis moins d'un jour — chaque écriture réveille la base Neon.

import { pushSubscriptionState } from "@/lib/pushClient";
import { currentNotifPlatform } from "@/lib/notif-unblock";

const DEVICE_KEY = "notifDeviceId";
const LAST_KEY = "notifStateReport";
const DAY_MS = 24 * 60 * 60_000;

/** Identifiant aléatoire de cet appareil, tiré une fois. Ne dit rien de l'appareil. */
function deviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

/**
 * Déclare au serveur où en sont les notifications de cet appareil. `userId` entre dans la
 * signature : un changement de compte sur le même appareil doit être relevé tout de suite.
 * Ne jette jamais — une mesure ratée n'a aucune conséquence pour le membre.
 */
export async function reportNotifState(userId: string): Promise<void> {
  try {
    const st = await pushSubscriptionState();
    const platform = currentNotifPlatform();
    const sig = [userId, st.permission, st.subscribed, platform].join("|");
    const last = JSON.parse(localStorage.getItem(LAST_KEY) ?? "null") as { sig?: string; at?: number } | null;
    if (last?.sig === sig && Date.now() - (last.at ?? 0) < DAY_MS) return;
    const res = await fetch("/api/push/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: deviceId(), permission: st.permission, subscribed: st.subscribed, platform }),
    });
    if (res.ok) localStorage.setItem(LAST_KEY, JSON.stringify({ sig, at: Date.now() }));
  } catch {
    /* stockage indisponible (navigation privée), réseau, `randomUUID` absent : pas de mesure */
  }
}
