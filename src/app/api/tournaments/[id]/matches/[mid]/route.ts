import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { getFeatures } from "@/lib/features-server";
import { serializeTournament, tournamentInclude, validScore } from "@/lib/tournament-db";
import { bracketDescendants } from "@/lib/tournament";

export const runtime = "nodejs";

// Erreur métier portant le code HTTP : levée dans la transaction pour annuler (rollback)
// puis retraduite en réponse une fois hors transaction.
class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// PATCH /api/tournaments/{id}/matches/{mid} : saisit un score (en JEUX). Réservé aux
// PARTICIPANTS du tournoi (et au créateur). { score1, score2 } alignés sur p1/p2 renvoyés
// par GET. Pour le tableau, les participants du match sont figés à cet instant (résolus au
// fur et à mesure). Un match déjà joué n'est ré-éditable que par le créateur.
//
// Tout est ATOMIQUE (Serializable + retry P2034) : la relecture de l'état, la saisie, la
// CASCADE d'invalidation (corriger un match de tableau qui change le vainqueur périme les
// matchs en aval) et la mise à jour du statut doivent former un seul tout cohérent.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; mid: string }> },
) {
  if (!(await getFeatures()).tournament) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const { id, mid } = await params;

  const body = await req.json().catch(() => ({}));
  const { score1, score2 } = body as { score1?: unknown; score2?: unknown };
  if (typeof score1 !== "number" || typeof score2 !== "number") {
    return NextResponse.json({ error: "Score invalide" }, { status: 400 });
  }

  const runOnce = () =>
    prisma.$transaction(
      async (tx) => {
        const t = await tx.tournament.findUnique({ where: { id }, include: tournamentInclude });
        if (!t) throw new HttpError(404, "Tournoi introuvable");

        const view = serializeTournament(t, session.userId);
        if (!view.isParticipant && !view.isCreator) {
          throw new HttpError(403, "Réservé aux participants du tournoi");
        }
        if (!validScore(score1, score2, t.bestOf)) {
          const w = Math.ceil(t.bestOf / 2);
          throw new HttpError(400, `Score invalide : un camp à ${w} jeux, l'autre en dessous`);
        }

        // Retrouve le match dans la vue (poules, tableau autonome, ou tableau FINAL d'un
        // pools_bracket) pour ses participants actuels.
        const poolMatch = view.pools?.flatMap((p) => p.matches).find((m) => m.id === mid) ?? null;
        const bracketMatch = view.bracket?.matches.find((m) => m.id === mid) ?? null;
        const finalMatch = view.finals?.flatMap((f) => f.matches).find((m) => m.id === mid) ?? null;
        const m = poolMatch ?? bracketMatch ?? finalMatch;
        if (!m || !m.p1 || !m.p2) {
          throw new HttpError(404, "Match introuvable ou pas encore jouable");
        }
        if (m.status === "bye") {
          throw new HttpError(400, "Ce match est un passage direct (bye)");
        }
        if (m.status === "done" && !view.isCreator) {
          throw new HttpError(409, "Match déjà saisi — seul le créateur peut le corriger");
        }

        const winnerId = score1 > score2 ? m.p1.id : m.p2.id;
        const prevWinnerId = m.winnerId ?? null;

        await tx.match.update({
          where: { id: mid },
          data: {
            // Fige les participants (utile pour le tableau : slots résolus au moment du jeu).
            player1Id: m.p1.id,
            player2Id: m.p2.id,
            score1,
            score2,
            winnerId,
            status: "done",
          },
        });

        // CASCADE : corriger un match de TABLEAU en changeant le vainqueur change les
        // participants de tous les matchs en aval → leurs scores déjà saisis sont caducs.
        // On les remet « à jouer » (participants + scores vidés ; bracketLive les re-résout).
        // Vaut pour le tableau autonome ET chaque tableau FINAL (borné à SON tier).
        if ((bracketMatch || finalMatch) && prevWinnerId && prevWinnerId !== winnerId) {
          const dbMatch = t.matches.find((x) => x.id === mid);
          if (dbMatch) {
            const key = `${dbMatch.branch}-${dbMatch.round}-${dbMatch.slot}`;
            // Taille du tableau + périmètre de reset : tableau autonome = tous les matchs de
            // tableau (tier NULL) et n = tous les joueurs ; tableau final = les matchs du MÊME
            // tier et n = les joueurs réels de ce tier (participants non nuls du 1er tour).
            const tier = dbMatch.tier;
            const bracketN = finalMatch
              ? t.matches
                  .filter((x) => x.tier === tier && (x.round ?? 0) === 0)
                  .reduce((acc, x) => acc + (x.player1Id ? 1 : 0) + (x.player2Id ? 1 : 0), 0)
              : view.players.length;
            const doomed = new Set(bracketDescendants(bracketN, key));
            const toReset = t.matches.filter(
              (x) =>
                (finalMatch ? x.tier === tier : x.phase !== "pool" && x.tier == null) &&
                x.status !== "bye" &&
                doomed.has(`${x.branch}-${x.round}-${x.slot}`) &&
                (x.status === "done" || x.winnerId !== null || x.score1 !== null),
            );
            if (toReset.length) {
              await tx.match.updateMany({
                where: { id: { in: toReset.map((x) => x.id) } },
                data: {
                  status: "pending",
                  winnerId: null,
                  score1: null,
                  score2: null,
                  player1Id: null,
                  player2Id: null,
                },
              });
            }
          }
        }

        // Statut effectif recalculé APRÈS mutation (bidirectionnel : la cascade a pu
        // ré-ouvrir un tournoi terminé). On le fige en base s'il a changé.
        const after = await tx.tournament.findUnique({ where: { id }, include: tournamentInclude });
        if (after) {
          const eff = serializeTournament(after, session.userId).status;
          if (eff !== after.status && (eff === "done" || eff === "running")) {
            await tx.tournament.update({ where: { id }, data: { status: eff } });
          }
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

  // P2034 = conflit de sérialisation → on rejoue quelques fois sur un état à jour.
  const isSerializationConflict = (e: unknown) =>
    e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2034";

  for (let attempt = 0; ; attempt++) {
    try {
      await runOnce();
      return NextResponse.json({ ok: true });
    } catch (e) {
      if (e instanceof HttpError) {
        return NextResponse.json({ error: e.message }, { status: e.status });
      }
      if (isSerializationConflict(e) && attempt < 3) continue;
      if (isSerializationConflict(e)) {
        return NextResponse.json({ error: "Saisie concurrente, réessaie" }, { status: 409 });
      }
      throw e;
    }
  }
}
