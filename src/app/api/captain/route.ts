import { NextRequest, NextResponse } from "next/server";
import { requireCaptain } from "@/lib/captain-access";
import { prisma } from "@/lib/db";
import { countProblems, lireRapport } from "@/lib/captain-check";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/captain
//
// LES RENCONTRES DONT CE CAPITAINE RÉPOND, et où en est leur vérification.
//
// Ne rend QUE ses équipes (cf. `requireCaptain`) — un capitaine n'a rien à faire sur les
// rencontres d'en face, et son accès fédéral ne les couvre pas davantage. Un admin, lui, voit
// tout : c'est le filet du soir où le capitaine est injoignable et où la ligue attend un score.
//
// N'INTERROGE JAMAIS SQUASHNET : cette route sert une liste, elle doit s'ouvrir instantanément.
// La vérification, elle, coûte huit recherches fédérales et se déclenche à la demande
// (`POST /api/captain/check/{id}`).

/** Profondeur de la liste. Une saison de championnat en compte cinq à sept. */
const MAX_RENCONTRES = 40;

export async function GET(req: NextRequest) {
  const access = await requireCaptain(req);
  if (!access.ok) return access.response;
  const { teamIds, isAdmin } = access;

  const teams = await prisma.interclubTeam.findMany({
    // Un admin qui n'est capitaine de rien a `teamIds` vide : sans ce cas, il verrait une page
    // vide là où il est précisément là pour dépanner.
    where: isAdmin ? {} : { id: { in: teamIds } },
    select: { id: true, name: true, snTeamId: true },
    orderBy: { order: "asc" },
  });
  const visibles = teams.map((t) => t.id);

  // LE NOM FÉDÉRAL DE NOS ÉQUIPES — « Yvette 1 », et non « Équipe 1 ».
  //
  // C'est celui que la ligue emploie, donc celui qui se lit à côté de « Verrieres 3 » sans
  // qu'on ait à traduire. Et il DISTINGUE DEUX ÉQUIPES, ce qui devient nécessaire dès qu'on en
  // aligne deux : « nous » ne dit plus laquelle.
  //
  // Lu dans le cache des fiches d'équipe, qui porte aussi bien les nôtres que celles d'en face
  // (une fiche est une fiche). Il s'y range tout seul : la lecture de la feuille officielle va
  // chercher la fiche de notre équipe pour son `tieid`, et la range au passage. Tant qu'aucune
  // vérification n'a eu lieu, la ligne n'existe pas — d'où le repli sur notre nom interne.
  const ancrees = teams.map((t) => t.snTeamId).filter((v): v is string => !!v);
  const fiches = ancrees.length
    ? await prisma.squashnetTeamRoster.findMany({
        where: { snTeamId: { in: ancrees } },
        select: { snTeamId: true, name: true },
      })
    : [];
  const nomFederal = new Map(fiches.map((f) => [f.snTeamId, f.name]));

  const fixtures = await prisma.interclub.findMany({
    where: { teamId: { in: visibles } },
    // Les plus RÉCENTES d'abord : c'est la rencontre de jeudi dernier qu'on vient saisir, pas
    // celle d'octobre. L'écran n'a pas de tri, cet ordre EST le tri.
    orderBy: { date: "desc" },
    take: MAX_RENCONTRES,
    select: {
      id: true,
      date: true,
      time: true,
      round: true,
      opponent: true,
      home: true,
      status: true,
      teamId: true,
      matchCount: true,
      official: { select: { checkedAt: true, checkJson: true } },
    },
  });

  const teamName = new Map(teams.map((t) => [t.id, t.name]));
  const fedName = new Map(
    teams.map((t) => [t.id, (t.snTeamId ? nomFederal.get(t.snTeamId) : null) ?? null]),
  );
  return NextResponse.json({
    // `snTeamId` ne SORT PAS : il sert à retrouver la fiche fédérale juste au-dessus, l'écran
    // n'en fait rien. Une réponse dit ce qu'elle sert, pas ce que la requête a ramené.
    teams: teams.map((t) => ({ id: t.id, name: t.name })),
    fixtures: fixtures.map((f) => {
      // Le rapport n'est PAS renvoyé ici, seulement son résumé : la liste n'en affiche que la
      // pastille, et servir quarante rapports complets pour quarante pastilles serait payer la
      // page entière pour ce qu'on ouvre une fois.
      const rapport = lireRapport(f.official?.checkJson ?? null);
      return {
        id: f.id,
        date: f.date,
        time: f.time,
        round: f.round,
        opponent: f.opponent,
        home: f.home,
        status: f.status,
        teamId: f.teamId,
        teamName: teamName.get(f.teamId) ?? null,
        /** Le nom que la LIGUE donne à notre équipe (« Yvette 1 »). Null si sa fiche n'est pas
            encore en cache — l'écran retombe alors sur le nom interne. */
        teamFedName: fedName.get(f.teamId) ?? null,
        matchCount: f.matchCount,
        checkedAt: f.official?.checkedAt?.toISOString() ?? null,
        // `null` = jamais vérifiée, ou rapport d'un format qu'on ne sait plus lire. Les deux se
        // rattrapent pareil (relancer la vérification), donc ils se disent pareil.
        problems: rapport ? countProblems(rapport) : null,
      };
    }),
  });
}
