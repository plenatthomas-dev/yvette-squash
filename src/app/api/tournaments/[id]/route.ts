import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { FEATURE_TOURNAMENT } from "@/lib/features";
import { serializeTournament, tournamentInclude } from "@/lib/tournament-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/tournaments/{id} : état complet (poules + classements, ou tableau en direct).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!FEATURE_TOURNAMENT) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const { id } = await params;
  const t = await prisma.tournament.findUnique({ where: { id }, include: tournamentInclude });
  if (!t) {
    return NextResponse.json({ error: "Tournoi introuvable" }, { status: 404 });
  }
  const view = serializeTournament(t, session.userId);
  // Auto-cicatrisation : si le tournoi est en fait terminé mais encore "running" en base
  // (dernier score saisi ailleurs, etc.), on fige le statut pour que la LISTE soit juste.
  if (view.status === "done" && t.status !== "done") {
    await prisma.tournament.update({ where: { id }, data: { status: "done" } }).catch(() => {});
  }
  return NextResponse.json(view);
}

// DELETE /api/tournaments/{id} : créateur seulement (supprime tout en cascade).
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!FEATURE_TOURNAMENT) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const { id } = await params;
  const t = await prisma.tournament.findUnique({ where: { id }, select: { createdById: true } });
  if (!t) {
    return NextResponse.json({ error: "Tournoi introuvable" }, { status: 404 });
  }
  if (t.createdById !== session.userId) {
    return NextResponse.json({ error: "Seul le créateur peut supprimer le tournoi" }, { status: 403 });
  }
  await prisma.tournament.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
