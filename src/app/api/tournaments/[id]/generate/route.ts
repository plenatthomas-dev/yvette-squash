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
  if (kind !== "pools" && kind !== "bracket" && kind !== "pools_bracket") {
    return NextResponse.json({ error: "Formule non prise en charge" }, { status: 400 });
  }

  const n = tournament.players.length;
  const players = [...tournament.players]
    .sort((a, b) => (a.seed ?? 0) - (b.seed ?? 0))
    .map((p) => ({ id: p.id, seed: p.seed ?? 0 }));

  // poolSizes : requis pour « poules » ET « poules + tableau final » (qui matérialise d'abord
  // les mêmes poules). Fournies par le client, sinon reprises de la meilleure proposition.
  let poolSizes: number[] = [];
  if (kind === "pools" || kind === "pools_bracket") {
    const given = (body as { poolSizes?: unknown }).poolSizes;
    if (Array.isArray(given) && given.every((x) => Number.isInteger(x) && x >= 2)) {
      poolSizes = given as number[];
    } else {
      const best = proposeFormats(n, tournament.targetMatches, { courts: tournament.courts }).find(
        (p) => p.kind === "pools",
      );
      poolSizes = best?.poolSizes ?? [n];
    }
    // `materialize` répartit TOUJOURS en poules équilibrées (snakeGroups n'utilise que le
    // NOMBRE de poules) : on rejette donc un découpage déséquilibré plutôt que de l'accepter
    // puis de l'ignorer en silence. Valide = bon total ET tailles à ±1 les unes des autres.
    const unbalanced = Math.max(...poolSizes) - Math.min(...poolSizes) > 1;
    if (poolSizes.reduce((s, x) => s + x, 0) !== n || unbalanced) {
      return NextResponse.json({ error: "Répartition en poules invalide" }, { status: 400 });
    }
  }

  await prisma.$transaction(async (tx) => {
    await materialize(tx, id, kind, players, poolSizes);
    await tx.tournament.update({ where: { id }, data: { status: "running", format: kind } });
  });

  return NextResponse.json({ ok: true });
}
