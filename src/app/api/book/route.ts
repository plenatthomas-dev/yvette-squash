import { NextRequest, NextResponse } from "next/server";
import { book, getPlanning, invalidatePlanningCache } from "@/lib/resamania/client";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { isRealDateISO } from "@/lib/time";
import { isClassEventId } from "@/lib/validation";
import { resolveActingContext } from "@/lib/delegation";
import { refreshSnapshotFromResa } from "@/lib/planning-snapshot";
import { appBlockForUserId, appBlockedResponse } from "@/lib/app-block";
import { readJsonBody } from "@/lib/http-tx";

export const runtime = "nodejs";

function isSlotTimestamp(value: unknown): value is string {
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    isRealDateISO(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
}

// POST /api/book { classEventId, courtName, startsAt, endsAt, onBehalfOf? }
// onBehalfOf (idée 4) : userId du délégant, si on réserve en son nom (délégation active).
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
  const { classEventId, startsAt, onBehalfOf } = await readJsonBody(req);

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
    return NextResponse.json({ error: acting.error }, { status: acting.status });
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

  const r = await book(resa, classEventId);
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

  // Upsert sur la clé unique (userId, classEventId) : réserver un créneau déjà présent
  // dans le journal (ex. annulé puis re-réservé) repasse la même ligne en "booked" au
  // lieu de créer un doublon. La contrainte @@unique garantit l'unicité côté base.
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
  // Le créneau vient de passer « réservé » : purge le cache planning pour que la prochaine
  // lecture reflète tout de suite l'état réel (sinon jusqu'à 20 s à le voir encore libre).
  invalidatePlanningCache();

  // Réservation AU NOM d'un délégant : le délégataire peut être un compte « email seul » qui
  // ne lit que le snapshot. On le rafraîchit avec le jeton du délégant (déjà en main) pour que
  // le créneau apparaisse réservé immédiatement de son côté. (Une auto-réservation d'un compte
  // ResaMania rafraîchit déjà le snapshot via sa propre lecture live du planning.)
  if (actingUserId) {
    await refreshSnapshotFromResa(creneau.startsAt.slice(0, 10), resa, bookingOwnerId);
  }
  return NextResponse.json({ ok: true, state: r.state });
}
