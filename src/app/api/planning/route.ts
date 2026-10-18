import { NextRequest, NextResponse } from "next/server";
import { getPlanningWithMeta } from "@/lib/resamania/client";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { annotatePlanning } from "@/lib/planning-annotate";
import { reconcilePlanningWithBookings } from "@/lib/booking-reconcile";
import type { PlanningDay } from "@/lib/resamania/types";
import { clubTodayISO, isRealDateISO, stampFR } from "@/lib/time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/planning?date=YYYY-MM-DD
export async function GET(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  // Date par défaut : AUJOURD'HUI À L'HEURE DU CLUB. L'ancien `toISOString().slice(0, 10)`
  // rendait la date UTC, donc la veille entre minuit et 1-2 h à Paris.
  const date = new URL(req.url).searchParams.get("date") ?? clubTodayISO();
  // Une date impossible (`2026-02-31`, texte libre) partait telle quelle vers ResaMania et
  // servait de clé au snapshot et au cache : refus net plutôt qu'une ligne parasite en base.
  if (!isRealDateISO(date)) {
    return NextResponse.json({ error: "Date invalide (AAAA-MM-JJ attendu)" }, { status: 400 });
  }

  // --- Compte « email seul » (sans jeton ResaMania) : on sert le dernier snapshot du
  //     planning, ré-annoté en direct (présences à jour, dont son propre « +1 »). ---
  //
  // Même chemin pour un compte ResaMania dont le jeton n'a pas pu être rafraîchi à l'instant
  // (`resaUnavailable`, panne passagère) : sans jeton, pas de lecture live possible, et un
  // planning un peu ancien vaut mieux qu'un écran d'erreur. Seul le bandeau change (`notice`) :
  // le texte habituel — « mis à jour par un membre connecté à ResaMania » — laisserait croire
  // que c'est lui qui ne l'est pas. Le membre garde ses boutons (canBook, cf. /api/auth/me) ;
  // une réservation tentée pendant la panne reçoit un 503 « réessaie dans un instant ».
  if (!session.resa) {
    const snap = await prisma.planningSnapshot.findUnique({ where: { date } });
    // Bandeau de panne (date du cache en heure du club) ; `undefined` hors panne.
    const panne = !session.resaUnavailable
      ? undefined
      : snap
        ? `ResaMania ne répond pas : planning en cache du ${stampFR(snap.updatedAt.toISOString())}. ` +
          "Réessaie dans un instant pour le direct."
        : "ResaMania ne répond pas et ce jour n'est pas encore en cache. Réessaie dans un instant.";
    if (!snap) {
      return NextResponse.json({
        date,
        clubId: "",
        courts: [],
        slots: [],
        cached: true,
        cachedAt: null,
        notice: panne ?? "Planning pas encore chargé par un membre connecté à ResaMania.",
      } satisfies PlanningDay);
    }
    const planning = JSON.parse(snap.payloadJson) as PlanningDay;
    await annotatePlanning(planning, session.userId);
    planning.cached = true;
    planning.cachedAt = snap.updatedAt.toISOString();
    if (panne) planning.notice = panne;
    return NextResponse.json(planning);
  }

  // --- Chemin ResaMania (avec jeton) : fetch live → réconciliation → snapshot → annotation. ---
  const resa = session.resa;
  try {
    // `fresh=1` : le client vient de réserver/annuler et attend de VOIR le résultat. On
    // ignore alors le cache mémoire, qui peut être celui d'une autre instance serverless
    // que celle ayant traité l'écriture (cf. getPlanning).
    const fresh = new URL(req.url).searchParams.get("fresh") === "1";
    const { planning, fetchedAt, fromCache } = await getPlanningWithMeta(
      date,
      resa.accessToken,
      undefined,
      fresh,
    );

    // Réconciliation base ↔ ResaMania (nécessite l'état LIVE) : résas annulées ailleurs
    // ("cancelled") et, derrière le flag `externalBookings`, résas faites directement sur
    // ResaMania (nouvelle ligne `source: "resamania"`). Cf. src/lib/booking-reconcile.ts.
    // UNIQUEMENT sur une photo lue à l'instant : servie par le cache mémoire (≤ 20 s), elle
    // peut précéder une résa faite entre-temps via une AUTRE instance (dont ce cache ne sait
    // rien), que la réconciliation annulerait à tort. Rien n'est perdu à sauter un tour : la
    // prochaine lecture fraîche (≤ 20 s plus tard) réconciliera.
    if (!fromCache) await reconcilePlanningWithBookings(planning, date, fetchedAt);

    // Snapshot BRUT (avant annotation) → sert les comptes « email seul » sans jeton.
    // Écriture CONDITIONNELLE : on ne réécrit que si le planning a changé (une lecture,
    // moins chère qu'une écriture, évite d'écrire le même gros JSON à chaque affichage —
    // encore plus efficace avec le cache planning, qui renvoie un payload identique).
    const payloadJson = JSON.stringify(planning);
    const prevSnap = await prisma.planningSnapshot.findUnique({
      where: { date },
      select: { payloadJson: true },
    });
    if (!prevSnap || prevSnap.payloadJson !== payloadJson) {
      await prisma.planningSnapshot.upsert({
        where: { date },
        update: { payloadJson, updatedById: session.userId },
        create: { date, payloadJson, updatedById: session.userId },
      });
    }

    // Annotation (qui a réservé + présences) — partagée avec le chemin cache.
    await annotatePlanning(planning, session.userId);

    return NextResponse.json(planning);
  } catch (e) {
    // On journalise le détail amont côté serveur mais on ne le renvoie PAS au client
    // (le message ResaMania brut pourrait fuiter des infos d'implémentation).
    console.error("[planning] échec amont:", e);
    return NextResponse.json({ error: "Planning momentanément indisponible" }, { status: 502 });
  }
}
