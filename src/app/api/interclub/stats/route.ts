import { NextRequest, NextResponse } from "next/server";
import { requireInterclubMember } from "@/lib/interclub-access";
import { prisma } from "@/lib/db";
import { todayISO } from "@/lib/interclub-gate";
import { loadRosters } from "@/lib/interclub-roster-db";
import {
  identityResolver,
  lireCote,
  lireFeuille,
  playerStats,
  type AppPlayer,
  type OfficialFixture,
} from "@/lib/interclub-stats";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/interclub/stats — le palmarès de chaque joueur en interclub.
//
// CALCULÉ SUR LES FEUILLES DE MATCH OFFICIELLES (`Interclub.snSheetJson`), pas sur nos relevés :
// une soirée que personne n'a marquée dans l'appli compte quand même, puisque la ligue l'a
// publiée. Les feuilles sont relues avec le classement de poule (cf. `interclub-sheets.ts`) ;
// cette route n'appelle jamais squashnet.
//
// PUBLIC À TOUS LES MEMBRES, c'est une décision et non un oubli. Un classement de joueurs est
// une donnée personnelle : qui gagne, qui perd, combien de fois. Le club a choisi de l'ouvrir à
// toute l'appli, au même titre que les scores des rencontres — et la feuille d'où ces chiffres
// sont déduits est de toute façon publique sur squashnet.
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
  const filtre = { ...(teamId ? { teamId } : {}), ...(season ? { season } : {}) };

  const [rencontres, saisons, membres, invites, equipes] = await Promise.all([
    // Toutes les rencontres PASSÉES du filtre, feuille ou non : celles qui n'en ont pas encore
    // sont comptées à part (`pending`), pour que l'écran dise qu'il en manque au lieu de laisser
    // croire que le palmarès est complet.
    prisma.interclub.findMany({
      // Une borne qu'on n'atteint pas : une dizaine de rencontres par équipe et par saison.
      take: 5_000,
      where: {
        ...filtre,
        date: { lt: todayISO() },
        OR: [{ dateConfirmed: true }, { status: { not: "scheduled" } }],
      },
      select: {
        snSheetJson: true,
        snSheetSide: true,
        snSheetAt: true,
        // De quoi situer chaque match dans la fenêtre d'un joueur (cf. `StatMatch`).
        date: true,
        opponent: true,
        team: { select: { name: true } },
      },
    }),
    // Les saisons ouvertes au filtre, prises sur les rencontres elles-mêmes plutôt que déduites
    // d'un calendrier : c'est ce qui a été saisi qui fait foi.
    prisma.interclub.findMany({
      where: { season: { not: null }, ...(teamId ? { teamId } : {}) },
      select: { season: true },
      distinct: ["season"],
      orderBy: { season: "desc" },
    }),
    // Qui la feuille peut désigner chez nous. Les comptes désactivés RESTENT : leurs matchs ont
    // été joués, et ils s'afficheraient sinon sous leur nom fédéral.
    prisma.user.findMany({
      where: { OR: [{ teamId: { not: null } }, { snLicence: { not: null } }] },
      select: {
        id: true,
        displayName: true,
        nickname: true,
        snLicence: true,
        squashnetGivenName: true,
        squashnetFamilyName: true,
      },
    }),
    prisma.interclubGuest.findMany({ select: { id: true, name: true, snLicence: true } }),
    prisma.interclubTeam.findMany({ select: { snTeamId: true } }),
  ]);

  const players: AppPlayer[] = [
    ...membres.map((u) => ({
      kind: "member" as const,
      id: u.id,
      name: u.nickname ?? u.displayName,
      licence: u.snLicence,
      altNames: [
        u.displayName,
        [u.squashnetFamilyName, u.squashnetGivenName].filter(Boolean).join(" "),
      ].filter(Boolean),
    })),
    ...invites.map((g) => ({ kind: "guest" as const, id: g.id, name: g.name, licence: g.snLicence })),
  ];
  // Nos fiches d'équipe fédérales : c'est elles qui relient un nom de feuille à une licence.
  const fiches = await loadRosters(equipes.map((e) => e.snTeamId).filter((v): v is string => !!v));
  const federal = [...fiches.values()].flatMap((r) => r.players);

  const officielles: OfficialFixture[] = [];
  let pending = 0;
  let sheetsAt: Date | null = null;
  for (const r of rencontres) {
    const sheet = lireFeuille(r.snSheetJson);
    const side = lireCote(r.snSheetSide);
    if (!sheet || !side) {
      pending += 1;
      continue;
    }
    officielles.push({
      sheet,
      side,
      meta: { date: r.date, teamName: r.team.name, opponent: r.opponent },
    });
    if (r.snSheetAt && (!sheetsAt || r.snSheetAt > sheetsAt)) sheetsAt = r.snSheetAt;
  }

  const rows = playerStats(officielles, identityResolver(players, federal));

  return NextResponse.json(
    {
      rows,
      seasons: saisons.map((s) => s.season).filter((s): s is string => !!s),
      /** Rencontres jouées dont la feuille officielle n'est pas (encore) exploitable. */
      pending,
      /** Dernière relecture d'une feuille, pour dater le palmarès. */
      sheetsAt: sheetsAt?.toISOString() ?? null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
