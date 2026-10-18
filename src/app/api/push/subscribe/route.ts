import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

// Bornes d'un abonnement Web Push : l'endpoint est une URL https d'un service push connu
// (le plus souvent < 512 caractères), les clés sont de courtes chaînes base64url. On borne et
// on type tout pour éviter qu'un client authentifié stocke des chaînes géantes (abus de
// stockage) ou un endpoint fantaisiste (cf. isKnownPushEndpoint).
const MAX_ENDPOINT_LEN = 1024;
const MAX_KEY_LEN = 256;

/**
 * Services push reconnus, par nom d'hôte. Un endpoint est l'URL vers laquelle le SERVEUR
 * poste ensuite à chaque notification : « commence par https:// » laissait un membre y écrire
 * n'importe quelle adresse, et faire émettre par nos crons des requêtes signées VAPID vers un
 * hôte de son choix (SSRF aveugle, ou simple sonde de nos envois).
 *
 * La liste couvre tous les navigateurs qui font du Web Push, car ils délèguent tous à l'un de
 * ces services :
 *  - FCM (Google) : Chrome, et tous les dérivés Chromium hors Edge — Samsung Internet, Opera,
 *    Brave, Vivaldi, Yandex — ainsi que la WebView de l'appli Android ;
 *  - Mozilla autopush : Firefox, bureau et Android (`updates.push.services.mozilla.com`) ;
 *  - WNS (Microsoft) : Edge (`wns2-xxx.notify.windows.com`) ;
 *  - APNs web (Apple) : Safari macOS et iOS/iPadOS ≥ 16.4 (`web.push.apple.com`).
 * L'ancien `android.googleapis.com/gcm/send` n'y est PAS : GCM est éteint depuis 2019 et
 * l'API historique de FCM depuis 2024, un tel endpoint ne recevrait plus rien.
 *
 * `exact` : nom d'hôte égal ; `suffixe` : sous-domaine du suffixe (le point est inclus, pour
 * que « evilnotify.windows.com » ne passe pas pour « x.notify.windows.com »).
 */
const PUSH_HOSTS_EXACT = new Set(["fcm.googleapis.com", "web.push.apple.com"]);
const PUSH_HOST_SUFFIXES = [".push.services.mozilla.com", ".notify.windows.com", ".push.apple.com"];

/** L'endpoint désigne-t-il un service push connu, en https sur le port standard ? */
function isKnownPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  // `new URL` normalise l'hôte (minuscules, punycode) : la comparaison porte sur le vrai nom,
  // pas sur une chaîne que « https://fcm.googleapis.com@ailleurs.example/ » tromperait.
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) return false;
  const host = url.hostname;
  return PUSH_HOSTS_EXACT.has(host) || PUSH_HOST_SUFFIXES.some((suf) => host.endsWith(suf));
}

/**
 * Appareils abonnés par membre. Un endpoint par navigateur et par appareil : dix couvre
 * largement téléphone, tablette, ordinateurs et réinstallations. Sans plafond, chaque
 * réinstallation ou effacement des données du navigateur laissait une ligne de plus (l'ancien
 * endpoint n'est purgé qu'au premier envoi refusé en 404/410), et un client authentifié pouvait
 * en créer à volonté — autant d'envois par notification. Au-delà, on supprime les PLUS ANCIENS :
 * ce sont les plus susceptibles d'être morts.
 */
const MAX_SUBSCRIPTIONS_PER_USER = 10;

// POST /api/push/subscribe { endpoint, keys: { p256dh, auth } }
// Enregistre (ou met à jour) l'abonnement Web Push de l'appareil courant.
export async function POST(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value, { resa: false });
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const { endpoint, keys } = (await req.json().catch(() => ({}))) as {
    endpoint?: unknown;
    keys?: { p256dh?: unknown; auth?: unknown };
  };
  const p256dh = keys?.p256dh;
  const auth = keys?.auth;
  if (
    typeof endpoint !== "string" ||
    endpoint.length > MAX_ENDPOINT_LEN ||
    !isKnownPushEndpoint(endpoint) ||
    typeof p256dh !== "string" ||
    p256dh.length === 0 ||
    p256dh.length > MAX_KEY_LEN ||
    typeof auth !== "string" ||
    auth.length === 0 ||
    auth.length > MAX_KEY_LEN
  ) {
    return NextResponse.json({ error: "Abonnement invalide" }, { status: 400 });
  }

  // Un endpoint identifie UN navigateur/appareil (clé unique). S'il est déjà rattaché à
  // un autre compte, c'est un appareil qui change de main (ancien membre déconnecté,
  // nouveau connecté) : on le TRANSFÈRE au compte courant. Rejeter serait pire — l'appareil
  // continuerait de recevoir les notifs de l'ancien compte et aucune du nouveau. L'endpoint
  // n'est jamais exposé par l'appli à d'autres clients (écrit ici, lu seulement côté serveur
  // par le cron) → risque de détournement à distance marginal.
  await prisma.pushSubscription.upsert({
    where: { endpoint },
    update: { userId: session.userId, p256dh, auth },
    create: { userId: session.userId, endpoint, p256dh, auth },
  });

  // Plafond : on garde l'appareil courant + les (MAX − 1) autres plus récents. L'appareil
  // courant est exclu du tri — un endpoint déjà connu garde son `createdAt` d'origine à l'upsert,
  // et serait sinon supprimé comme « le plus ancien » au moment même où il vient de se confirmer.
  // Best-effort : l'abonnement est enregistré, un échec du ménage ne doit pas le faire croire raté.
  try {
    const surplus = await prisma.pushSubscription.findMany({
      where: { userId: session.userId, NOT: { endpoint } },
      orderBy: { createdAt: "desc" },
      skip: MAX_SUBSCRIPTIONS_PER_USER - 1,
      select: { id: true },
    });
    if (surplus.length > 0) {
      await prisma.pushSubscription.deleteMany({ where: { id: { in: surplus.map((x) => x.id) } } });
    }
  } catch (e) {
    console.warn(`[push] ménage des abonnements échoué (user ${session.userId}) : ${(e as Error).message}`);
  }
  return NextResponse.json({ ok: true });
}
