import { NextRequest, NextResponse } from "next/server";
import { getPlanning } from "@/lib/resamania/client";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { annotatePlanning } from "@/lib/planning-annotate";
import { reconcilePlanningWithBookings } from "@/lib/booking-reconcile";
import type { PlanningDay } from "@/lib/resamania/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/planning?date=YYYY-MM-DD
export async function GET(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const date =
    new URL(req.url).searchParams.get("date") ??
    new Date().toISOString().slice(0, 10);

  // --- Compte « email seul » (sans jeton ResaMania) : on sert le dernier snapshot du
  //     planning, ré-annoté en direct (présences à jour, dont son propre « +1 »). ---
  if (!session.resa) {
    const snap = await prisma.planningSnapshot.findUnique({ where: { date } });
    if (!snap) {
      return NextResponse.json({
        date,
        clubId: "",
        courts: [],
        slots: [],
        cached: true,
        cachedAt: null,
        notice: "Planning pas encore chargé par un membre connecté à ResaMania.",
      } satisfies PlanningDay);
    }
    const planning = JSON.parse(snap.payloadJson) as PlanningDay;
    await annotatePlanning(planning, session.userId);
    planning.cached = true;
    planning.cachedAt = snap.updatedAt.toISOString();
    return NextResponse.json(planning);
  }

  // --- Chemin ResaMania (avec jeton) : fetch live → réconciliation → snapshot → annotation. ---
  const resa = session.resa;
  try {
    // `fresh=1` : le client vient de réserver/annuler et attend de VOIR le résultat. On
    // ignore alors le cache mémoire, qui peut être celui d'une autre instance serverless
    // que celle ayant traité l'écriture (cf. getPlanning).
    const fresh = new URL(req.url).searchParams.get("fresh") === "1";
    const planning = await getPlanning(date, resa.accessToken, undefined, fresh);

    // Réconciliation base ↔ ResaMania (nécessite l'état LIVE) : résas annulées ailleurs
    // ("cancelled") et, derrière le flag `externalBookings`, résas faites directement sur
    // ResaMania (nouvelle ligne `source: "resamania"`). Cf. src/lib/booking-reconcile.ts.
    await reconcilePlanningWithBookings(planning, date);

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
