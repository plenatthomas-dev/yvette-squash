import { NextRequest, NextResponse } from "next/server";
import { requireInterclubMember } from "@/lib/interclub-access";
import { prisma } from "@/lib/db";
import { isAdminEmail } from "@/lib/admin";
import {
  interclubInclude,
  serializeInterclub,
  parseTimeInput,
  parseOptionalText,
  derivedStatus,
  MAX_OPPONENT_LEN,
  MAX_DIVISION_LEN,
  MAX_VENUE_LEN,
  MAX_VENUE_ADDRESS_LEN,
  MAX_ROUND_LEN,
} from "@/lib/interclub-db";
import { teamRoster } from "@/lib/interclub-roster";
import { interclubChanged } from "@/lib/interclub-gate";
import { isRealDateISO } from "@/lib/time";
import { notifyFixtureMoved } from "@/lib/interclub-notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/interclub/{id} : état complet de la rencontre (matchs, jeux, direct éventuel).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const access = await requireInterclubMember(req);
  if (!access.ok) return access.response;
  const { session } = access;
  const { id } = await params;
  const f = await prisma.interclub.findUnique({ where: { id }, include: interclubInclude });
  if (!f) {
    return NextResponse.json({ error: "Rencontre introuvable" }, { status: 404 });
  }

  // Composition possible : STRICTEMENT le roster de l'équipe qui dispute la rencontre —
  // ses membres inscrits ET ses joueurs sans compte. Règle voulue du club, appliquée côté
  // serveur à l'écriture (cf. `resolveHomePick`) ; ce qu'on renvoie ici n'est que de quoi
  // remplir le sélecteur. Composer suppose donc d'avoir été rattaché à l'équipe par un admin.
  const roster = await teamRoster(f.teamId);

  // Statut admin lu sur la SESSION, déjà chargée : ce `GET` est rejoué à chaque retour au
  // premier plan, un `user.findUnique` de moins y est une économie Neon réelle.
  const view = { ...serializeInterclub(f, session.userId, isAdminEmail(session.email)), roster };
  // Auto-cicatrisation : le statut DÉDUIT fait foi. Si la colonne a divergé (dernier score
  // saisi ailleurs, rencontre laissée « en cours »), on la recale pour que la LISTE soit juste.
  //
  // ⚠️ ÉCRITURE CONDITIONNELLE, et non un `update` simple. On lit puis on écrit la même ligne
  // hors transaction : entre les deux, une écriture de score peut avoir posé le vrai statut.
  // Un `update` inconditionnel l'écrasait alors avec une valeur calculée sur un état déjà mort
  // — deux téléphones au bord du terrain suffisent. Le `where` reprend la valeur LUE : si elle
  // a bougé, la clause ne trouve rien et ce GET, qui n'est qu'un lecteur, se tait.
  if (view.status !== f.status) {
    await prisma.interclub
      .updateMany({ where: { id, status: f.status }, data: { status: view.status } })
      .catch(() => {});
  }
  return NextResponse.json(view);
}

