import { NextRequest, NextResponse } from "next/server";
import { requireInterclubMember } from "@/lib/interclub-access";
import { prisma } from "@/lib/db";
import { MAX_RENCONTRES } from "@/lib/interclub-opponents-db";
import { refreshRosters } from "@/lib/interclub-roster-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Une requête fédérale par équipe, espacées : cinq équipes de poule tiennent en quatre
// secondes, mais le défaut de la plateforme ne les couvrirait pas toutes si une répond mal.
export const maxDuration = 60;

// POST /api/interclub/opponents/refresh?teamId=…[&force=1]
//
// VA CHERCHER CHEZ LA LIGUE LES JOUEURS INSCRITS DANS LES ÉQUIPES QU'ON AFFRONTE.
//
// POURQUOI C'EST UN GESTE À PART, et pas une lecture de plus dans le menu :
//
//  * ça COÛTE. Une requête par équipe, espacées de 800 ms pour rester invisibles chez eux —
//    squashnet est un site associatif qui ne nous doit rien. Glisser ça dans la route du menu
//    ferait payer ce prix à chaque ouverture d'un sélecteur d'adversaire ;
//  * ça ATTEND. Quatre à cinq secondes sur une poule complète, là où un menu doit s'ouvrir tout
//    de suite.
//
// C'est le même arbitrage qu'`InterclubOfficial` : `GET` relit ce qu'on a, `POST` refait. Et
// c'est le même que le classement de poule (`snStandingsJson`) — une donnée lente, captée une
// fois, relue souvent.
//
// OUVERT À TOUT MEMBRE, comme le menu qu'elle alimente et comme la composition qu'elle sert :
// c'est `requireInterclubMember` et non le contrôle capitaine. Composer une rencontre reste
// ouvert à tous (cf. docs/interclub.md), et cette route ne fait qu'aller lire une page publique.
//
// ⚠️ N'ÉCRIT RIEN SUR NOS RENCONTRES. Elle remplit un cache d'équipes fédérales, rien d'autre :
// aucune composition, aucun score, aucun nom d'adversaire déjà saisi n'est touché.

export async function POST(req: NextRequest) {
  const access = await requireInterclubMember(req);
  if (!access.ok) return access.response;

  const teamId = req.nextUrl.searchParams.get("teamId") || undefined;
  const force = req.nextUrl.searchParams.get("force") === "1";

  // MÊME PROFONDEUR QUE LE MENU (`MAX_RENCONTRES`), importée et non recopiée : on rafraîchit
  // exactement les équipes que la fusion saura lire. Deux profondeurs différentes iraient
  // chercher un roster que personne n'affiche — ou l'inverse, plus déroutant encore.
  const rencontres = await prisma.interclub.findMany({
    where: teamId ? { teamId } : {},
    orderBy: { date: "asc" },
    take: MAX_RENCONTRES,
    select: { snOpponentTeamId: true },
  });

  const ids = [...new Set(rencontres.map((r) => r.snOpponentTeamId).filter((v): v is string => !!v))];

  // AUCUN IDENTIFIANT N'EST UN CAS NORMAL, PAS UNE PANNE — et il se dit, parce qu'il a un
  // remède précis. Les rencontres importées avant que `snOpponentTeamId` n'existe le portent à
  // NULL, et seul un ré-import du calendrier peut le poser : il est dans le HTML de la ligue,
  // pas dans nos données. Sans ce message, l'écran afficherait « 0 équipe » et laisserait
  // chercher une explication du côté du roster, où il n'y en a pas.
  if (ids.length === 0) {
    return NextResponse.json({
      ok: true,
      teams: [],
      hint:
        "Aucune rencontre ne porte l'identifiant fédéral de son adversaire. " +
        "Réimportez le calendrier de l'équipe (Admin › Interclub › Calendrier › Appliquer) : " +
        "il le pose sur les rencontres existantes.",
    });
  }

  const outcomes = await refreshRosters(ids, { force });

  return NextResponse.json({
    ok: true,
    teams: outcomes,
    fetched: outcomes.filter((o) => o.status === "fetched").length,
    fresh: outcomes.filter((o) => o.status === "fresh").length,
    // `unreadable` et `failed` restent SÉPARÉS jusqu'à l'écran : le premier veut dire que le
    // rendu de squashnet a changé et qu'il faut recapter une fixture, le second qu'ils n'ont
    // pas répondu et qu'il faut réessayer. Les confondre enverrait chercher un bug inexistant.
    unreadable: outcomes.filter((o) => o.status === "unreadable").map((o) => o.snTeamId),
    failed: outcomes.filter((o) => o.status === "failed").map((o) => o.snTeamId),
  });
}
