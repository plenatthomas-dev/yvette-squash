import { NextRequest, NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron-auth";
import { recordCronRun } from "@/lib/cron-run";
import { getFeatures } from "@/lib/features-server";
import { prisma } from "@/lib/db";
import { isAdminEmail } from "@/lib/admin";
import {
  fetchTeamCalendar,
  ownFixtures,
  diffCalendar,
  calendarFingerprint,
} from "@/lib/squashnet/calendar";
import { fetchStandings } from "@/lib/squashnet/standings";
import { notifyCalendarDrift } from "@/lib/interclub-notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ============================================================================
//  GET /api/cron/interclub-calendar — le calendrier fédéral a-t-il bougé ?
//
//  Hebdomadaire. Pour chaque équipe ancrée sur un championnat squashnet : on
//  télécharge, on compare, on PRÉVIENT. On n'écrit AUCUNE rencontre.
//
//  POURQUOI ON N'APPLIQUE PAS. Appliquer un écart efface les disponibilités
//  déjà recueillies pour les rencontres déplacées et re-notifie l'équipe. Un
//  scraping qui casse — squashnet a déjà changé son rendu HTML du jour au
//  lendemain, en silence — pourrait alors vider un calendrier ou déplacer une
//  convocation sans que personne ne l'ait voulu. Le cron alerte, un humain
//  regarde, et applique d'un geste depuis l'espace admin.
//
//  CE QUE FAIT L'EMPREINTE (`snCalendarHash`), ET CE QU'ELLE NE FAIT PAS.
//  Elle évite d'alerter quand RIEN n'a bougé : sans elle, il faudrait
//  reconstruire l'écart complet à chaque passage pour découvrir qu'il est vide.
//  Elle n'est PAS mise à jour ici — seulement à l'application. Donc un écart
//  non appliqué est RE-SIGNALÉ chaque lundi, et c'est voulu : la faire taire
//  dès la première lecture laisserait un report enterré dans une notification
//  que personne n'a ouverte. La relance s'arrête quand l'admin applique, ce qui
//  est exactement le moment où elle doit s'arrêter.
// ============================================================================

/** Le capitaine de l'équipe et les admins : ceux qui peuvent faire quelque chose de l'alerte. */
async function recipients(captainId: string | null): Promise<string[]> {
  const admins = await prisma.user.findMany({
    where: { email: { not: null }, disabledAt: null },
    select: { id: true, email: true },
  });
  const ids = new Set(admins.filter((a) => isAdminEmail(a.email)).map((a) => a.id));
  if (captainId) ids.add(captainId);
  return [...ids];
}

export async function GET(req: NextRequest) {
  if (!(await getFeatures()).interclub) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "Interdit" }, { status: 401 });
  }

  const teams = await prisma.interclubTeam.findMany({
    // Les trois identifiants, sinon l'équipe n'est pas ancrée : interroger sans la POULE
    // rendrait un calendrier qui n'est pas le sien, et le contrôle comparerait n'importe quoi.
    where: { snEventId: { not: null }, snTeamId: { not: null }, snRoundId: { not: null } },
    select: {
      id: true,
      name: true,
      snEventId: true,
      snTeamId: true,
      snRoundId: true,
      snDrawId: true,
      snCalendarHash: true,
      captainId: true,
    },
  });

  let checked = 0;
  let drifted = 0;
  let failed = 0;
  let standings = 0;
  let standingsFailed = 0;

  for (const team of teams) {
    let published;
    try {
      published = ownFixtures(
        await fetchTeamCalendar(team.snEventId!, team.snRoundId!),
        team.snTeamId!,
      );
    } catch {
      // Un hoquet réseau n'est PAS un calendrier vide. On ne touche à rien — surtout pas à
      // `snCheckedAt`, qui doit continuer de dire « la dernière fois qu'on a vraiment regardé ».
      failed++;
      continue;
    }
    checked++;

    // LE CLASSEMENT, DANS LA MÊME PASSE. Il ne bouge qu'après une journée de championnat :
    // une fois par semaine suffit, et l'aller chercher à chaque ouverture de l'écran ferait
    // dépendre l'affichage d'une page quotidienne de la disponibilité de squashnet.
    //
    // Isolé dans son propre `try` : un classement indisponible ne doit pas emporter le
    // contrôle du calendrier, qui est la raison d'être de ce cron. En cas d'échec on ne
    // touche à RIEN — mieux vaut un classement daté de la semaine dernière, et qui le dit,
    // qu'un tableau effacé.
    if (team.snDrawId) {
      try {
        const rows = await fetchStandings(team.snEventId!, team.snDrawId, team.snRoundId!);
        // Zéro ligne n'est pas un classement : c'est une poule non publiée, ou un ancrage
        // faux. L'écrire écraserait un tableau valide par du vide.
        if (rows.length > 0) {
          await prisma.interclubTeam.update({
            where: { id: team.id },
            data: { snStandingsJson: JSON.stringify(rows), snStandingsAt: new Date() },
          });
          standings++;
        }
      } catch {
        standingsFailed++;
      }
    }

    const fingerprint = calendarFingerprint(published);
    // Premier passage d'une équipe (aucune empreinte) : on enregistre sans alerter. Signaler
    // « le calendrier a changé » à la première lecture serait faux, et donnerait le ton pour
    // toutes les alertes suivantes.
    if (team.snCalendarHash === null) {
      await prisma.interclubTeam.update({
        where: { id: team.id },
        data: { snCalendarHash: fingerprint, snCheckedAt: new Date() },
      });
      continue;
    }

    await prisma.interclubTeam.update({ where: { id: team.id }, data: { snCheckedAt: new Date() } });
    if (fingerprint === team.snCalendarHash) continue;

    // On décrit l'écart RÉEL par rapport à ce qu'on a en base, pas seulement « ça a changé » :
    // le lecteur doit pouvoir juger de l'urgence sans ouvrir l'appli.
    const stored = await prisma.interclub.findMany({
      where: { teamId: team.id },
      select: {
        id: true,
        round: true,
        date: true,
        time: true,
        home: true,
        opponent: true,
        venue: true,
        venueAddress: true,
        dateConfirmed: true,
        snMatchKey: true,
      },
    });
    const diff = diffCalendar(stored, published, team.snEventId!);
    const changes = [
      ...diff.toCreate.map((t) => `${t.round} nouvelle (${t.date})`),
      ...diff.toUpdate.map((u) => {
        const d = u.changes.find((c) => c.field === "date");
        return d ? `${u.tie.round} déplacée au ${d.to}` : `${u.tie.round} modifiée`;
      }),
      // Une journée RETIRÉE du calendrier fédéral. Sans ce signalement, la rencontre restait en
      // base pour toujours et le cron quotidien ouvrait son appel de disponibilité pour une
      // soirée qui n'existe plus.
      ...diff.toDelete.map((d) => `${d.round ?? "?"} retirée du calendrier (${d.date})`),
    ];
    // L'empreinte a bougé mais rien de ce qu'on suit n'a changé (une rencontre saisie à la
    // main couvre déjà la journée, par exemple) : se taire plutôt que d'alerter à vide.
    if (changes.length === 0) continue;

    await notifyCalendarDrift(await recipients(team.captainId), team.name, changes);
    drifted++;
  }

  await recordCronRun(
    "interclub-calendar",
    failed === 0,
    `${checked} équipe(s) vérifiée(s), ${drifted} écart(s), ${failed} échec(s), ` +
      `${standings} classement(s) rafraîchi(s), ${standingsFailed} échec(s) de classement`,
  );
  return NextResponse.json({
    teams: teams.length,
    checked,
    drifted,
    failed,
    standings,
    standingsFailed,
  });
}
