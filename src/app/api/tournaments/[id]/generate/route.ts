import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { FEATURE_TOURNAMENT } from "@/lib/features";
import { proposeFormats } from "@/lib/tournament";
import { materialize } from "@/lib/tournament-db";

export const runtime = "nodejs";

// POST /api/tournaments/{id}/generate : fige la formule choisie et crée poules + matchs.
// { kind: "pools" | "bracket" | "pools_bracket", poolSizes?: number[] }. Créateur seulement.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!FEATURE_TOURNAMENT) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const { id } = await params;

  const tournament = await prisma.tournament.findUnique({
    where: { id },
    include: { players: true },
  });
  if (!tournament) {
    return NextResponse.json({ error: "Tournoi introuvable" }, { status: 404 });
  }
  if (tournament.createdById !== session.userId) {
    return NextResponse.json({ error: "Seul le créateur peut générer le tableau" }, { status: 403 });
  }
  if (tournament.status !== "draft") {
    return NextResponse.json({ error: "Tournoi déjà généré" }, { status: 409 });
  }

  const body = await req.json().catch(() => ({}));
  const kind = (body as { kind?: unknown }).kind;
  if (kind !== "pools" && kind !== "bracket") {
    // pools_bracket n'est pas encore matérialisable → on refuse proprement.
    return NextResponse.json({ error: "Formule non prise en charge" }, { status: 400 });
  }

  const n = tournament.players.length;
  const players = [...tournament.players]
    .sort((a, b) => (a.seed ?? 0) - (b.seed ?? 0))
    .map((p) => ({ id: p.id, seed: p.seed ?? 0 }));

  // poolSizes : fournies pour les poules, sinon on reprend la meilleure proposition.
  let poolSizes: number[] = [];
  if (kind === "pools") {
    const given = (body as { poolSizes?: unknown }).poolSizes;
    if (Array.isArray(given) && given.every((x) => Number.isInteger(x) && x >= 2)) {
      poolSizes = given as number[];
    } else {
      const best = proposeFormats(n, tournament.targetMatches, { courts: tournament.courts }).find(
        (p) => p.kind === "pools",
      );
      poolSizes = best?.poolSizes ?? [n];
    }
    if (poolSizes.reduce((s, x) => s + x, 0) !== n) {
      return NextResponse.json({ error: "Répartition en poules invalide" }, { status: 400 });
    }
  }

  await prisma.$transaction(async (tx) => {
    await materialize(tx, id, kind, players, poolSizes);
    await tx.tournament.update({ where: { id }, data: { status: "running", format: kind } });
  });

  return NextResponse.json({ ok: true });
}
