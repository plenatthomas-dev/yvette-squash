import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { getFeatures } from "@/lib/features-server";
import { isAdminEmail } from "@/lib/admin";
import {
  isPlayerColor,
  sequenceWinner,
  validGameSequence,
  type GameScore,
} from "@/lib/interclub";
import { derivedStatus, MAX_PLAYER_NAME_LEN } from "@/lib/interclub-db";

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

// PATCH /api/interclub/{id}/matches/{mid} : composition et/ou score d'un simple.
//   { homeUserId?, homeDisplayName?, awayName?, homeColor?, awayColor?,
//     games?: [{ home, away }] }
//
// `games` remplace INTÉGRALEMENT la liste des jeux : c'est une correction de saisie, pas un
// ajout incrémental — on évite ainsi qu'une double soumission crée deux fois le même jeu.
//
// Tout est ATOMIQUE (Serializable + retry P2034) : plusieurs personnes saisissent en parallèle
// un soir de rencontre, et le statut de la rencontre se recale dans la même transaction.
export async function PATCH(
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

  const body = await req.json().catch(() => ({}));
  const { homeUserId, homeDisplayName, awayName, homeColor, awayColor, games } = body as {
    homeUserId?: unknown;
    homeDisplayName?: unknown;
    awayName?: unknown;
    homeColor?: unknown;
    awayColor?: unknown;
    games?: unknown;
  };

  if (!isPlayerColor(homeColor) || !isPlayerColor(awayColor)) {
    return NextResponse.json({ error: "Couleur inconnue" }, { status: 400 });
  }

  // Normalise les jeux avant d'ouvrir la transaction : une saisie invalide ne doit même pas
  // toucher la base.
  let parsedGames: GameScore[] | null = null;
  if (games !== undefined) {
    if (!Array.isArray(games)) {
      return NextResponse.json({ error: "Jeux invalides" }, { status: 400 });
    }
    const out: GameScore[] = [];
    for (const raw of games as unknown[]) {
      const g = raw as Record<string, unknown>;
      const home = Number(g?.home);
      const away = Number(g?.away);
      if (!Number.isInteger(home) || !Number.isInteger(away) || home < 0 || away < 0) {
        return NextResponse.json({ error: "Jeux invalides" }, { status: 400 });
      }
      out.push({ home, away });
    }
    parsedGames = out;
  }

  const isAdmin = async () => {
    const me = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { email: true },
    });
    return isAdminEmail(me?.email);
  };

  const runOnce = () =>
    prisma.$transaction(
      async (tx) => {
        const m = await tx.interclubMatch.findUnique({
          where: { id: mid },
          include: { interclub: { select: { id: true, bestOf: true, matchCount: true, createdById: true } } },
        });
        if (!m || m.interclubId !== id) {
          throw new HttpError(404, "Match introuvable");
        }

        // Un match DÉJÀ saisi n'est modifiable que par ceux qui ont une raison d'y toucher :
        // le créateur de la rencontre, le joueur concerné, le marqueur, ou un admin. Sinon on
        // refuse plutôt que d'écraser silencieusement le travail de quelqu'un d'autre.
        const alreadyScored = m.gamesHome !== null;
        const closeToIt =
          m.interclub.createdById === session.userId ||
          m.homeUserId === session.userId ||
          m.scorerId === session.userId;
        if (alreadyScored && !closeToIt && !(await isAdmin())) {
          throw new HttpError(409, "Score déjà saisi par quelqu'un d'autre");
        }

        if (parsedGames && !validGameSequence(parsedGames, m.interclub.bestOf)) {
          throw new HttpError(400, "Score impossible pour ce format");
        }

        const data: Prisma.InterclubMatchUpdateInput = {};

        if (homeUserId !== undefined) {
          if (homeUserId === null) {
            data.homeUser = { disconnect: true };
          } else if (typeof homeUserId === "string" && homeUserId) {
            const u = await tx.user.findUnique({
              where: { id: homeUserId },
              select: { id: true, displayName: true, nickname: true },
            });
            if (!u) throw new HttpError(400, "Membre inconnu");
            data.homeUser = { connect: { id: u.id } };
            data.homeDisplayName = u.nickname ?? u.displayName;
          } else {
            throw new HttpError(400, "Membre invalide");
          }
        }
        // Nom libre : ne s'applique que si aucun membre n'est explicitement rattaché dans la
        // même requête, sinon le nom du membre (figé juste au-dessus) primerait à tort.
        if (typeof homeDisplayName === "string" && homeDisplayName.trim() && homeUserId === undefined) {
          data.homeDisplayName = homeDisplayName.trim().slice(0, MAX_PLAYER_NAME_LEN);
        }
        if (typeof awayName === "string" && awayName.trim()) {
          data.awayName = awayName.trim().slice(0, MAX_PLAYER_NAME_LEN);
        }
        if (homeColor !== undefined) data.homeColor = (homeColor as string) ?? null;
        if (awayColor !== undefined) data.awayColor = (awayColor as string) ?? null;

        if (parsedGames) {
          const winner = sequenceWinner(parsedGames, m.interclub.bestOf);
          let home = 0;
          let away = 0;
          for (const g of parsedGames) {
            if (g.home > g.away) home += 1;
            else away += 1;
          }
          // Remplacement intégral : on efface avant de réécrire.
          await tx.interclubGame.deleteMany({ where: { matchId: mid } });
          if (parsedGames.length) {
            await tx.interclubGame.createMany({
              data: parsedGames.map((g, i) => ({
                matchId: mid,
                number: i + 1,
                pointsHome: g.home,
                pointsAway: g.away,
                finishedAt: new Date(),
              })),
            });
          }
          data.gamesHome = parsedGames.length ? home : null;
          data.gamesAway = parsedGames.length ? away : null;
          data.status = winner ? "done" : parsedGames.length ? "live" : "pending";
          // Le match n'est plus en cours : la prise de marquage n'a plus lieu d'être.
          if (winner) {
            data.scorer = { disconnect: true };
            data.scorerClaimedAt = null;
            data.liveJson = null;
          }
        }

        await tx.interclubMatch.update({ where: { id: mid }, data });

        // Recale le statut de la rencontre dans la MÊME transaction : sinon la liste peut
        // afficher « en cours » alors que le dernier match vient d'être saisi.
        const siblings = await tx.interclubMatch.findMany({
          where: { interclubId: id },
          select: { gamesHome: true, status: true },
        });
        const eff = derivedStatus(m.interclub.matchCount, siblings);
        await tx.interclub.update({ where: { id }, data: { status: eff } });
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
