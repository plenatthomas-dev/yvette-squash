import { NextRequest, NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/cron-auth";
import { recordCronRun } from "@/lib/cron-run";
import { getFeatures } from "@/lib/features-server";
import { prisma } from "@/lib/db";
import { todayISO } from "@/lib/interclub-gate";
import {
  dueAction,
  tally,
  isShortHanded,
  CALL_DAYS_BEFORE,
  REMIND_DAYS_BEFORE,
  type AvailabilityEntry,
  type AvailabilityStatus,
} from "@/lib/interclub-availability";
import {
  notifyAvailabilityCall,
  notifyAvailabilityReminder,
  notifyCaptainDigest,
} from "@/lib/interclub-notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ============================================================================
//  GET /api/cron/interclub-availability — l'appel de disponibilité, et sa relance.
//
//  Quotidien. Chaque jour, pour chaque rencontre à venir :
//    * à J-10, ouvre l'appel auprès de TOUTE L'ÉQUIPE ;
//    * à J-3, relance les SEULS non-répondants, et envoie au CAPITAINE le
//      récapitulatif — dont la liste de ceux qu'aucune relance n'atteindra.
//
//  ⚠️ RIEN NE PART SUR UNE DATE NON CONFIRMÉE. La fédération publie les
//  journées non planifiées avec une date bouchon commune ; convoquer l'équipe
//  là-dessus lui apprendrait à ignorer ces notifications.
//
//  L'idempotence tient aux deux marqueurs portés par la rencontre, écrits
//  APRÈS l'envoi : un cron quotidien redemanderait sinon chaque matin à la
//  même équipe si elle est disponible.
// ============================================================================

/** Les mêmes entrées que l'écran, réduites à ce dont les décisions ont besoin. */
async function entriesFor(
  teamId: string,
  fixtureId: string,
): Promise<{ entries: AvailabilityEntry[]; answeredUserIds: Set<string> }> {
  const [members, guests, answers] = await Promise.all([
    prisma.user.findMany({
      where: { teamId, disabledAt: null },
      select: {
        id: true,
        displayName: true,
        nickname: true,
        pushSubs: { select: { id: true }, take: 1 },
      },
    }),
    prisma.interclubGuest.findMany({ where: { teamId }, select: { id: true, name: true } }),
    prisma.interclubAvailability.findMany({
      where: { interclubId: fixtureId },
      select: { userId: true, guestId: true, status: true },
    }),
  ]);

  const byUser = new Map(answers.filter((a) => a.userId).map((a) => [a.userId as string, a]));
  const byGuest = new Map(answers.filter((a) => a.guestId).map((a) => [a.guestId as string, a]));

  const entries: AvailabilityEntry[] = members.map((m) => ({
    key: m.id,
    name: m.nickname ?? m.displayName,
    isMember: true,
    status: (byUser.get(m.id)?.status as AvailabilityStatus | undefined) ?? null,
    comment: null,
    relayedBy: null,
    reachable: m.pushSubs.length > 0,
  }));
  for (const g of guests) {
    entries.push({
      key: `guest:${g.id}`,
      name: g.name,
      isMember: false,
      status: (byGuest.get(g.id)?.status as AvailabilityStatus | undefined) ?? null,
      comment: null,
      relayedBy: null,
      // Jamais joignable : pas de compte, donc pas de notification.
      reachable: false,
    });
  }
  return { entries, answeredUserIds: new Set(byUser.keys()) };
}

export async function GET(req: NextRequest) {
  if (!(await getFeatures()).interclub) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "Interdit" }, { status: 401 });
  }

  const today = todayISO();
  // On ne lit que la FENÊTRE utile. Sans ce plancher, chaque passage relirait tout
  // l'historique du club pour n'en retenir qu'une poignée de soirées.
  const horizon = new Date(`${today}T12:00:00Z`);
  horizon.setUTCDate(horizon.getUTCDate() + CALL_DAYS_BEFORE);
  const fixtures = await prisma.interclub.findMany({
    where: { date: { gte: today, lte: horizon.toISOString().slice(0, 10) }, dateConfirmed: true },
    select: {
      id: true,
      date: true,
      time: true,
      home: true,
      teamId: true,
      matchCount: true,
      dateConfirmed: true,
      availabilityOpenedAt: true,
      availabilityRemindedAt: true,
      opponent: true,
      team: { select: { name: true, captainId: true } },
    },
    orderBy: { date: "asc" },
  });

  let called = 0;
  let reminded = 0;
  let digests = 0;
  // Les équipes en sous-effectif s'ACCUMULENT au lieu de s'écrire au fil de l'eau.
  //
  // `recordCronRun` est un upsert d'UNE ligne par cron : l'appeler dans la boucle puis une
  // dernière fois en sortie faisait gagner le dernier écrit, et le tableau de bord n'a jamais
  // montré autre chose que « N appel(s), N relance(s) ». Le message qui compte pour un
  // capitaine — « il manque du monde » — était écrit puis effacé dans la même requête.
  const sousEffectif: string[] = [];

  for (const f of fixtures) {
    const action = dueAction(f, today);
    if (!action) continue;
    const ctx = { fixtureId: f.id, teamId: f.teamId, teamName: f.team.name, opponent: f.opponent };

    if (action === "call") {
      await notifyAvailabilityCall(ctx, { date: f.date, time: f.time, home: f.home });
      // Marqué APRÈS l'envoi : l'inverse ferait perdre l'appel en silence si l'envoi échoue.
      await prisma.interclub.update({
        where: { id: f.id },
        data: { availabilityOpenedAt: new Date() },
      });
      called++;
      continue;
    }

    // --- RELANCE + RÉCAPITULATIF AU CAPITAINE -------------------------------------------
    const { entries, answeredUserIds } = await entriesFor(f.teamId, f.id);
    const counts = tally(entries);

    // Les SEULS non-répondants — mais TOUS les non-répondants qui ont un compte, joignables par
    // notification ou non.
    //
    // Le filtre sur `reachable` semblait économe : à quoi bon pousser vers un appareil qui ne
    // reçoit rien ? Il oubliait que dans ce projet la CLOCHE est le repli du push, pas son
    // doublon — le journal est alimenté depuis le transport, pour tous les destinataires visés.
    // Écarter les non-joignables les privait donc aussi de la ligne qu'ils auraient lue en
    // ouvrant l'appli, c'est-à-dire du seul canal qui leur restait.
    //
    // Ils restent par ailleurs dans la liste d'appels du capitaine : une entrée dans la cloche
    // n'est pas une garantie d'avoir été vu.
    const aRelancer = entries
      .filter((e) => e.isMember && e.status === null && !answeredUserIds.has(e.key))
      .map((e) => e.key);
    if (aRelancer.length) {
      await notifyAvailabilityReminder(aRelancer, ctx, { date: f.date });
      reminded += aRelancer.length;
    }

    // Le capitaine reçoit ce que personne d'autre n'a à recevoir. Notamment la liste de ceux
    // qu'il doit APPELER — sans elle, il relance en aveugle des gens qui ne verront rien.
    if (f.team.captainId) {
      await notifyCaptainDigest(
        f.team.captainId,
        ctx,
        { date: f.date, matchCount: f.matchCount },
        { yes: counts.yes, maybe: counts.maybe, no: counts.no },
        counts.pendingUnreachable.map((e) => e.name),
      );
      digests++;
    }

    await prisma.interclub.update({
      where: { id: f.id },
      data: { availabilityRemindedAt: new Date() },
    });

    if (isShortHanded(counts, f.matchCount)) {
      sousEffectif.push(`${f.team.name} c. ${f.opponent} ${counts.yes}/${f.matchCount}`);
    }
  }

  // Le journal dit ce qui compte pour un capitaine qui lirait le tableau de bord : pas « 3
  // envois » mais « il manque du monde », et sur quelle rencontre.
  const alerte = sousEffectif.length
    ? ` — sous-effectif à J-${REMIND_DAYS_BEFORE} : ${sousEffectif.join(", ")}`
    : "";
  await recordCronRun(
    "interclub-availability",
    true,
    `${called} appel(s), ${reminded} relance(s), ${digests} récap(s)${alerte}`,
  );
  return NextResponse.json({ examined: fixtures.length, called, reminded, digests });
}
