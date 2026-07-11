import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { FEATURE_TOURNAMENT } from "@/lib/features";
import { materializeFinals } from "@/lib/tournament-db";

export const runtime = "nodejs";

// POST /api/tournaments/{id}/finals : génère la PHASE FINALE d'un pools_bracket (un tableau
// par rang de poule) une fois toutes les poules terminées. Créateur seulement. Les
// participants sont figés au clic à partir des classements de poules du moment.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!FEATURE_TOURNAMENT) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const { id } = await params;
  const t = await prisma.tournament.findUnique({
    where: { id },
    select: { createdById: true, format: true },
  });
  if (!t) {
    return NextResponse.json({ error: "Tournoi introuvable" }, { status: 404 });
  }
  if (t.createdById !== session.userId) {
    return NextResponse.json(
      { error: "Seul le créateur peut générer la phase finale" },
      { status: 403 },
    );
  }
  if (t.format !== "pools_bracket") {
    return NextResponse.json({ error: "Ce tournoi n'a pas de phase finale" }, { status: 400 });
  }

  try {
    const tiers = await prisma.$transaction((tx) => materializeFinals(tx, id));
    return NextResponse.json({ ok: true, tiers });
  } catch (e) {
    // Erreurs métier de materializeFinals (poules non terminées, déjà générée…).
    return NextResponse.json({ error: (e as Error).message }, { status: 409 });
  }
}
