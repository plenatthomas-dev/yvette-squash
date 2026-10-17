import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
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
  notifyEveReminder,
} from "@/lib/interclub-notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ============================================================================
//  GET /api/cron/interclub-availability — l'appel de disponibilité, et sa relance.
//
//  Quotidien. Chaque jour, pour chaque rencontre à venir :
//    * au plus tard à J-10, ouvre l'appel auprès de TOUTE L'ÉQUIPE ;
//    * au plus tard à J-3, relance les SEULS non-répondants, et envoie au
//      CAPITAINE le récapitulatif — dont la liste de ceux qu'aucune relance
//      n'atteindra.
//
//  « Au plus tard » et non « à » : `dueAction` déclenche sur `jours <= seuil`,
//  pas sur l'égalité. Une rencontre inscrite à J-4 reçoit son appel le jour
//  même — sinon elle n'en recevrait jamais.
//
//  ⚠️ RIEN NE PART SUR UNE DATE NON CONFIRMÉE. La fédération publie les
//  journées non planifiées avec une date bouchon commune ; convoquer l'équipe
//  là-dessus lui apprendrait à ignorer ces notifications.
//
//  L'idempotence tient aux trois marqueurs portés par la rencontre
//  (`availabilityOpenedAt`, `availabilityRemindedAt`, `eveRemindedAt`) : un cron
//  quotidien redemanderait sinon chaque matin à la même équipe si elle est
//  disponible. Ils sont PRIS AVANT l'envoi, cf. `prendre`.
// ============================================================================

/** Les trois marqueurs d'envoi d'une rencontre — un par étape de `dueAction`. */
type Marqueur = "availabilityOpenedAt" | "availabilityRemindedAt" | "eveRemindedAt";

const MARQUEUR: Record<"call" | "remind" | "eve", Marqueur> = {
  call: "availabilityOpenedAt",
  remind: "availabilityRemindedAt",
  eve: "eveRemindedAt",
};

/**
 * PREND l'envoi `marqueur` de la rencontre `id` : vrai si et seulement si CE passage l'a obtenu.
 *
 * Le marqueur était posé APRÈS l'envoi, par un `update` inconditionnel. Deux exécutions
 * concurrentes — un réessai de la plateforme, un déclenchement manuel pendant le passage
 * planifié — lisaient donc toutes deux `null`, envoyaient toutes deux, puis marquaient toutes
 * deux : l'équipe recevait l'appel en double, le capitaine deux récapitulatifs.
 *
 * Un `updateMany` conditionné sur `marqueur: null` est atomique en base : des deux passages, un
 * seul compte `1`, l'autre `0` et se tait. Aucune transaction, aucun verrou tenu pendant l'envoi.
 *
 * L'ancien ordre se justifiait ainsi : « marqué après l'envoi, sinon on perd l'appel si l'envoi
 * échoue ». L'argument ne tient plus pour la PUSH elle-même : `sendTo` (`interclub-notify.ts`)
 * avale déjà toute erreur d'envoi — un envoi raté ne jetait jamais, et le marqueur se posait de
 * toute façon derrière. Ce qui peut encore jeter, ce sont les LECTURES en base qui précèdent
 * l'envoi (destinataires, réponses) : pour elles, `relacher` rend le marqueur et le passage du
 * lendemain retente — la garantie d'origine, sans la double notification.
 */
async function prendre(id: string, marqueur: Marqueur, at: Date): Promise<boolean> {
  const { count } = await prisma.interclub.updateMany({
    where: { id, [marqueur]: null } as Prisma.InterclubWhereInput,
    data: { [marqueur]: at } as Prisma.InterclubUpdateManyMutationInput,
  });
  return count === 1;
}

/**
 * Rend un marqueur pris par CE passage — conditionné sur l'heure qu'il y a posée : on ne défait
 * jamais celui d'un autre. Best-effort : si la base refuse encore, l'envoi est perdu pour cette
 * rencontre, exactement ce qu'aurait donné l'ancien ordre sur la même panne.
 */
async function relacher(id: string, marqueur: Marqueur, at: Date): Promise<void> {
  try {
    await prisma.interclub.updateMany({
      where: { id, [marqueur]: at } as Prisma.InterclubWhereInput,
      data: { [marqueur]: null } as Prisma.InterclubUpdateManyMutationInput,
    });
  } catch {
    /* cf. ci-dessus */
  }
}

