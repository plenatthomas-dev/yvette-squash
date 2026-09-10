import { NextRequest, NextResponse } from "next/server";
import { requireInterclubMember } from "@/lib/interclub-access";
import { prisma } from "@/lib/db";
import { mergeOpponents, opponentTeams } from "@/lib/interclub-opponents";
import { MAX_RENCONTRES } from "@/lib/interclub-opponents-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/interclub/opponents?teamId=…
//
// LES ÉQUIPES ET LES JOUEURS D'EN FACE QU'ON CONNAÎT DÉJÀ — de quoi remplir deux menus, pour
// que composer une rencontre ne dépende plus d'une orthographe retapée chaque fois.
//
// N'INTERROGE PAS LA FÉDÉRATION. Tout vient de nos propres rencontres passées : les noms saisis
// (`InterclubMatch.awayName`) et, quand un capitaine a vérifié, l'identité fédérale confirmée
// que porte son rapport (`InterclubOfficial.checkJson`). La liste s'enrichit donc d'elle-même,
// rencontre après rencontre, sans un appel de plus.
//
// OUVERT À TOUT MEMBRE, comme la composition qu'elle sert : c'est `requireInterclubMember` et
// non le contrôle capitaine — composer reste ouvert à tous (cf. docs/interclub.md).

// La PROFONDEUR est celle de `loadKnownOpponents`, importée et non recopiée : ce que ce menu
// propose doit être exactement ce que la garde de composition sait situer. Deux profondeurs
// différentes offriraient un joueur que le refus ne saurait pas placer — ou l'inverse.

export async function GET(req: NextRequest) {
  const access = await requireInterclubMember(req);
  if (!access.ok) return access.response;

  const teamId = req.nextUrl.searchParams.get("teamId") || undefined;

  const rencontres = await prisma.interclub.findMany({
    where: teamId ? { teamId } : {},
    // Croissant : `mergeOpponents` retient le nom LE PLUS RÉCENT, ce qui n'a de sens que si les
    // rencontres arrivent dans l'ordre. À l'envers, la première orthographe l'emporterait —
    // exactement celle qu'une correction ultérieure était censée remplacer.
    orderBy: { date: "asc" },
    take: MAX_RENCONTRES,
    select: {
      opponent: true,
      matches: { select: { awayName: true } },
      official: { select: { checkJson: true } },
    },
  });

  const sources = rencontres.map((r) => ({
    opponent: r.opponent,
    matches: r.matches,
    checkJson: r.official?.checkJson ?? null,
  }));

  return NextResponse.json({
    teams: opponentTeams(sources),
    players: mergeOpponents(sources),
  });
}
