import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { getFeatures } from "@/lib/features-server";
import { httpErrorResponse, serializableTransaction } from "@/lib/http-tx";
import { materializeFinals } from "@/lib/tournament-db";

export const runtime = "nodejs";

// POST /api/tournaments/{id}/finals : génère la PHASE FINALE d'un pools_bracket (un tableau
// par rang de poule) une fois toutes les poules terminées. Créateur seulement. Les
// participants sont figés au clic à partir des classements de poules du moment.
//
// La garde « phase finale déjà générée » de `materializeFinals` est un lire-puis-écrire : elle
// compte les matchs `tier != null`, n'en trouve aucun, puis en insère. En isolation ordinaire,
// deux clics simultanés la passent tous les deux — mesuré sur vraie base (cf.
// `tournament-generate.pg.test.ts`) : 8 matchs finaux au lieu de 4, soit deux « finales des
// 1ers » entre les mêmes joueurs, deux vainqueurs possibles, et un champion tiré au sort par
// l'ordre de lecture. D'où Serializable : Postgres voit l'insertion tomber dans l'ensemble que
// l'autre transaction vient de lire, et en annule une (40001), que la boucle rejoue — le rejeu
// trouve alors la phase finale déjà là et sort proprement en 409.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getFeatures()).tournament) {
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
    const tiers = await serializableTransaction(
      (tx) => materializeFinals(tx, id),
      "Génération concurrente, réessaie",
    );
    return NextResponse.json({ ok: true, tiers });
  } catch (e) {
    // Épuisement des réessais (409 déjà formé) : `serializableTransaction` le rend en
    // `HttpError`, qui porte son propre statut.
    const res = httpErrorResponse(e);
    if (res) return res;
    // Erreurs métier de materializeFinals (poules non terminées, déjà générée…) : messages
    // contrôlés (littéraux français) → on peut les renvoyer. Une erreur DB inattendue, elle,
    // reste générique côté client et n'est journalisée qu'ici.
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      console.error("[finals] erreur DB:", e);
      return NextResponse.json({ error: "Génération impossible pour le moment" }, { status: 500 });
    }
    return NextResponse.json({ error: (e as Error).message }, { status: 409 });
  }
}
