import { NextRequest, NextResponse } from "next/server";
import { requireCaptainOf } from "@/lib/captain-access";
import { prisma } from "@/lib/db";
import { getLatestMonth, searchRanking, type RankingRow } from "@/lib/squashnet/client";
import { YVETTE_CLUB } from "@/lib/squashnet/match";
import {
  checkAwayOrder,
  checkPlayer,
  checkScore,
  checkTie,
  lireRapport,
  queryOf,
  type CheckReport,
  type MatchInput,
  type PlayerCheck,
} from "@/lib/captain-check";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET  /api/captain/check/{id} — relit le dernier rapport, sans toucher à squashnet.
// POST /api/captain/check/{id} — REFAIT la vérification, et la range.
//
// DEUX VERBES, ET LA DIFFÉRENCE EST LE COÛT. Relire est gratuit et instantané ; vérifier appelle
// la fédération jusqu'à huit fois. Servir les deux sous un GET ferait payer ce prix à chaque
// ouverture d'écran, et à quelqu'un qui ne fait que relire son rapport de la veille.
//
// LE DÉBIT, ET POURQUOI IL EST MÉNAGÉ. Une rencontre = quatre simples × deux joueurs. On
// mémoïse par TERME DE RECHERCHE (le nom de famille) — deux joueurs homonymes partagent la
// réponse — et on espace les appels, exactement comme le remplissage de l'historique
// (`squashnet/backfill.ts`). squashnet est un site associatif qui ne nous doit rien : rester
// invisible chez eux est la condition pour que tout ceci continue d'exister.

/**
 * Délai entre deux appels. Plus court que celui du script de remplissage (1,1 s) : ici le
 * capitaine attend devant son écran et il y a huit appels au plus, pas neuf cents.
 */
const DELAI_MS = 600;

const dodo = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Le club attendu pour ce joueur : le nôtre, ou celui d'en face. */
const clubAttendu = (side: "home" | "away", opponent: string) =>
  side === "home" ? YVETTE_CLUB : opponent;

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const fixture = await prisma.interclub.findUnique({
    where: { id },
    select: { teamId: true, official: { select: { checkJson: true } } },
  });
  // L'accès se contrôle sur l'ÉQUIPE de la rencontre, donc il faut d'abord la lire. Une
  // rencontre inconnue sort en 404 sans rien révéler de plus.
  if (!fixture) return NextResponse.json({ error: "Rencontre introuvable" }, { status: 404 });
  const access = await requireCaptainOf(req, fixture.teamId);
  if (!access.ok) return access.response;

  return NextResponse.json({ report: lireRapport(fixture.official?.checkJson ?? null) });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const fixture = await prisma.interclub.findUnique({
    where: { id },
    select: {
      teamId: true,
      opponent: true,
      matchCount: true,
      bestOf: true,
      matches: {
        orderBy: { order: "asc" },
        select: {
          order: true,
          homeDisplayName: true,
          awayName: true,
          games: { orderBy: { number: "asc" }, select: { pointsHome: true, pointsAway: true } },
        },
      },
    },
  });
  if (!fixture) return NextResponse.json({ error: "Rencontre introuvable" }, { status: 404 });
  const access = await requireCaptainOf(req, fixture.teamId);
  if (!access.ok) return access.response;

  // --- Les scores : purs, immédiats, aucun réseau -------------------------
  const entrees: MatchInput[] = fixture.matches.map((m) => ({
    order: m.order,
    homeDisplayName: m.homeDisplayName,
    awayName: m.awayName,
    // `bestOf` vit sur la RENCONTRE, pas sur le simple : le format est celui de la division.
    bestOf: fixture.bestOf,
    games: m.games.map((g) => ({ home: g.pointsHome, away: g.pointsAway })),
  }));
  const scores = entrees.map(checkScore);
  const tie = checkTie(scores, fixture.matchCount);

  // --- Les noms : c'est là que le réseau entre en jeu ---------------------
  //
  // LA PÉRIODE EST LUE UNE SEULE FOIS. `searchRanking(nom)` sans mois va la chercher lui-même,
  // ce qui doublerait le nombre d'appels — seize au lieu de huit, pour une valeur identique
  // huit fois de suite.
  let month: string | null;
  try {
    month = await getLatestMonth();
  } catch {
    month = null;
  }
  if (!month) {
    return NextResponse.json(
      { error: "squashnet est injoignable : la vérification des noms est impossible pour l'instant." },
      { status: 502 },
    );
  }

  const memo = new Map<string, RankingRow[] | null>();
  let premier = true;
  /** Une recherche, mémoïsée par terme — l'échec l'est aussi (cf. `backfill.rechercher`). */
  async function lignes(name: string): Promise<RankingRow[] | null> {
    const query = queryOf(name);
    const cached = memo.get(query);
    if (cached !== undefined) return cached;
    // L'attente PRÉCÈDE l'appel plutôt qu'elle ne le suit : le dernier joueur du lot ne fait pas
    // patienter une demi-seconde pour rien avant de rendre la main.
    if (!premier) await dodo(DELAI_MS);
    premier = false;
    let rows: RankingRow[] | null;
    try {
      rows = await searchRanking(query, { month: month as string });
    } catch {
      rows = null;
    }
    memo.set(query, rows);
    return rows;
  }

  const players: PlayerCheck[] = [];
  for (const m of entrees) {
    for (const side of ["home", "away"] as const) {
      const name = side === "home" ? m.homeDisplayName : m.awayName;
      const rows = await lignes(name);
      // squashnet muet sur CE nom : on ne conclut rien plutôt que d'annoncer « introuvable »,
      // qui enverrait corriger une orthographe parfaitement juste.
      if (rows === null) {
        players.push({
          order: m.order,
          side,
          name,
          verdict: "unknown",
          fedName: null,
          clt: null,
          rangM: null,
          licence: null,
          club: null,
          hint: "squashnet n'a pas répondu pour ce nom. Relance la vérification dans un moment.",
        });
        continue;
      }
      players.push(checkPlayer(m.order, side, name, rows, clubAttendu(side, fixture.opponent)));
    }
  }

  const report: CheckReport = {
    checkedAt: new Date().toISOString(),
    players,
    scores,
    tie,
    // L'ordre d'en face se déduit des joueurs qu'on vient de rapprocher — aucun appel de plus.
    awayOrder: checkAwayOrder(players),
  };

  // Une rencontre, un rapport : relancer CORRIGE au lieu d'empiler. L'écran n'a donc jamais à
  // choisir entre deux versions, et le rapport affiché est toujours le dernier connu.
  const data = { checkedAt: new Date(report.checkedAt), checkJson: JSON.stringify(report) };
  await prisma.interclubOfficial.upsert({
    where: { interclubId: id },
    update: data,
    create: { interclubId: id, ...data },
  });

  return NextResponse.json({ report });
}
