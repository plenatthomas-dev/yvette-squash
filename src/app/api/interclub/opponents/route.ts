import { NextRequest, NextResponse } from "next/server";
import { requireInterclubMember } from "@/lib/interclub-access";
import { prisma } from "@/lib/db";
import { mergeOpponents, opponentTeams } from "@/lib/interclub-opponents";
import { MAX_RENCONTRES } from "@/lib/interclub-opponents-db";
import { loadRosters } from "@/lib/interclub-roster-db";

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
    // ⚠️ DÉCROISSANT, PUIS REMIS À L'ENDROIT. `take` s'applique APRÈS le tri : en croissant, il
    // retenait les 40 rencontres LES PLUS ANCIENNES, c'est-à-dire exactement celles dont on n'a
    // plus rien à faire. Passé la quarantième rencontre enregistrée — trois saisons à deux
    // équipes —, le menu et la garde se figeaient sur la première année et la poule EN COURS
    // disparaissait, sans un message : un club qu'on affronte ce soir n'aurait proposé personne.
    //
    // Le `reverse()` n'est pas cosmétique : `mergeOpponents` retient le nom LE PLUS RÉCENT, ce
    // qui n'a de sens que si les rencontres lui arrivent de la plus ancienne à la plus récente.
    orderBy: { date: "desc" },
    take: MAX_RENCONTRES,
    select: {
      opponent: true,
      snOpponentTeamId: true,
      matches: { select: { awayName: true } },
      official: { select: { checkJson: true } },
    },
  });

  // `reverse()` : lues décroissant (pour retenir les PLUS RÉCENTES), rendues croissant — la
  // fusion en dépend pour que « le nom le plus récent l'emporte » veuille dire quelque chose.
  const sources = [...rencontres].reverse().map((r) => ({
    opponent: r.opponent,
    snOpponentTeamId: r.snOpponentTeamId,
    matches: r.matches,
    checkJson: r.official?.checkJson ?? null,
  }));

  // LU, JAMAIS TÉLÉCHARGÉ ICI. Cette route s'ouvre à chaque composition : y glisser une requête
  // fédérale ferait payer à squashnet le fait qu'un capitaine ouvre un menu. Le
  // rafraîchissement est un geste explicite, ailleurs (`POST /api/interclub/opponents/refresh`).
  const rosters = await loadRosters(
    sources.map((s) => s.snOpponentTeamId).filter((v): v is string => !!v),
  );

  return NextResponse.json({
    teams: opponentTeams(sources),
    players: mergeOpponents(sources, rosters),
  });
}
