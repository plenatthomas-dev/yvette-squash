import { NextRequest, NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron-auth";
import { recordCronRun, runCron } from "@/lib/cron-run";
import { getFeatures } from "@/lib/features-server";
import { prisma } from "@/lib/db";
import { refreshTeamStandings, teamsDueForStandings } from "@/lib/interclub-standings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 300 s : la limite des fonctions Vercel (Fluid compute, plan Hobby compris). 60 s coupait les
// passes longues en plein milieu — toujours les mêmes membres, ceux de fin de liste.
export const maxDuration = 300;

// ============================================================================
//  GET /api/cron/interclub-standings — relit le classement après un match.
//
//  Toutes les 4 heures, à partir de 22 h le soir d'une rencontre et pendant les
//  5 jours qui suivent (cf. `standingsWindowOpen`). Remplace le geste « Relire
//  le classement » que l'admin faisait à la main après chaque journée ; le
//  bouton reste, pour vérifier un ancrage qu'on vient de saisir.
//
//  APPELÉ PAR UN CRON EXTERNE (cron-job.org), PAS PAR `vercel.json`. Le plan
//  Hobby refuse au déploiement toute expression plus fréquente qu'une fois par
//  jour. Réglage : `0 2,6,10,14,18,22 * * *`, fuseau Europe/Paris — voir
//  docs/interclub.md.
//
//  LA FENÊTRE SE DÉCIDE ICI, LA CADENCE LÀ-BAS. Le cron passe tous les jours
//  à ces six heures, match ou pas ; c'est la route qui dit s'il y a quelque
//  chose à relire. Le contraire — programmer le cron externe match par match —
//  demanderait de le reconfigurer à chaque report.
//
//  ET AUCUNE LECTURE POSTGRES AVANT DE SAVOIR. La porte est servie par le Data
//  Cache, AVANT même le drapeau de fonction (`getFeatures` lit la base sur une
//  instance froide, et à ce rythme elles le sont toutes). Les passages sans
//  fenêtre ouverte — la nuit hors saison, tout l'été — ne réveillent pas Neon,
//  et ne laissent donc pas non plus de trace dans le suivi des crons : la ligne
//  « interclub-standings » de /admin date du dernier passage UTILE.
// ============================================================================

async function handle(req: NextRequest) {
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "Interdit" }, { status: 401 });
  }

  const due = await teamsDueForStandings();
  if (due.length === 0) {
    return NextResponse.json({ teams: 0, refreshed: 0, failed: 0, skipped: true });
  }

  if (!(await getFeatures()).interclub) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }

  const teams = await prisma.interclubTeam.findMany({
    // L'ancrage COMPLET : sans la division, squashnet ignore la poule et rend la division 1 —
    // un tableau parfaitement crédible, qui n'est pas le nôtre (cf. lib/squashnet/standings.ts).
    where: {
      id: { in: due },
      snEventId: { not: null },
      snDrawId: { not: null },
      snRoundId: { not: null },
    },
    select: { id: true, snEventId: true, snDrawId: true, snRoundId: true },
  });

  let refreshed = 0;
  let empty = 0;
  let failed = 0;
  for (const team of teams) {
    // Une équipe en échec n'emporte pas les autres : chacune son `try`, y compris contre une
    // écriture en base qui casserait.
    try {
      const r = await refreshTeamStandings({
        id: team.id,
        snEventId: team.snEventId!,
        snDrawId: team.snDrawId!,
        snRoundId: team.snRoundId!,
      });
      if (r.ok) refreshed++;
      else if (r.reason === "empty") empty++;
      else failed++;
    } catch {
      failed++;
    }
  }

  // Un classement encore VIDE n'est pas une panne : la poule n'est pas publiée, ou pas encore.
  // Le compter à part évite de mettre le cron au rouge pour une attente normale.
  await recordCronRun(
    "interclub-standings",
    failed === 0,
    `${refreshed} classement(s) relu(s)` +
      `${empty ? `, ${empty} vide(s)` : ""}` +
      `${failed ? `, ${failed} échec(s)` : ""}` +
      ` — ${due.length} équipe(s) en fenêtre d'après-match`,
  );
  return NextResponse.json({ teams: teams.length, refreshed, empty, failed });
}

// Filet commun (cf. lib/cron-run) : une exception laisse une trace `ok: false` au lieu du
// « ok » de la veille.
export const GET = (req: NextRequest) => runCron("interclub-standings", () => handle(req));
