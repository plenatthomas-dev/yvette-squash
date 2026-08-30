import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getFeatures } from "@/lib/features-server";
import { HttpError, httpErrorResponse, readJsonBody, serializableTransaction } from "@/lib/http-tx";
import { proposeFormats } from "@/lib/tournament";
import { materialize } from "@/lib/tournament-db";

export const runtime = "nodejs";

// POST /api/tournaments/{id}/generate : fige la formule choisie et crée poules + matchs.
// { kind: "pools" | "bracket" | "pools_bracket", poolSizes?: number[] }. Créateur seulement.
//
// Tout ce qui touche à la base est ATOMIQUE (Serializable + réessai), et c'est la garde
// « Tournoi déjà généré » qui l'exige. Elle lisait `status !== "draft"` HORS transaction, puis
// matérialisait dans une transaction ordinaire : deux clics au même instant — double
// soumission, deux onglets, le créateur sur son téléphone et sur le PC du club — lisaient tous
// deux « brouillon » et matérialisaient tous deux. Mesuré sur vraie base (cf.
// `tournament-generate.pg.test.ts`) : 4 poules au lieu de 2 et 24 matchs au lieu de 12, dès le
// premier essai. Et `Match` n'a aucune contrainte d'unicité : rien en base ne rattrapait le
// doublon. Chaque joueur voyait sa soirée affichée deux fois.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getFeatures()).tournament) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const { id } = await params;

  const body = await readJsonBody(req);
  const kind = body.kind;
  if (kind !== "pools" && kind !== "bracket" && kind !== "pools_bracket") {
    return NextResponse.json({ error: "Formule non prise en charge" }, { status: 400 });
  }

  try {
    await serializableTransaction(async (tx) => {
      const tournament = await tx.tournament.findUnique({
        where: { id },
        include: { players: true },
      });
      if (!tournament) throw new HttpError(404, "Tournoi introuvable");
      if (tournament.createdById !== session.userId) {
        throw new HttpError(403, "Seul le créateur peut générer le tableau");
      }
      if (tournament.status !== "draft") throw new HttpError(409, "Tournoi déjà généré");

      const n = tournament.players.length;
      const players = [...tournament.players]
        .sort((a, b) => (a.seed ?? 0) - (b.seed ?? 0))
        .map((p) => ({ id: p.id, seed: p.seed ?? 0 }));

      // poolSizes : requis pour « poules » ET « poules + tableau final » (qui matérialise
      // d'abord les mêmes poules). Fournies par le client, sinon reprises de la meilleure
      // proposition.
      let poolSizes: number[] = [];
      if (kind === "pools" || kind === "pools_bracket") {
        const given = body.poolSizes;
        if (Array.isArray(given) && given.every((x) => Number.isInteger(x) && x >= 2)) {
          poolSizes = given as number[];
        } else {
          const best = proposeFormats(n, tournament.targetMatches, {
            courts: tournament.courts,
          }).find((p) => p.kind === "pools");
          poolSizes = best?.poolSizes ?? [n];
        }
        // `materialize` répartit TOUJOURS en poules équilibrées (snakeGroups n'utilise que le
        // NOMBRE de poules) : on rejette donc un découpage déséquilibré plutôt que de
        // l'accepter puis de l'ignorer en silence. Valide = bon total ET tailles à ±1.
        const unbalanced = Math.max(...poolSizes) - Math.min(...poolSizes) > 1;
        if (poolSizes.reduce((s, x) => s + x, 0) !== n || unbalanced) {
          throw new HttpError(400, "Répartition en poules invalide");
        }
      }

      await materialize(tx, id, kind, players, poolSizes);
      // Cette écriture sur la LIGNE du tournoi est aussi ce qui fait entrer en collision deux
      // générations simultanées : la seconde échoue en 40001, est rejouée, relit « running »
      // et sort en 409 — au lieu de matérialiser un second jeu de poules.
      await tx.tournament.update({ where: { id }, data: { status: "running", format: kind } });
    }, "Génération concurrente, réessaie");
  } catch (e) {
    const res = httpErrorResponse(e);
    if (res) return res;
    throw e;
  }

  return NextResponse.json({ ok: true });
}
