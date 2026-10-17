import { NextRequest, NextResponse } from "next/server";
import { book, getPlanning, invalidatePlanningCache } from "@/lib/resamania/client";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { fmtTime, isRealDateISO } from "@/lib/time";
import { alertsChanged } from "@/lib/alerts-gate";
import { isClassEventId } from "@/lib/validation";
import { resolveActingContext } from "@/lib/delegation";
import { refreshSnapshotFromResa } from "@/lib/planning-snapshot";
import { appBlockForUserId, appBlockedResponse } from "@/lib/app-block";
import { readJsonBody } from "@/lib/http-tx";
import { otherAccountResponse } from "@/lib/notification-actions";
import { isResaOutcomeUnknown, isResaUnavailable } from "@/lib/resamania/errors";
import { outcomeUnknownResponse, resaUnavailableResponse } from "@/lib/resamania/responses";

export const runtime = "nodejs";

function isSlotTimestamp(value: unknown): value is string {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    isRealDateISO(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
}

// POST /api/book { classEventId, courtName, startsAt, endsAt, onBehalfOf?, forUserId? }
// onBehalfOf (idée 4) : userId du délégant, si on réserve en son nom (délégation active).
// forUserId : envoyé par le bouton « Réserver » d'une notification, cf. notification-actions.ts.
//
// ⚠️ `courtName`, `startsAt` et `endsAt` NE FONT PAS AUTORITÉ. Le navigateur exprime une
// intention — « ce créneau-là, et je crois qu'il est ce jour-là » — et le serveur va lire le
// planning pour savoir ce que le créneau est vraiment. Voir `lireCreneau` plus bas.
export async function POST(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  // Appli fermée par un admin : plus aucune réservation côté membres (les admins passent).
  const block = await appBlockForUserId(session.userId);
  if (block) return appBlockedResponse(block);

  // `courtName` et `endsAt` sont encore ENVOYÉS par l'écran de réservation, et volontairement
  // plus lus : ils ne servaient qu'à alimenter le journal, ce que fait désormais le planning.
  // Ils ne sont pas non plus validés — une garde sur un champ ignoré ne prouve rien et ferait
  // croire au prochain lecteur que le champ compte encore.
  const { classEventId, startsAt, onBehalfOf, forUserId } = await readJsonBody(req);
  // « Réserver » depuis une notification (public/sw.js) : l'appareil a pu changer de compte.
  const autreCompte = otherAccountResponse(forUserId, session.userId);
  if (autreCompte) return autreCompte;

  if (!isClassEventId(classEventId)) {
    return NextResponse.json({ error: "classEventId invalide" }, { status: 400 });
  }
  // `startsAt` reste exigé et contrôlé : il ne dit plus l'horaire, il dit QUEL JOUR lire dans
  // le planning. Une date absurde ferait interroger ResaMania pour rien.
  if (!isSlotTimestamp(startsAt)) {
    return NextResponse.json({ error: "Créneau invalide" }, { status: 400 });
  }

  const acting = await resolveActingContext(
    session,
    onBehalfOf,
    "La réservation nécessite une connexion ResaMania.",
  );
  if (!acting.ok) {
    // `code` relayé quand il existe (« resa-unavailable » : 503 de panne ResaMania).
    return NextResponse.json(
      { error: acting.error, ...(acting.code ? { code: acting.code } : {}) },
      { status: acting.status },
    );
  }
  const { resa, bookingOwnerId, actingUserId } = acting.ctx;

  // ─── LE CRÉNEAU FAISANT AUTORITÉ ────────────────────────────────────────────────────
  //
  // ⚠️ TOUT CE QUI SUIT S'ÉCRIT DEPUIS `creneau`, PLUS RIEN DEPUIS LE CORPS DE LA REQUÊTE.
  //
  // LE DÉFAUT CORRIGÉ : le journal recopiait `courtName`, `startsAt` et `endsAt` tels que
  // le navigateur les envoyait. Ils n'étaient contrôlés que dans leur FORME. Un membre
  // authentifié pouvait donc réserver un vrai créneau et faire écrire au journal partagé
  // « Terrain 99, mardi 3 h du matin ». Le journal est le registre commun du club — c'est
  // lui qu'on lit pour savoir qui joue quand.
  //
  // ET LA RÉCONCILIATION NE LE RATTRAPAIT PAS, contrairement à ce qu'on pourrait croire :
  // `reconcilePlanningWithBookings` cherche les résas d'un jour par `startsAt`, donc une
  // résa à la date falsifiée SORT de la fenêtre interrogée et n'est jamais relue — elle ne
  // passe jamais « annulée » quand le créneau se libère. Et pour celles qui restent dans la
  // fenêtre, l'appariement se fait sur `classEventId` : ni le terrain ni l'horaire mentis ne
  // sont corrigés. Le mensonge était donc durable.
  //
  // Le jour lu vient de `startsAt` : c'est la seule chose que le corps sert encore à dire,
  // et elle se vérifie d'elle-même — si le créneau n'est pas dans le planning de ce jour-là,
  // on refuse. `.slice(0, 10)` sur l'instant ISO, comme le fait déjà l'écran de réservation
  // (cf. page.tsx, « prettyDate(slot.startsAt.slice(0, 10)) ») : les créneaux du club sont
  // diurnes, aucun ne change de date entre l'heure du club et UTC.
  let creneau;
  try {
    const planning = await getPlanning(startsAt.slice(0, 10), resa.accessToken);
    creneau = planning.slots.find((s) => s.id === classEventId);
  } catch (e) {
    // Même doctrine que /api/planning : le détail amont est journalisé, jamais renvoyé.
    console.error("[book] planning illisible:", e);
    // ResaMania injoignable (réseau, délai, 5xx) : la consigne commune « réessaie dans un
    // instant », en 503. Rien n'a été réservé — réessayer est sans danger.
    if (isResaUnavailable(e)) return resaUnavailableResponse();
    return NextResponse.json(
      { error: "Planning momentanément indisponible — réessaie dans un instant." },
      { status: 502 },
    );
  }
  if (!creneau) {
    // Deux causes, un seul refus : le créneau n'existe plus (planning modifié), ou le jour
    // annoncé n'est pas le sien. Dans les deux cas on ne sait pas ce qu'on réserverait, donc
    // on ne réserve pas — et surtout on n'appelle pas ResaMania pour le découvrir.
    return NextResponse.json(
      { error: "Ce créneau n'existe plus. Actualise le planning." },
      { status: 409 },
    );
  }

  // Blocage « même créneau » : ResaMania interdit de réserver 2 terrains au même horaire.
  // 1) Court-circuit local si on connaît déjà une résa à cet horaire → évite un appel
  //    voué à échouer et affiche tout de suite une notif d'information. Vérifié sur le
  //    PROPRIÉTAIRE de la résa (le délégant, en cas de délégation) : c'est son compte
  //    ResaMania qui réserve, la règle s'applique à lui.
  {
    const clash = await prisma.booking.findFirst({
      where: {
        userId: bookingOwnerId,
        status: "booked",
        // L'horaire du PLANNING : sur l'horaire annoncé par le navigateur, il suffisait
        // d'en annoncer un autre pour passer à côté de sa propre résa concurrente.
        startsAt: new Date(creneau.startsAt),
        NOT: { classEventId },
      },
    });
    if (clash) {
      return NextResponse.json(
        {
          error: `Tu as déjà une réservation sur ce créneau (${clash.courtName}). Un seul terrain par horaire.`,
          code: "overlap",
        },
        { status: 409 },
      );
    }
  }

  let r;
  try {
    r = await book(resa, classEventId);
  } catch (e) {
    // ÉCRITURE PARTIE SANS RÉPONSE (délai de 15 s, connexion coupée) : la résa a PEUT-ÊTRE
    // été prise. Trois réponses fausses à éviter :
    //  - « échec, réessaie » → si elle a abouti, le membre en prend une 2ᵉ (autre terrain,
    //    même horaire) ou se heurte à « déjà réservé » sans comprendre ;
    //  - « c'est fait » → peut-être faux ;
    //  - écrire le journal → on y inscrirait peut-être une résa fantôme. On ne l'écrit PAS :
    //    la réconciliation du planning (lib/booking-reconcile.ts) tranchera sur l'état réel
    //    à la prochaine lecture fraîche.
    // On vide le cache planning pour que la grille que le membre va regarder soit celle de
    // ResaMania, et non la photo d'avant l'écriture.
    if (isResaOutcomeUnknown(e)) {
      console.warn("[book] réservation partie sans réponse, résultat inconnu:", e);
      invalidatePlanningCache();
      return outcomeUnknownResponse("La réservation");
    }
    throw e;
  }
  if (!r.ok) {
    // 2) Filet de sécurité : ResaMania bloque aussi (has-overlapping-slots) si la résa
    //    en conflit n'était pas connue en base (faite ailleurs).
    if (r.error?.includes("has-overlapping-slots")) {
      return NextResponse.json(
        {
          error: "Tu as déjà une réservation sur ce créneau (autre terrain). Un seul terrain par horaire.",
          code: "overlap",
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: r.error }, { status: 409 });
  }

  // ─── À PARTIR D'ICI, LE TERRAIN EST RÉSERVÉ CHEZ RESAMANIA ─────────────────────────────
  //
  // Rien de ce qui suit ne doit plus faire répondre une erreur : le membre réessaierait une
  // réservation qui a abouti (→ « déjà réservé », ou pire, un 2ᵉ terrain via un autre créneau).
  //
  // Le créneau vient de passer « réservé » : purge le cache planning pour que la prochaine
  // lecture reflète tout de suite l'état réel (sinon jusqu'à 20 s à le voir encore libre).
  // AVANT l'écriture en base, et plus après : une base en panne faisait sauter cette ligne,
  // et le planning montrait encore libre un terrain qu'on venait de prendre.
  invalidatePlanningCache();

  // Upsert sur la clé unique (userId, classEventId) : réserver un créneau déjà présent
  // dans le journal (ex. annulé puis re-réservé) repasse la même ligne en "booked" au
  // lieu de créer un doublon. La contrainte @@unique garantit l'unicité côté base.
  //
  // Protégé : une erreur base ici rendait un 500 au corps vide alors que la réservation
  // existait bel et bien chez ResaMania. On journalise et on répond le succès, avec
  // `journalSynced: false`. La ligne manquante n'est rattrapée que si le flag
  // `externalBookings` est actif (lib/booking-reconcile.ts, sens 2), et alors marquée
  // « resamania » : un trou du journal reste possible, mais il vaut mieux qu'un faux échec.
  let journalSynced = true;
  try {
    await prisma.booking.upsert({
      where: {
        userId_classEventId: { userId: bookingOwnerId, classEventId },
      },
      update: {
        attendeeId: r.attendeeId ?? null,
        courtName: creneau.courtName,
        startsAt: new Date(creneau.startsAt),
        endsAt: new Date(creneau.endsAt),
        status: "booked",
        actingUserId,
        // Repasser la source à "app" est OBLIGATOIRE : la ligne réutilisée peut avoir été
        // marquée "resamania" par la réconciliation (résa faite hors appli, puis annulée,
        // puis refaite ici). Sans ça, l'upsert garderait l'ancienne origine et la résa
        // resterait comptée « hors appli » alors qu'elle vient d'être faite dans l'appli.
        source: "app",
      },
      create: {
        userId: bookingOwnerId,
        attendeeId: r.attendeeId ?? null,
        classEventId,
        // `?? "?"` a disparu des deux côtés : un créneau du planning porte toujours un nom de
        // terrain, et il n'y a plus d'autre source.
        courtName: creneau.courtName,
        startsAt: new Date(creneau.startsAt),
        endsAt: new Date(creneau.endsAt),
        status: "booked",
        actingUserId,
        // Explicite bien que le défaut du schéma suffirait : c'est ICI qu'est l'unique
        // chemin de réservation « via l'appli », autant que ça se lise sans ouvrir le schéma.
        source: "app",
      },
    });
  } catch (e) {
    journalSynced = false;
    console.error("[book] réservation faite chez ResaMania, journal non écrit:", e);
  }

  // Le membre vient d'obtenir le créneau : son alerte « préviens-moi si un terrain se libère »
  // sur ce même jour et ce même horaire n'a plus d'objet. Sans ça, le cron le notifierait plus
  // tard pour un créneau qu'il a déjà — et le bouton « Réserver » de la notification lui ferait
  // tenter un 2ᵉ terrain au même horaire (refusé, « un seul terrain par horaire »).
  // Clé identique à celle posée par l'écran (page.tsx, onWatch) et lue par le cron :
  // `date` = les 10 premiers caractères de l'instant du créneau, `hm` = heure du club.
  // Alerte du PROPRIÉTAIRE de la résa (le délégant en cas de délégation) : c'est lui qui a le
  // créneau. Désactivée (et non supprimée), comme le fait le cron après notification.
  // Best-effort : la réservation est faite, un échec ici ne doit pas la faire paraître ratée.
  try {
    const { count } = await prisma.slotAlert.updateMany({
      where: {
        userId: bookingOwnerId,
        active: true,
        date: creneau.startsAt.slice(0, 10),
        hm: fmtTime(creneau.startsAt),
      },
      data: { active: false },
    });
    // Peut-être la dernière alerte active du club : la porte du cron doit se refermer
    // (cf. lib/alerts-gate.ts). Rien à invalider si rien n'a changé.
    if (count > 0) alertsChanged();
  } catch (e) {
    console.warn("[book] désactivation de l'alerte du créneau réservé échouée:", e);
  }

  // Réservation AU NOM d'un délégant : le délégataire peut être un compte « email seul » qui
  // ne lit que le snapshot. On le rafraîchit avec le jeton du délégant (déjà en main) pour que
  // le créneau apparaisse réservé immédiatement de son côté. (Une auto-réservation d'un compte
  // ResaMania rafraîchit déjà le snapshot via sa propre lecture live du planning.)
  if (actingUserId) {
    await refreshSnapshotFromResa(creneau.startsAt.slice(0, 10), resa, bookingOwnerId);
  }
  return NextResponse.json({ ok: true, state: r.state, journalSynced });
}
