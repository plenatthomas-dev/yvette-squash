import { NextRequest, NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron-auth";
import { recordCronRun } from "@/lib/cron-run";
import { getFeatures } from "@/lib/features-server";
import { prisma } from "@/lib/db";
import { adminUserIds } from "@/lib/admin";
import {
  fetchTeamCalendar,
  ownFixtures,
  diffCalendar,
  calendarFingerprint,
  CalendarUnreadableError,
} from "@/lib/squashnet/calendar";
import { fetchStandings } from "@/lib/squashnet/standings";
import { notifyCalendarDrift, notifyCalendarUnreadable } from "@/lib/interclub-notify";

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

/**
 * Le capitaine de l'équipe et les admins : ceux qui peuvent faire quelque chose de l'alerte.
 *
 * La liste des admins est passée EN ARGUMENT, lue une seule fois avant la boucle : elle ne
 * dépend pas de l'équipe. On chargeait ici tous les emails du club, une fois par équipe, pour
 * n'en retenir que deux ou trois — et avec une seconde définition de « qui est admin »,
 * à dix lignes de celle qui fait le filtre en base (`adminUserIds`).
 */
function recipients(adminIds: string[], captainId: string | null): string[] {
  const ids = new Set(adminIds);
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
    // LES TROIS DU CALENDRIER SEULEMENT, ET C'EST VOLONTAIRE. L'ancrage complet en compte
    // quatre, mais `snDrawId` ne sert qu'au CLASSEMENT : l'exiger ici priverait de contrôle
    // hebdomadaire toute équipe ancrée avant la migration 44, dont le calendrier est pourtant
    // parfaitement interrogeable. Le classement se garde tout seul, plus bas.
    //
    // Interroger sans la POULE, en revanche, rendrait un calendrier qui n'est pas le sien, et
    // le contrôle comparerait n'importe quoi.
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
      // Le capitaine n'est destinataire que si son compte est actif : `captainId` survit à la
      // désactivation, et l'alerte serait partie vers quelqu'un qui ne peut plus se connecter
      // pour y donner suite.
      captain: { select: { disabledAt: true } },
    },
  });

  // Une seule fois, hors boucle : « qui est admin » ne change pas d'une équipe à l'autre.
  const adminIds = await adminUserIds();

  // Les équipes dont le calendrier a été REÇU mais qu'on n'a pas su lire : à dire à part.
  const unreadable: string[] = [];

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
    } catch (e) {
      // Un hoquet réseau n'est PAS un calendrier vide. On ne touche à rien — surtout pas à
      // `snCheckedAt`, qui doit continuer de dire « la dernière fois qu'on a vraiment regardé ».
      //
      // ET « ON NE SAIT PLUS LIRE » N'EST PAS UN HOQUET RÉSEAU. Les deux appellent des gestes
      // différents — l'un se réessaie tout seul la semaine suivante, l'autre demande de
      // recapturer la fixture et de reprendre le parsing —, et `CalendarUnreadableError` existe
      // précisément pour les distinguer. Confondus dans un compteur muet, le changement de
      // rendu de squashnet n'atteignait personne : le calendrier cessait simplement d'être
      // contrôlé jusqu'à ce qu'un admin pense à lire la ligne de cron.
      if (e instanceof CalendarUnreadableError) {
        unreadable.push(team.name);
      }
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

    // CE CRON N'ÉCRIT JAMAIS L'EMPREINTE — seule l'application le fait, comme l'annoncent
    // l'en-tête ci-dessus et `calendarFingerprint`.
    //
    // Il l'écrivait pourtant au premier passage, « pour ne pas alerter à tort ». Or
    // `snCalendarHash` est remis à `null` par `set_squashnet_event` : à chaque (ré)ancrage
    // d'équipe. On ancrait l'Équipe 1 le dimanche en remettant l'import au lendemain, le cron
    // passait le lundi 9 h, enregistrait l'empreinte, ne signalait rien — et ne signalerait
    // plus jamais rien, l'empreinte étant désormais égale. Les cinq rencontres n'entraient
    // jamais en base, aucun appel de disponibilité ne s'ouvrait, et le seul rattrapage était
    // que quelqu'un repense à cliquer « Prévisualiser ».
    //
    // Il reste vrai qu'on ne doit pas annoncer « le calendrier a CHANGÉ » à une équipe qu'on
    // regarde pour la première fois : rien n'a changé, tout est à importer. C'est le message
    // qui s'adapte, pas l'écriture.
    const premierPassage = team.snCalendarHash === null;
    const fingerprint = calendarFingerprint(published);

    await prisma.interclubTeam.update({ where: { id: team.id }, data: { snCheckedAt: new Date() } });
    if (!premierPassage && fingerprint === team.snCalendarHash) continue;

    // On décrit l'écart RÉEL par rapport à ce qu'on a en base, pas seulement « ça a changé » :
    // le lecteur doit pouvoir juger de l'urgence sans ouvrir l'appli.
    const stored = await prisma.interclub.findMany({
      // LES RENCONTRES DE CET ÉVÉNEMENT SEULEMENT. On chargeait toutes les saisons de l'équipe
      // pour n'en retenir ensuite que les clés préfixées `${eventId}:` — le filtre existait
      // déjà, mais en mémoire, une fois toutes les lignes rapatriées.
      //
      // Les rencontres SAISIES À LA MAIN (`snMatchKey` nul) restent du lot, alors que
      // `diffCalendar` les ignore aujourd'hui de bout en bout : c'est ce que dit son contrat —
      // « l'automatique et l'humain ne partagent aucune colonne » —, et lui passer un jeu
      // amputé ferait dépendre cette doctrine de l'appelant plutôt que d'elle-même.
      where: {
        teamId: team.id,
        OR: [{ snMatchKey: null }, { snMatchKey: { startsWith: `${team.snEventId!}:` } }],
      },
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
      // LE STATUT DE LA DATE, qui n'est pas publié mais déduit, et que l'import ne réécrit plus
      // pour ne pas révoquer une correction humaine. C'est donc la seule voie par laquelle une
      // journée redevenue ferme — ou devenue bouchon — atteint quelqu'un : sans cette ligne, la
      // base garderait « prévisionnelle » et l'équipe ne serait jamais convoquée.
      ...diff.confirmDrift.map(
        (c) =>
          `${c.round} : la ligue la publie ${c.published ? "confirmée" : "prévisionnelle"}, ` +
          `la base la dit ${c.stored ? "confirmée" : "prévisionnelle"} (à corriger à la main)`,
      ),
    ];
    // L'empreinte a bougé mais rien de ce qu'on suit n'a changé (une rencontre saisie à la
    // main couvre déjà la journée, par exemple) : se taire plutôt que d'alerter à vide.
    if (changes.length === 0) continue;

    const capitaine = team.captain?.disabledAt ? null : team.captainId;
    await notifyCalendarDrift(recipients(adminIds, capitaine), team, changes, premierPassage);
    drifted++;
  }

  // Le changement de rendu se DIT à ceux qui peuvent y répondre, et pas seulement au journal
  // de cron que personne n'ouvre tant que rien ne semble cassé. Aux admins seuls : c'est une
  // panne d'outillage, pas une nouvelle de championnat, et le capitaine n'y peut rien.
  if (unreadable.length > 0 && adminIds.length > 0) {
    await notifyCalendarUnreadable(adminIds, unreadable);
  }

  await recordCronRun(
    "interclub-calendar",
    failed === 0,
    `${checked} équipe(s) vérifiée(s), ${drifted} écart(s), ${failed} échec(s)` +
      `${unreadable.length ? ` dont ${unreadable.length} illisible(s)` : ""}, ` +
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
