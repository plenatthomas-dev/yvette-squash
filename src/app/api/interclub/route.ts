import { NextRequest, NextResponse } from "next/server";
import { requireInterclubMember } from "@/lib/interclub-access";
import { prisma } from "@/lib/db";
import { interclubChanged } from "@/lib/interclub-gate";
import { isColorValue, isValidBestOf, isValidMatchCount, normalizeColor } from "@/lib/interclub";
import {
  fixtureScore,
  derivedStatus,
  MAX_DIVISION_LEN,
  MAX_OPPONENT_LEN,
  MAX_PLAYER_NAME_LEN,
  MAX_SEASON_LEN,
  UNSET_PLAYER,
} from "@/lib/interclub-db";
import { resolveHomePicks, type HomePick, type ResolvedPick } from "@/lib/interclub-roster";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/interclub -> équipes de l'asso + rencontres (plus récentes d'abord).
// ?limit (défaut 20, max 100), ?teamId pour filtrer sur une équipe.
export async function GET(req: NextRequest) {
  const access = await requireInterclubMember(req);
  if (!access.ok) return access.response;

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
//   matches?: [{ userId? | guestId?, awayName?, homeColor?, awayColor? }] }
// Ouvert à TOUT membre connecté : dans un club de cette taille, exiger un rôle bloquerait la
// saisie les soirs où le capitaine joue.
export async function POST(req: NextRequest) {
  const access = await requireInterclubMember(req);
  if (!access.ok) return access.response;
  const { session } = access;

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
  // qui joue). Chaque ligne désigne un joueur DU ROSTER de l'équipe : un membre (`userId`) ou
  // un joueur sans compte (`guestId`, cf. InterclubGuest).
  //
  // ⚠️ Il n'y a plus de nom LIBRE ici. La route en acceptait un, et c'est par là que la règle
  // « seuls les joueurs de l'équipe peuvent être alignés » se contournait : il suffisait de ne
  // pas envoyer d'identifiant. Un joueur hors appli s'inscrit désormais au roster de son équipe
  // depuis l'espace admin, ce qui le rend choisissable sans rouvrir la porte à tout le monde.
  const lines = Array.isArray(matches) ? matches : [];
  if (lines.length > (nb as number)) {
    return NextResponse.json({ error: "Plus de joueurs que de matchs" }, { status: 400 });
  }

  // Validation de forme d'abord, base ensuite : rien ne sert d'interroger Neon pour une ligne
  // dont la couleur est déjà refusée.
  const parsedLines: { pick: HomePick; awayName: string; homeColor: string | null; awayColor: string | null }[] = [];
  for (const raw of lines as unknown[]) {
    if (typeof raw !== "object" || raw === null) {
      return NextResponse.json({ error: "Joueur invalide" }, { status: 400 });
    }
    const l = raw as Record<string, unknown>;
    if (!isColorValue(l.homeColor) || !isColorValue(l.awayColor)) {
      return NextResponse.json({ error: "Couleur inconnue" }, { status: 400 });
    }
    parsedLines.push({
      pick: { userId: l.userId, guestId: l.guestId },
      awayName:
        typeof l.awayName === "string" && l.awayName.trim()
          ? l.awayName.trim().slice(0, MAX_PLAYER_NAME_LEN)
          : UNSET_PLAYER,
      homeColor: normalizeColor(l.homeColor),
      awayColor: normalizeColor(l.awayColor),
    });
  }

  // Le contrôle d'appartenance à l'équipe se fait ici, contre `teamId` lu en base — les mêmes
  // règles que celles qu'emploie le PATCH d'un match, pour que les deux chemins d'écriture ne
  // puissent pas diverger. En DEUX requêtes pour toute la composition, et non une par ligne
  // dans une boucle : les identifiants sont tous connus d'avance, et huit allers-retours Neon
  // sérialisés s'entendent sur un cold start.
  const resolvedAll = await resolveHomePicks(prisma, team.id, parsedLines.map((l) => l.pick));

  const alreadyPicked = new Set<string>();
  const roster: {
    pick: ResolvedPick;
    awayName: string;
    homeColor: string | null;
    awayColor: string | null;
  }[] = [];

  for (const [i, resolved] of resolvedAll.entries()) {
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.error }, { status: 400 });
    }
    const { homeUserId, homeGuestId } = resolved.value;
    const key = homeUserId ? `u:${homeUserId}` : homeGuestId ? `g:${homeGuestId}` : null;
    if (key) {
      if (alreadyPicked.has(key)) {
        return NextResponse.json({ error: "Un joueur est aligné deux fois" }, { status: 400 });
      }
      alreadyPicked.add(key);
    }

    roster.push({
      pick: resolved.value,
      awayName: parsedLines[i].awayName,
      homeColor: parsedLines[i].homeColor,
      awayColor: parsedLines[i].awayColor,
    });
  }

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
            // Nom d'affichage FIGÉ dès la création : supprimer un compte, ou retirer un joueur
            // du roster, ne doit pas effacer qui a joué (même motif que TournamentPlayer).
            homeUserId: r?.pick.homeUserId ?? null,
            homeGuestId: r?.pick.homeGuestId ?? null,
            homeDisplayName: r?.pick.homeDisplayName ?? UNSET_PLAYER,
            awayName: r?.awayName ?? UNSET_PLAYER,
            homeColor: r?.homeColor ?? null,
            awayColor: r?.awayColor ?? null,
            status: "pending",
          };
        }),
      },
    },
  });

  // Une rencontre du jour de plus change ce que voit le bandeau « En direct ».
  interclubChanged();
  return NextResponse.json({ id: created.id }, { status: 201 });
}
