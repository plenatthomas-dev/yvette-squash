import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { FEATURE_TOURNAMENT } from "@/lib/features";
import { proposeFormats, MIN_PLAYERS, MAX_PLAYERS } from "@/lib/tournament";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/tournaments -> liste paginée (plus récents d'abord). ?limit (défaut 20, max 100).
export async function GET(req: NextRequest) {
  if (!FEATURE_TOURNAMENT) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const raw = Number(req.nextUrl.searchParams.get("limit"));
  const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 100) : 20;

  const rows = await prisma.tournament.findMany({
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    include: { _count: { select: { players: true } } },
  });
  const hasMore = rows.length > limit;
  const tournaments = (hasMore ? rows.slice(0, limit) : rows).map((t) => ({
    id: t.id,
    name: t.name,
    date: t.date,
    status: t.status,
    format: t.format,
    playerCount: t._count.players,
  }));
  return NextResponse.json({ hasMore, tournaments });
}

// POST /api/tournaments : crée un tournoi en "draft" avec son roster et renvoie les
// FORMULES proposées. { name?, date, targetMatches, bestOf?, courts?, players:[{userId}|{guestName}] }
export async function POST(req: NextRequest) {
  if (!FEATURE_TOURNAMENT) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  if (!session.resa) {
    return NextResponse.json(
      { error: "Compte email seul : la création de tournoi est réservée aux comptes ResaMania." },
      { status: 403 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const { name, date, targetMatches, bestOf, courts, players } = body as {
    name?: unknown;
    date?: unknown;
    targetMatches?: unknown;
    bestOf?: unknown;
    courts?: unknown;
    players?: unknown;
  };

  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "Date invalide" }, { status: 400 });
  }
  if (targetMatches !== 2 && targetMatches !== 3 && targetMatches !== 4) {
    return NextResponse.json({ error: "Nombre de matchs visé invalide (2, 3 ou 4)" }, { status: 400 });
  }
  const nbBestOf = bestOf === 5 ? 5 : 3;
  const nbCourts = typeof courts === "number" && courts >= 1 && courts <= 8 ? Math.floor(courts) : 2;

  if (!Array.isArray(players) || players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) {
    return NextResponse.json(
      { error: `Il faut de ${MIN_PLAYERS} à ${MAX_PLAYERS} joueurs` },
      { status: 400 },
    );
  }

  // Normalise le roster : membre (userId connu) OU invité (prénom libre non vide).
  const memberIds = new Set<string>();
  const roster: { userId: string | null; guestName: string | null }[] = [];
  for (const p of players as unknown[]) {
    if (typeof p !== "object" || p === null) {
      return NextResponse.json({ error: "Joueur invalide" }, { status: 400 });
    }
    const uid = (p as { userId?: unknown }).userId;
    const guest = (p as { guestName?: unknown }).guestName;
    if (typeof uid === "string" && uid) {
      if (memberIds.has(uid)) {
        return NextResponse.json({ error: "Un membre est en double" }, { status: 400 });
      }
      memberIds.add(uid);
      roster.push({ userId: uid, guestName: null });
    } else if (typeof guest === "string" && guest.trim()) {
      roster.push({ userId: null, guestName: guest.trim().slice(0, 40) });
    } else {
      return NextResponse.json({ error: "Joueur invalide" }, { status: 400 });
    }
  }

  // Vérifie que les membres existent, et récupère leur nom affiché (figé à la création).
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

  const proposals = proposeFormats(roster.length, targetMatches, { courts: nbCourts });

  const created = await prisma.tournament.create({
    data: {
      name: typeof name === "string" && name.trim() ? name.trim().slice(0, 80) : null,
      date,
      createdById: session.userId,
      status: "draft",
      format: proposals[0]?.kind ?? "pools",
      targetMatches,
      bestOf: nbBestOf,
      courts: nbCourts,
      players: {
        create: roster.map((r, i) => ({
          userId: r.userId,
          guestName: r.guestName,
          displayName: r.userId ? (nameOfMember.get(r.userId) ?? "?") : (r.guestName ?? "Invité"),
          seed: i,
        })),
      },
    },
  });

  return NextResponse.json({ id: created.id, proposals }, { status: 201 });
}
