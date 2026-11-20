import { NextRequest, NextResponse } from "next/server";
import { requireInterclubMember } from "@/lib/interclub-access";
import { prisma } from "@/lib/db";
import { refreshTeamStandings, teamsDueForStandings } from "@/lib/interclub-standings";
import { refreshTeamSheets } from "@/lib/interclub-sheets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Une poule + quelques feuilles par équipe, espacées de 600 ms : quelques secondes au pire.
export const maxDuration = 60;

// POST /api/interclub/sync — VÉRIFIE SQUASHNET À LA DEMANDE.
//
// Appelée par l'écran quand on déplie « Classement » ou « Statistiques des joueurs » : c'est le
// moment où l'on veut des chiffres à jour. La ligue saisit parfois une journée AVANT le passage
// du cron (toutes les 4 h) — sans ce geste, le classement et la rencontre restaient en retard
// sur squashnet jusqu'au passage suivant.
//
// Fait exactement ce que fait le cron d'après-match, et pour les mêmes équipes : celles en
// FENÊTRE D'APRÈS-MATCH (`teamsDueForStandings`). Hors fenêtre, rien n'a pu bouger — et la
// porte est servie par le Data Cache, donc la plupart des appuis ne réveillent même pas Neon.
// La relecture des feuilles reporte au passage les résultats officiels dans les rencontres de
// l'appli restées « à saisir » (cf. `interclub-sheet-import.ts`).
//
// REPOS DE 5 MINUTES PAR ÉQUIPE. Dix membres qui ouvrent le classement le soir d'une rencontre
// ne doivent pas faire dix lectures chez la ligue — squashnet est un site associatif. Le repos
// se lit sur `snStandingsAt` (posé aussi par le cron), doublé d'une mémoire d'instance pour les
// équipes dont le classement ne se relit pas (ancrage incomplet, poule non publiée).
//
// Ouverte à tout membre : elle ne fait que lire des pages publiques.

const REPOS_MS = 5 * 60_000;
const derniersPassages = new Map<string, number>();

export async function POST(req: NextRequest) {
  const access = await requireInterclubMember(req);
  if (!access.ok) return access.response;

  const due = await teamsDueForStandings();
  if (due.length === 0) {
    return NextResponse.json({ checked: 0, refreshed: 0, imported: 0 }, { headers: { "Cache-Control": "no-store" } });
  }

  const now = Date.now();
  const teams = await prisma.interclubTeam.findMany({
    where: { id: { in: due } },
    select: { id: true, snEventId: true, snDrawId: true, snRoundId: true, snStandingsAt: true },
  });
  const aRelire = teams.filter(
    (t) =>
      now - (derniersPassages.get(t.id) ?? 0) >= REPOS_MS &&
      (!t.snStandingsAt || now - t.snStandingsAt.getTime() >= REPOS_MS),
  );

  let refreshed = 0;
  let imported = 0;
  for (const t of aRelire) {
    derniersPassages.set(t.id, now);
    // Chaque équipe son `try` : une poule que squashnet sert mal n'emporte pas l'autre.
    if (t.snEventId && t.snDrawId && t.snRoundId) {
      try {
        const r = await refreshTeamStandings({
          id: t.id,
          snEventId: t.snEventId,
          snDrawId: t.snDrawId,
          snRoundId: t.snRoundId,
        });
        if (r.ok) refreshed += 1;
      } catch {
        /* le classement d'avant reste affiché, daté */
      }
    }
    try {
      imported += (await refreshTeamSheets(t.id)).imported;
    } catch {
      /* les feuilles déjà rangées restent */
    }
  }

  return NextResponse.json(
    { checked: aRelire.length, refreshed, imported },
    { headers: { "Cache-Control": "no-store" } },
  );
}