/**
 * PATCH /api/interclub/{id} — corriger une rencontre : sa date, son heure, son lieu, son
 * adversaire, sa journée de championnat.
 *
 * POURQUOI CETTE ROUTE EXISTE. Une rencontre créée n'était PAS modifiable : seuls `GET` et
 * `DELETE` existaient. Tant qu'une rencontre s'inscrivait la veille au soir, on pouvait la
 * supprimer et la refaire. Depuis qu'un calendrier de championnat entier est saisi en septembre
 * et que la ligue reporte des journées en cours de saison, supprimer/recréer perdrait la
 * composition ET les disponibilités déjà recueillies — c'est-à-dire tout le travail.
 *
 * Droits : créateur ou admin, exactement comme `DELETE`. Pas de règle nouvelle à retenir.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const access = await requireInterclubMember(req);
  if (!access.ok) return access.response;
  const { session } = access;
  const { id } = await params;

  const f = await prisma.interclub.findUnique({
    where: { id },
    include: { team: true, matches: { select: { gamesHome: true, status: true } } },
  });
  if (!f) return NextResponse.json({ error: "Rencontre introuvable" }, { status: 404 });
  if (f.createdById !== session.userId && !isAdminEmail(session.email)) {
    return NextResponse.json({ error: "Accès réservé" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const data: Record<string, unknown> = {};

  // --- La date, et elle seule, a des conséquences ------------------------------------------
  let movedFrom: string | null = null;
  if (body.date !== undefined) {
    if (typeof body.date !== "string" || !isRealDateISO(body.date)) {
      return NextResponse.json({ error: "Date invalide" }, { status: 400 });
    }
    // Une rencontre COMMENCÉE ne se déplace pas : le déplacement efface les disponibilités et
    // relance l'appel, ce qui n'a aucun sens sur une soirée déjà en cours ou jouée. Le reste
    // (lieu mal orthographié, adversaire à corriger) demeure modifiable après coup.
    if (body.date !== f.date && derivedStatus(f.matchCount, f.matches) !== "scheduled") {
      return NextResponse.json(
        { error: "Rencontre déjà commencée : sa date ne peut plus changer." },
        { status: 409 },
      );
    }
    if (body.date !== f.date) movedFrom = f.date;
    data.date = body.date;
  }

  const time = parseTimeInput(body.time);
  if (body.time !== undefined) {
    if (!time.ok) return NextResponse.json({ error: "Heure invalide (attendu HH:MM)" }, { status: 400 });
    data.time = time.value;
  }

  if (body.opponent !== undefined) {
    const v = parseOptionalText(body.opponent, MAX_OPPONENT_LEN);
    // Seul champ NON nullable du lot : une rencontre sans adversaire ne veut rien dire, et la
    // colonne le refuserait de toute façon — autant le dire ici, en français.
    if (!v) return NextResponse.json({ error: "Nom du club adverse manquant" }, { status: 400 });
    data.opponent = v;
  }
  if (body.division !== undefined) data.division = parseOptionalText(body.division, MAX_DIVISION_LEN);
  // La JOURNÉE figurait dans le contrat de cette fonction sans y être traitée : une rencontre
  // importée dont la ligue renumérote la journée n'était corrigible d'aucune façon.
  if (body.round !== undefined) data.round = parseOptionalText(body.round, MAX_ROUND_LEN);
  if (body.venue !== undefined) data.venue = parseOptionalText(body.venue, MAX_VENUE_LEN);
  if (body.venueAddress !== undefined) {
    data.venueAddress = parseOptionalText(body.venueAddress, MAX_VENUE_ADDRESS_LEN);
  }
  if (typeof body.home === "boolean") data.home = body.home;
  // LE RATTRAPAGE DE LA DATE PRÉVISIONNELLE. La détection automatique a deux angles morts
  // (cf. `ownFixtures`, lib/squashnet/calendar.ts) : deux vraies journées le même soir passent
  // pour prévisionnelles, et une seule journée non planifiée passe pour ferme. C'est ce booléen,
  // posé à la main, qui les corrige — et c'est pour lui que `dateConfirmed` est une colonne et
  // non un calcul refait à chaque lecture.
  if (typeof body.dateConfirmed === "boolean") data.dateConfirmed = body.dateConfirmed;

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Rien à modifier." }, { status: 400 });
  }

  // --- DÉPLACER UNE RENCONTRE INVALIDE LES RÉPONSES ------------------------------------------
  // « Je suis dispo le 9 » ne veut pas dire « je suis dispo le 16 ». Garder les réponses ferait
  // composer l'équipe sur des « oui » qui ne veulent plus rien dire — et ce sont précisément
  // les soirs de report qu'on se retrouve à trois. On efface, et on relance l'appel en
  // remettant les marqueurs à zéro pour que le cron repose la question.
  if (movedFrom) {
    data.availabilityOpenedAt = null;
    data.availabilityRemindedAt = null;
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (movedFrom) await tx.interclubAvailability.deleteMany({ where: { interclubId: id } });
    await tx.interclub.update({ where: { id }, data });
    return tx.interclub.findUnique({ where: { id }, include: interclubInclude });
  });

  interclubChanged();

  if (movedFrom && updated) {
    // Après l'écriture, jamais avant : annoncer un déplacement qui n'a pas eu lieu serait pire
    // que de ne rien annoncer. Best-effort — `notifyFixtureMoved` ne jette pas.
    await notifyFixtureMoved(
      { fixtureId: id, teamId: f.teamId, teamName: f.team.name, opponent: updated.opponent },
      movedFrom,
      { date: updated.date, time: updated.time },
    );
  }

  return NextResponse.json(
    updated ? serializeInterclub(updated, session.userId, isAdminEmail(session.email)) : { ok: true },
  );
}

// DELETE /api/interclub/{id} : créateur ou admin (supprime matchs et jeux en cascade).
//
// ⚠️ UNE RENCONTRE COMMENCÉE NE SE SUPPRIME PLUS QUE PAR UN ADMIN.
//
// La suppression est DÉFINITIVE et emporte en cascade les simples, le jeu par jeu et les
// disponibilités. Tant que ces lignes ne servaient qu'à afficher un score passé, la perte était
// regrettable ; depuis que les statistiques de joueur s'en déduisent, un seul clic efface le
// palmarès de quatre personnes — et rien ne le dit à l'écran, le total se contentant de
// diminuer.
//
// Le `PATCH` refuse depuis toujours de déplacer une rencontre entamée (409). Le chemin de la
// SUPPRESSION, plus destructeur, était pourtant resté le plus permissif des deux. L'admin
// garde la main : une soirée créée par erreur et marquée par erreur doit rester effaçable.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const access = await requireInterclubMember(req);
  if (!access.ok) return access.response;
  const { session } = access;
  const { id } = await params;
  const f = await prisma.interclub.findUnique({
    where: { id },
    select: {
      createdById: true,
      matchCount: true,
      matches: { select: { gamesHome: true, status: true } },
    },
  });
  if (!f) {
    return NextResponse.json({ error: "Rencontre introuvable" }, { status: 404 });
  }

  const admin = isAdminEmail(session.email);
  if (f.createdById !== session.userId && !admin) {
    return NextResponse.json({ error: "Accès réservé" }, { status: 403 });
  }
  if (!admin && derivedStatus(f.matchCount, f.matches) !== "scheduled") {
    return NextResponse.json(
      {
        error:
          "Rencontre déjà commencée : ses résultats comptent dans les statistiques. " +
          "Demande à un admin de la supprimer.",
      },
      { status: 409 },
    );
  }

  await prisma.interclub.delete({ where: { id } });
  interclubChanged();
  return NextResponse.json({ ok: true });
}
