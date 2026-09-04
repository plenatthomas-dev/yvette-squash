import { NextRequest, NextResponse } from "next/server";
import { requireInterclubMember } from "@/lib/interclub-access";
import { prisma } from "@/lib/db";
import { playerStats } from "@/lib/interclub-stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/interclub/stats — le palmarès de chaque joueur en interclub.
//
// PUBLIC À TOUS LES MEMBRES, c'est une décision et non un oubli. Un classement de joueurs est
// une donnée personnelle : qui gagne, qui perd, combien de fois. Le club a choisi de l'ouvrir à
// toute l'appli, au même titre que les scores des rencontres, qui sont déjà visibles de tous et
// d'où ces chiffres sont entièrement déduits. Le réserver au joueur et au capitaine aurait
// caché un total dont chacun peut déjà refaire le calcul à la main.
//
// ?teamId filtre sur les rencontres D'UNE ÉQUIPE. Sans lui, tout le club, toutes équipes
// confondues : un joueur qui dépanne en équipe 2 doit retrouver ses matchs quelque part.
//
// ?season filtre sur la saison telle qu'elle est SAISIE sur la rencontre (champ libre) : une
// saison manquante ne peut pas être devinée d'après la date, le championnat étant à cheval sur
// deux années civiles.
export async function GET(req: NextRequest) {
  const access = await requireInterclubMember(req);
  if (!access.ok) return access.response;

  const teamId = req.nextUrl.searchParams.get("teamId") || undefined;
  const season = req.nextUrl.searchParams.get("season") || undefined;

  const matches = await prisma.interclubMatch.findMany({
    where: {
      // Seuls les simples TERMINÉS remontent : `playerStats` refiltre, mais le faire ici évite
      // de charger et de joindre le jeu par jeu de toutes les soirées en cours.
      status: "done",
      interclub: {
        ...(teamId ? { teamId } : {}),
        ...(season ? { season } : {}),
      },
    },
    select: {
      status: true,
      gamesHome: true,
      gamesAway: true,
      homeUserId: true,
      homeGuestId: true,
      homeDisplayName: true,
      games: { select: { pointsHome: true, pointsAway: true } },
    },
  });

  // Les saisons ouvertes au filtre, prises sur les rencontres elles-mêmes plutôt que déduites
  // d'un calendrier : c'est ce qui a été saisi qui fait foi.
  const saisons = await prisma.interclub.findMany({
    where: { season: { not: null }, ...(teamId ? { teamId } : {}) },
    select: { season: true },
    distinct: ["season"],
    orderBy: { season: "desc" },
  });

  const rows = playerStats(
    matches.map((m) => ({
      status: m.status,
      gamesHome: m.gamesHome,
      gamesAway: m.gamesAway,
      homeUserId: m.homeUserId,
      homeGuestId: m.homeGuestId,
      homeDisplayName: m.homeDisplayName,
      games: m.games.map((g) => ({ home: g.pointsHome, away: g.pointsAway })),
    })),
  );

  return NextResponse.json(
    { rows, seasons: saisons.map((s) => s.season).filter((s): s is string => !!s) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