/** Les mêmes entrées que l'écran, réduites à ce dont les décisions ont besoin. */
async function entriesFor(teamId: string, fixtureId: string): Promise<AvailabilityEntry[]> {
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
  // Les répondants ne sont plus rendus à part : `status === null` dit déjà « n'a pas répondu »,
  // et un second jeu tiré des mêmes réponses ne pouvait que redire la même chose — ou la
  // contredire un jour, ce qui est le vrai risque.
  return entries;
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
      eveRemindedAt: true,
      opponent: true,
      // Le lieu part dans le rappel de la veille : c'est justement ce qu'on y cherche.
      venue: true,
      venueAddress: true,
      // Qui est ALIGNÉ. Le rappel ne va qu'à eux — les joueurs sans compte (`homeGuestId`)
      // n'ont personne à notifier, et le récapitulatif de J-3 les a déjà signalés au capitaine.
      //
      // ⚠️ `disabledAt` EST LU, et il manquait. C'était le seul carnet d'adresses du module à
      // ne pas l'exclure — `followersFor`, `teamMemberIds` et `entriesFor` le font tous, et
      // `interclub-notify.ts` affirme que la règle vaut pour TOUS. Un membre parti du club,
      // désactivé mais resté aligné sur une composition déjà saisie, recevait la veille au soir
      // « Demain à 20:30, 12 rue du Stade. Tu es aligné. » — et la ligne restait dans son journal.
      matches: { select: { homeUserId: true, homeUser: { select: { disabledAt: true } } } },
      // LE CAPITAINE EST LU AVEC SON COMPTE, pas seulement par son identifiant.
      // `captainId` survit à la désactivation (le schéma ne pose `SetNull` que sur la
      // suppression) : un capitaine parti du club, désactivé, disparaissait de la liste des
      // disponibilités — et recevait pourtant chaque J-3 le récapitulatif nominatif, c'est-à-dire
      // les noms de ses ex-coéquipiers à appeler.
      team: {
        select: { name: true, captainId: true, captain: { select: { disabledAt: true } } },
      },
    },
    orderBy: { date: "asc" },
  });

  let called = 0;
  let reminded = 0;
  let digests = 0;
  let eves = 0;
  // Les équipes en sous-effectif s'ACCUMULENT au lieu de s'écrire au fil de l'eau.
  //
  // `recordCronRun` est un upsert d'UNE ligne par cron : l'appeler dans la boucle puis une
  // dernière fois en sortie faisait gagner le dernier écrit, et le tableau de bord n'a jamais
  // montré autre chose que « N appel(s), N relance(s) ». Le message qui compte pour un
  // capitaine — « il manque du monde » — était écrit puis effacé dans la même requête.
  const sousEffectif: string[] = [];

  // Rencontres sur lesquelles le passage a échoué. Comptées et non levées : UNE rencontre dont
  // la lecture casse ne doit pas priver de leur appel toutes celles qui la suivent.
  const echecs: string[] = [];

  /** Les envois d'UNE rencontre, son marqueur déjà pris (cf. `prendre` et la boucle plus bas). */
  async function envoyer(f: (typeof fixtures)[number], action: "call" | "remind" | "eve") {
    const ctx = { fixtureId: f.id, teamId: f.teamId, teamName: f.team.name, opponent: f.opponent };

    if (action === "call") {
      await notifyAvailabilityCall(ctx, { date: f.date, time: f.time, home: f.home });
      called++;
      return;
    }

    // --- RAPPEL DE LA VEILLE ---------------------------------------------------------
    //
    // Il ne demande rien : il DIT l'heure, le lieu et l'adresse, à ceux qui jouent. Le seul
    // envoi de ce cron qui ne soit pas une question, et le seul qui parte à une liste tirée de
    // la COMPOSITION plutôt que du roster.
    if (action === "eve") {
      const alignes = [
        ...new Set(
          f.matches
            .filter((m) => m.homeUserId !== null && m.homeUser?.disabledAt == null)
            .map((m) => m.homeUserId as string),
        ),
      ];
      if (alignes.length) {
        await notifyEveReminder(
          alignes,
          ctx,
          { date: f.date, time: f.time, home: f.home, venue: f.venue, venueAddress: f.venueAddress },
          f.date === today,
        );
        eves += alignes.length;
      }
      // Le marqueur (pris avant d'arriver ici) reste posé MÊME SANS DESTINATAIRE : une
      // composition vide la veille ne sera pas remplie à temps par ce cron, et repasser demain
      // sur la même rencontre ne trouverait rien de plus. Sans lui, elle serait réexaminée à
      // chaque passage.
      return;
    }

    // --- RELANCE + RÉCAPITULATIF AU CAPITAINE -------------------------------------------
    const entries = await entriesFor(f.teamId, f.id);
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
    // `status === null` DIT DÉJÀ « n'a pas répondu » : `answeredUserIds` était construit à
    // partir des mêmes réponses, et la seconde moitié de la condition ne pouvait jamais être
    // fausse quand la première était vraie. Une condition morte se lit comme une garde, et fait
    // chercher une subtilité qui n'existe pas.
    const aRelancer = entries.filter((e) => e.isMember && e.status === null).map((e) => e.key);
    if (aRelancer.length) {
      await notifyAvailabilityReminder(aRelancer, ctx, { date: f.date });
      reminded += aRelancer.length;
    }

    // Le capitaine reçoit ce que personne d'autre n'a à recevoir. Notamment la liste de ceux
    // qu'il doit APPELER — sans elle, il relance en aveugle des gens qui ne verront rien.
    // Actif seulement : un capitaine désactivé ne peut plus se connecter pour donner suite.
    if (f.team.captainId && !f.team.captain?.disabledAt) {
      await notifyCaptainDigest(
        f.team.captainId,
        ctx,
        { date: f.date, matchCount: f.matchCount },
        { yes: counts.yes, maybe: counts.maybe, no: counts.no },
        counts.pendingUnreachable.map((e) => e.name),
      );
      digests++;
    }

    // Le marqueur de relance, pris avant d'arriver ici, reste posé MÊME si personne n'était à
    // relancer : sinon le récap du capitaine repartirait chaque matin jusqu'à la rencontre.

    if (isShortHanded(counts, f.matchCount)) {
      sousEffectif.push(`${f.team.name} c. ${f.opponent} ${counts.yes}/${f.matchCount}`);
    }
  }

  for (const f of fixtures) {
    const action = dueAction(f, today);
    if (!action) continue;
    const marqueur = MARQUEUR[action];
    const at = new Date();
    let pris = false;
    try {
      // L'ENVOI SE PREND AVANT DE PARTIR (cf. `prendre`) : si un passage concurrent l'a déjà
      // pris, c'est lui qui envoie, et celui-ci passe à la rencontre suivante.
      pris = await prendre(f.id, marqueur, at);
      if (!pris) continue;
      await envoyer(f, action);
    } catch (e) {
      // Une erreur BASE sur cette rencontre (prise du marqueur, lecture des destinataires ou
      // des réponses) : on rend le marqueur s'il a été pris, pour que le passage du lendemain
      // retente, et l'on continue avec les autres rencontres.
      if (pris) await relacher(f.id, marqueur, at);
      echecs.push(f.id);
      console.error(`[cron interclub-availability] rencontre ${f.id} (${action}) :`, e);
    }
  }

  // Le journal dit ce qui compte pour un capitaine qui lirait le tableau de bord : pas « 3
  // envois » mais « il manque du monde », et sur quelle rencontre.
  const alerte = sousEffectif.length
    ? ` — sous-effectif à J-${REMIND_DAYS_BEFORE} : ${sousEffectif.join(", ")}`
    : "";
  const panne = echecs.length ? ` — ÉCHEC sur ${echecs.length} rencontre(s) : ${echecs.join(", ")}` : "";
  await recordCronRun(
    "interclub-availability",
    echecs.length === 0,
    `${called} appel(s), ${reminded} relance(s), ${digests} récap(s), ${eves} rappel(s) de veille${alerte}${panne}`,
  );
  return NextResponse.json({
    examined: fixtures.length,
    called,
    reminded,
    digests,
    eves,
    failed: echecs.length,
  });
}
