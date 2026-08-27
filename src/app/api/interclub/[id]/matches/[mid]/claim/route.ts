import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { getFeatures } from "@/lib/features-server";
import { scorerIsStale } from "@/lib/interclub-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Erreur métier levée DANS la transaction : annule tout, puis se traduit en réponse HTTP. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// POST /api/interclub/{id}/matches/{mid}/claim : prendre le marquage d'un match.
//
// Un seul marqueur à la fois — deux personnes qui comptent le même match en parallèle
// produiraient deux scores divergents, et rien ne permettrait de trancher. La prise se
// PÉRIME toutefois (cf. SCORER_STALE_MS) : sans cela, un téléphone à plat gèlerait le match
// pour toute la soirée sans que personne puisse reprendre.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; mid: string }> },
) {
  if (!(await getFeatures()).interclub) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const { id, mid } = await params;

  const runOnce = () =>
    prisma.$transaction(
      async (tx) => {
        const m = await tx.interclubMatch.findUnique({
          where: { id: mid },
          select: {
            id: true,
            interclubId: true,
            status: true,
            scorerId: true,
            scorerClaimedAt: true,
            updatedAt: true,
          },
        });
        if (!m || m.interclubId !== id) throw new HttpError(404, "Match introuvable");
        if (m.status === "done") throw new HttpError(409, "Ce match est terminé");

        const heldByOther = m.scorerId !== null && m.scorerId !== session.userId;
        if (heldByOther && !scorerIsStale(m.scorerClaimedAt, m.updatedAt)) {
          throw new HttpError(409, "Quelqu'un marque déjà ce match");
        }

        await tx.interclubMatch.update({
          where: { id: mid },
          data: {
            scorerId: session.userId,
            scorerClaimedAt: new Date(),
            status: m.status === "pending" ? "live" : m.status,
          },
        });
        await tx.interclub.update({ where: { id }, data: { status: "live" } });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

  const isConflict = (e: unknown) =>
    e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2034";

  for (let attempt = 0; ; attempt++) {
    try {
      await runOnce();
      return NextResponse.json({ ok: true });
    } catch (e) {
      if (e instanceof HttpError) {
        return NextResponse.json({ error: e.message }, { status: e.status });
      }
      if (isConflict(e) && attempt < 3) continue;
      if (isConflict(e)) {
        return NextResponse.json({ error: "Prise concurrente, réessaie" }, { status: 409 });
      }
      throw e;
    }
  }
}

// DELETE /api/interclub/{id}/matches/{mid}/claim : relâcher le marquage.
// Sans effet si on ne le tenait pas — relâcher deux fois ne doit pas produire d'erreur.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; mid: string }> },
) {
  if (!(await getFeatures()).interclub) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const { id, mid } = await params;

  await prisma.interclubMatch.updateMany({
    where: { id: mid, interclubId: id, scorerId: session.userId },
    data: { scorerId: null, scorerClaimedAt: null },
  });
  return NextResponse.json({ ok: true });
}
