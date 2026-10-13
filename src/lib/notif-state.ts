// MESURER QUI NE REÇOIT PAS LES NOTIFICATIONS, ET POURQUOI.
//
// Chaque appareil déclare à l'ouverture de l'appli où il en est (cf. `notif-report.ts`) ; le
// tableau de bord admin en tire, membre par membre, la meilleure situation de ses appareils.
//
// Module PUR : utilisé par la route (validation), le tableau de bord (agrégat) et le client
// (types, libellés). Aucun import serveur ni client.

/** Où tourne l'appli — décide du chemin de déblocage (cf. `notif-unblock.ts`). */
export const NOTIF_PLATFORMS = [
  "android-app", // appli du Play Store (TWA) : notifications déléguées à l'appli Android
  "android-pwa", // PWA ajoutée à l'écran d'accueil depuis Chrome
  "android", // onglet Chrome (ou autre navigateur) sur Android
  "ios", // iPhone / iPad (seule la PWA reçoit des notifications)
  "firefox",
  "safari", // Safari sur Mac
  "desktop", // Chrome, Edge et autres Chromium sur ordinateur
] as const;
export type NotifPlatform = (typeof NOTIF_PLATFORMS)[number];

export const NOTIF_PLATFORM_LABELS: Record<NotifPlatform, string> = {
  "android-app": "appli Android",
  "android-pwa": "raccourci Android",
  android: "Chrome Android",
  ios: "iPhone",
  firefox: "Firefox",
  safari: "Safari Mac",
  desktop: "Chrome/Edge PC",
};

/** `default` = la question n'a jamais été posée (ou fermée sans réponse). */
export const NOTIF_PERMISSIONS = ["granted", "denied", "default", "unsupported"] as const;
export type NotifPermission = (typeof NOTIF_PERMISSIONS)[number];

export type NotifDeviceReport = {
  deviceId: string;
  permission: NotifPermission;
  subscribed: boolean;
  platform: NotifPlatform;
};

// Identifiant tiré par `crypto.randomUUID()` côté client : 36 caractères. Bornes larges, mais
// bornes quand même — c'est une clé primaire écrite par n'importe quel compte connecté.
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** Valide le corps de `POST /api/push/state`. `null` = à refuser. */
export function parseNotifReport(body: unknown): NotifDeviceReport | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.deviceId !== "string" || !DEVICE_ID_RE.test(b.deviceId)) return null;
  if (!NOTIF_PERMISSIONS.includes(b.permission as NotifPermission)) return null;
  if (!NOTIF_PLATFORMS.includes(b.platform as NotifPlatform)) return null;
  if (typeof b.subscribed !== "boolean") return null;
  return {
    deviceId: b.deviceId,
    permission: b.permission as NotifPermission,
    subscribed: b.subscribed,
    platform: b.platform as NotifPlatform,
  };
}

/** Fenêtre du tableau de bord : un appareil qui ne s'est pas ouvert depuis ne compte plus. */
export const NOTIF_STATE_WINDOW_DAYS = 30;

/**
 * Situation d'UN appareil, du plus favorable au moins favorable pour recevoir quelque chose.
 * `off` : autorisé mais pas abonné — « Ne plus recevoir » pressé, ou abonnement perdu.
 */
export type NotifStatus = "receiving" | "denied" | "off" | "notAsked" | "unsupported";
const RANK: NotifStatus[] = ["receiving", "denied", "off", "notAsked", "unsupported"];

export function deviceStatus(d: { permission: string; subscribed: boolean }): NotifStatus {
  if (d.permission === "granted") return d.subscribed ? "receiving" : "off";
  if (d.permission === "denied") return "denied";
  if (d.permission === "default") return "notAsked";
  return "unsupported";
}

export type NotifSummary = {
  /** Membres distincts vus dans la fenêtre — le dénominateur de tout le reste. */
  members: number;
  devices: number;
  /** Membres, classés par la MEILLEURE situation de leurs appareils : un membre qui reçoit
   *  sur son téléphone n'est pas « bloqué » parce que son ordinateur a refusé. Un refus passe
   *  en revanche avant « jamais demandé » : c'est celui qui a besoin d'aide. */
  byMember: Record<NotifStatus, number>;
  /** Appareils refusés, par plateforme : là où le guide de déblocage sert. */
  deniedByPlatform: Partial<Record<NotifPlatform, number>>;
  /** Appareils sans support, par plateforme (l'iPhone hors écran d'accueil, surtout). */
  unsupportedByPlatform: Partial<Record<NotifPlatform, number>>;
};

export function summarizeNotifStates(
  rows: { userId: string; permission: string; subscribed: boolean; platform: string }[],
): NotifSummary {
  const best = new Map<string, NotifStatus>();
  const deniedByPlatform: NotifSummary["deniedByPlatform"] = {};
  const unsupportedByPlatform: NotifSummary["unsupportedByPlatform"] = {};

  for (const r of rows) {
    const st = deviceStatus(r);
    const prev = best.get(r.userId);
    if (!prev || RANK.indexOf(st) < RANK.indexOf(prev)) best.set(r.userId, st);
    const p = r.platform as NotifPlatform;
    if (st === "denied") deniedByPlatform[p] = (deniedByPlatform[p] ?? 0) + 1;
    if (st === "unsupported") unsupportedByPlatform[p] = (unsupportedByPlatform[p] ?? 0) + 1;
  }

  const byMember: Record<NotifStatus, number> = {
    receiving: 0,
    denied: 0,
    off: 0,
    notAsked: 0,
    unsupported: 0,
  };
  for (const st of best.values()) byMember[st]++;

  return { members: best.size, devices: rows.length, byMember, deniedByPlatform, unsupportedByPlatform };
}

/** « 3 appli Android · 1 iPhone » — le détail d'une tuile, plus gros d'abord. */
export function platformBreakdown(counts: Partial<Record<NotifPlatform, number>>): string {
  return (Object.entries(counts) as [NotifPlatform, number][])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([p, n]) => `${n} ${NOTIF_PLATFORM_LABELS[p] ?? p}`)
    .join(" · ");
}
