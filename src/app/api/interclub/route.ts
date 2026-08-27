import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { getFeatures } from "@/lib/features-server";
import { isColorValue, isValidBestOf, isValidMatchCount, normalizeColor } from "@/lib/interclub";
import {
  fixtureScore,
  derivedStatus,
  MAX_DIVISION_LEN,
  MAX_OPPONENT_LEN,
  MAX_PLAYER_NAME_LEN,
  MAX_SEASON_LEN,
} from "@/lib/interclub-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/interclub -> équipes de l'asso + rencontres (plus récentes d'abord).
// ?limit (défaut 20, max 100), ?teamId pour filtrer sur une équipe.
export async function GET(req: NextRequest) {
  if (!(await getFeatures()).interclub) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const raw = Number(req.nextUrl.searchParams.get("limit"));
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 100) : 20;
  const teamId = req.nextUrl.searchParams.get("teamId") || undefined;

  const [teams, rows] = await Promise.all([
    prisma.interclubTeam.findMany({ orderBy: { order: "asc" }, select: { id: true, name: true } }),
    prisma.interclub.findMany({
      where: teamId ? { teamId } : undefined,
      orderBy: [{ date: "desc" }, { createdAt: "desc" }],
      take: limit + 1,
      include: {
        team: { select: { id: true, name: true } },
        matches: { select: { gamesHome: true, gamesAway: true, status: true } },
      },
    }),
  ]);

  const hasMore = rows.length > limit;
  const fixtures = (hasMore ? rows.slice(0, limit) : rows).map((f) => ({
    id: f.id,
    date: f.date,
    team: f.team,
    opponent: f.opponent,
    home: f.home,
    division: f.division,
    matchCount: f.matchCount,
    status: derivedStatus(f.matchCount, f.matches),
    score: fixtureScore(f.matches),
  }));

  return NextResponse.json({ hasMore, teams, fixtures });
}

// POST /api/interclub : crée une rencontre et ses N simples d'un coup.
// { date, teamId, opponent, home?, season?, division?, matchCount?, bestOf?,
//   matches?: [{ userId? | name?, awayName?, homeColor?, awayColor? }] }
// Ouvert à TOUT membre connecté : dans un club de cette taille, exiger un rôle bloquerait la
// saisie les soirs où le capitaine joue.
export async function POST(req: NextRequest) {
  if (!(await getFeatures()).interclub) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const { date, teamId, opponent, home, season, division, matchCount, bestOf, matches } = body as {
    date?: unknown;
    teamId?: unknown;
    opponent?: unknown;
    home?: unknown;
    season?: unknown;
    division?: unknown;
    matchCount?: unknown;
    bestOf?: unknown;
    matches?: unknown;
  };

  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "Date invalide" }, { status: 400 });
  }
  if (typeof teamId !== "string" || !teamId) {
    return NextResponse.json({ error: "Équipe invalide" }, { status: 400 });
  }
  if (typeof opponent !== "string" || !opponent.trim()) {
    return NextResponse.json({ error: "Nom du club adverse manquant" }, { status: 400 });
  }
  const nb = matchCount === undefined ? 4 : matchCount;
  if (!isValidMatchCount(nb)) {
    return NextResponse.json({ error: "Nombre de matchs invalide" }, { status: 400 });
  }
  const nbBestOf = bestOf === undefined ? 5 : bestOf;
  if (!isValidBestOf(nbBestOf)) {
    return NextResponse.json({ error: "Format invalide (au meilleur des 3 ou des 5)" }, { status: 400 });
  }

  const team = await prisma.interclubTeam.findUnique({ where: { id: teamId } });
  if (!team) {
    return NextResponse.json({ error: "Équipe inconnue" }, { status: 400 });
  }

  // Composition : facultative à la création (on inscrit souvent la rencontre avant de savoir
  // qui joue). Chaque ligne est soit un MEMBRE (userId), soit un nom libre (remplaçant).
  const lines = Array.isArray(matches) ? matches : [];
  if (lines.length > (nb as number)) {
    return NextResponse.json({ error: "Plus de joueurs que de matchs" }, { status: 400 });
  }

  const memberIds = new Set<string>();
  const roster: {
    userId: string | null;
    name: string | null;
    awayName: string;
    homeColor: string | null;
    awayColor: string | null;
  }[] = [];

  for (const raw of lines as unknown[]) {
    if (typeof raw !== "object" || raw === null) {
      return NextResponse.json({ error: "Joueur invalide" }, { status: 400 });
    }
    const l = raw as Record<string, unknown>;
    const uid = l.userId;
    const name = l.name;
    if (!isColorValue(l.homeColor) || !isColorValue(l.awayColor)) {
      return NextResponse.json({ error: "Couleur inconnue" }, { status: 400 });
    }
    const awayName =
      typeof l.awayName === "string" && l.awayName.trim()
        ? l.awayName.trim().slice(0, MAX_PLAYER_NAME_LEN)
        : "À désigner";

    if (typeof uid === "string" && uid) {
      if (memberIds.has(uid)) {
        return NextResponse.json({ error: "Un membre est aligné deux fois" }, { status: 400 });
      }
      memberIds.add(uid);
      roster.push({
        userId: uid,
        name: null,
        awayName,
        homeColor: normalizeColor(l.homeColor),
        awayColor: normalizeColor(l.awayColor),
      });
    } else if (typeof name === "string" && name.trim()) {
      roster.push({
        userId: null,
        name: name.trim().slice(0, MAX_PLAYER_NAME_LEN),
        awayName,
        homeColor: normalizeColor(l.homeColor),
        awayColor: normalizeColor(l.awayColor),
      });
    } else {
      return NextResponse.json({ error: "Joueur invalide" }, { status: 400 });
    }
  }

  // Nom d'affichage FIGÉ à la création : supprimer un compte plus tard ne doit pas effacer
  // qui a joué (même motif que TournamentPlayer).
  const members = memberIds.size
    ? await prisma.user.findMany({
        where: { id: { in: [...memberIds] } },
        select: { id: true, displayName: true, nickname: true },
      })
    : [];
  if (members.length !== memberIds.size) {
    return NextResponse.json({ error: "Membre inconnu" }, { status: 400 });
  }
  const nameOfMember = new Map(members.map((m) => [m.id, m.nickname ?? m.displayName]));

  const created = await prisma.interclub.create({
    data: {
      date,
      teamId,
      opponent: opponent.trim().slice(0, MAX_OPPONENT_LEN),
      home: home === undefined ? true : !!home,
      season: typeof season === "string" && season.trim() ? season.trim().slice(0, MAX_SEASON_LEN) : null,
      division:
        typeof division === "string" && division.trim() ? division.trim().slice(0, MAX_DIVISION_LEN) : null,
      matchCount: nb as number,
      bestOf: nbBestOf as number,
      status: "scheduled",
      createdById: session.userId,
      matches: {
        create: Array.from({ length: nb as number }, (_, i) => {
          const r = roster[i];
          return {
            order: i + 1,
            homeUserId: r?.userId ?? null,
            homeDisplayName: r
              ? (r.userId ? (nameOfMember.get(r.userId) ?? "?") : (r.name ?? "?"))
              : "À désigner",
            awayName: r?.awayName ?? "À désigner",
            homeColor: r?.homeColor ?? null,
            awayColor: r?.awayColor ?? null,
            status: "pending",
          };
        }),
      },
    },
  });

  return NextResponse.json({ id: created.id }, { status: 201 });
}
