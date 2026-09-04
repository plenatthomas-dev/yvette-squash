import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/admin";
import { interclubDisabledResponse } from "@/lib/interclub-access";
import {
  fetchTeamCalendar,
  ownFixtures,
  diffCalendar,
  calendarFingerprint,
  matchKey,
  type OwnTie,
  type StoredTie,
  type CalendarDiff,
} from "@/lib/squashnet/calendar";
import { interclubChanged } from "@/lib/interclub-gate";
import { UNSET_PLAYER, derivedStatus } from "@/lib/interclub-db";
import { notifyFixtureMoved } from "@/lib/interclub-notify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================================
//  IMPORT DU CALENDRIER FÉDÉRAL — deux temps, jamais un seul.
//
//  La ligue publie le calendrier d'une saison en une fois : un geste d'admin
//  suffit à le récupérer, et un contrôle hebdomadaire (cf. le cron) prévient
//  ensuite quand il bouge.
//
//  POURQUOI `preview` PUIS `apply`, ET PAS UN BOUTON UNIQUE. Ce que cet import
//  écrit n'est pas une donnée d'affichage : c'est la date à laquelle une équipe
//  se déplace, et appliquer un écart EFFACE les disponibilités déjà recueillies
//  pour les rencontres déplacées. Un scraping qui casse — squashnet a déjà
//  changé son rendu HTML du jour au lendemain — ne doit pas pouvoir vider un
//  calendrier ni déplacer une convocation tout seul. L'admin voit d'abord, il
//  applique ensuite.
//
//  CE QUE L'IMPORT NE TOUCHE JAMAIS : une rencontre saisie à la main
//  (`snMatchKey` nul). Même doctrine que les corrections de classement —
//  l'automatique et l'humain ne partagent aucune colonne.
// ============================================================================

/**
 * Nombre de simples d'une rencontre importée. Le calendrier fédéral ne le publie pas ; c'est le
 * format habituel du championnat, et l'admin le corrige à la rencontre s'il diffère.
 */
const IMPORTED_MATCH_COUNT = 4;

/**
 * Ce qu'on connaît des rencontres importées d'une équipe, pour les comparer au publié — et,
 * à part, celles qui sont DÉJÀ COMMENCÉES.
 *
 * Le `PATCH` refuse depuis toujours de déplacer une rencontre entamée : le déplacement efface
 * les disponibilités et relance l'appel, ce qui n'a aucun sens sur une soirée déjà jouée. L'import
 * n'avait pas cette garde, si bien que le chemin AUTOMATIQUE — celui que personne ne regarde —
 * était moins prudent que le chemin humain. Il l'a maintenant.
 */
async function storedTies(teamId: string): Promise<{ ties: StoredTie[]; started: Set<string> }> {
  const rows = await prisma.interclub.findMany({
    where: { teamId },
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
      matchCount: true,
      matches: { select: { gamesHome: true, status: true } },
    },
  });
  const started = new Set(
    rows.filter((r) => derivedStatus(r.matchCount, r.matches) !== "scheduled").map((r) => r.id),
  );
  return { ties: rows, started };
}

/** L'équipe et son ancrage, ou la réponse expliquant pourquoi l'import est impossible. */
async function anchoredTeam(teamId: unknown) {
  if (typeof teamId !== "string" || !teamId) {
    return { ok: false as const, response: NextResponse.json({ error: "Équipe invalide" }, { status: 400 }) };
  }
  const team = await prisma.interclubTeam.findUnique({
    where: { id: teamId },
    select: { id: true, name: true, snEventId: true, snTeamId: true, captainId: true },
  });
  if (!team) {
    return { ok: false as const, response: NextResponse.json({ error: "Équipe inconnue" }, { status: 404 }) };
  }
  if (!team.snEventId || !team.snTeamId) {
    // Message explicite plutôt qu'un import vide : « 0 rencontre trouvée » enverrait chercher
    // la panne du côté de la fédération alors que la configuration manque ici.
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: "Cette équipe n'est pas rattachée à un championnat squashnet." },
        { status: 400 },
      ),
    };
  }
  return { ok: true as const, team: { ...team, snEventId: team.snEventId, snTeamId: team.snTeamId } };
}

/** Résumé lisible d'un écart, pour l'écran comme pour la notification. */
export function describeDiff(diff: CalendarDiff): string[] {
  return [
    ...diff.toCreate.map((t) => `${t.round} à créer (${t.date})`),
    ...diff.toUpdate.map(
      (u) => `${u.tie.round} : ${u.changes.map((c) => `${c.field} ${c.from ?? "—"} → ${c.to ?? "—"}`).join(", ")}`,
    ),
    ...diff.toDelete.map((d) => `${d.round ?? "?"} n'est plus publiée (${d.date} c. ${d.opponent})`),
  ];
}

// POST /api/admin/interclub-calendar
//   { action: "preview", teamId }  → télécharge et compare, SANS RIEN ÉCRIRE
//   { action: "apply",   teamId }  → applique l'écart, puis enregistre l'empreinte
export async function POST(req: NextRequest) {
  const off = await interclubDisabledResponse();
  if (off) return off;
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "Accès réservé" }, { status: 403 });

  const body = (await req.json().catch(() => ({}))) as { action?: unknown; teamId?: unknown };
  if (body.action !== "preview" && body.action !== "apply") {
    return NextResponse.json({ error: "Action inconnue" }, { status: 400 });
  }

  const anchored = await anchoredTeam(body.teamId);
  if (!anchored.ok) return anchored.response;
  const { team } = anchored;

  let published: OwnTie[];
  try {
    published = ownFixtures(await fetchTeamCalendar(team.snEventId), team.snTeamId);
  } catch {
    // L'échec réseau se DIT. Le confondre avec un calendrier vide ferait croire que la ligue
    // n'a rien publié, et l'admin attendrait une publication déjà faite.
    return NextResponse.json(
      { error: "squashnet n'a pas répondu. Réessaie dans un moment." },
      { status: 502 },
    );
  }

  const { ties: stored, started } = await storedTies(team.id);
  const diff = diffCalendar(stored, published, team.snEventId);

  // Ce que l'application NE FERA PAS, séparé de ce qu'elle fera : une rencontre entamée garde sa
  // date. L'annoncer ici évite qu'un admin croie avoir appliqué un report qui n'a pas eu lieu.
  const frozen = diff.toUpdate.filter(
    (u) => started.has(u.id) && u.changes.some((c) => c.field === "date"),
  );

  if (body.action === "preview") {
    return NextResponse.json({
      teamName: team.name,
      published: published.length,
      toCreate: diff.toCreate,
      toUpdate: diff.toUpdate,
      toDelete: diff.toDelete,
      frozen: frozen.map((u) => u.tie.round),
      unchanged: diff.unchanged,
      summary: describeDiff(diff),
    });
  }

  // --- APPLICATION -------------------------------------------------------------------------
  const moved: { id: string; from: string; opponent: string }[] = [];

  for (const tie of diff.toCreate) {
    // Une rencontre importée naît avec ses simples « à désigner », exactement comme une
    // rencontre créée à la main : le calendrier fédéral dit QUAND on joue, pas QUI joue.
    //
    // Le nombre de simples est POSÉ explicitement et réutilisé pour créer les lignes : laisser
    // la colonne à son défaut tout en créant « 4 » matchs en dur ferait diverger les deux le
    // jour où une division en compte cinq, et la rencontre se croirait incomplète pour
    // toujours. La ligue ne publie pas cette information — l'admin la corrige si besoin.
    await prisma.interclub.create({
      data: {
        matchCount: IMPORTED_MATCH_COUNT,
        date: tie.date,
        time: tie.time,
        teamId: team.id,
        opponent: tie.opponent,
        home: tie.home,
        venue: tie.venue,
        venueAddress: tie.venueAddress,
        round: tie.round,
        dateConfirmed: tie.dateConfirmed,
        snMatchKey: matchKey(team.snEventId, tie.round),
        createdById: admin.userId,
        matches: {
          create: Array.from({ length: IMPORTED_MATCH_COUNT }, (_, i) => ({
            order: i + 1,
            homeDisplayName: UNSET_PLAYER,
            awayName: UNSET_PLAYER,
          })),
        },
      },
    });
  }

  for (const u of diff.toUpdate) {
    // Même règle que le `PATCH` : une rencontre commencée ne se déplace plus. Le reste de ses
    // champs (lieu corrigé, adversaire réorthographié) s'applique quand même — ce n'est que la
    // DATE qui emporte des conséquences.
    const gele = started.has(u.id);
    const dateChanged = !gele && u.changes.some((c) => c.field === "date");
    const known = stored.find((s) => s.id === u.id);
    await prisma.$transaction(async (tx) => {
      // Une rencontre DÉPLACÉE perd ses réponses : « je suis dispo le 9 » ne veut pas dire
      // « je suis dispo le 16 ». Les garder ferait composer l'équipe sur des « oui » qui ne
      // veulent plus rien dire, et ce sont précisément les soirs de report qu'on se retrouve
      // à trois. Le reste (lieu, heure, adversaire corrigé) ne les remet pas en cause.
      if (dateChanged) {
        await tx.interclubAvailability.deleteMany({ where: { interclubId: u.id } });
      }
      await tx.interclub.update({
        where: { id: u.id },
        data: {
          ...(gele ? {} : { date: u.tie.date }),
          time: u.tie.time,
          home: u.tie.home,
          opponent: u.tie.opponent,
          venue: u.tie.venue,
          venueAddress: u.tie.venueAddress,
          dateConfirmed: u.tie.dateConfirmed,
          ...(dateChanged ? { availabilityOpenedAt: null, availabilityRemindedAt: null } : {}),
        },
      });
    });
    if (dateChanged && known) moved.push({ id: u.id, from: known.date, opponent: u.tie.opponent });
  }

  // L'empreinte n'est enregistrée QU'APRÈS application : la poser dès la lecture ferait taire
  // le contrôle hebdomadaire sur un écart que personne n'a encore appliqué.
  await prisma.interclubTeam.update({
    where: { id: team.id },
    data: { snCalendarHash: calendarFingerprint(published), snCheckedAt: new Date() },
  });

  interclubChanged();

  // Après l'écriture, jamais avant. Best-effort : une notification perdue ne doit pas faire
  // échouer un import déjà appliqué.
  for (const m of moved) {
    const f = diff.toUpdate.find((u) => u.id === m.id)!;
    await notifyFixtureMoved(
      { fixtureId: m.id, teamId: team.id, teamName: team.name, opponent: m.opponent },
      m.from,
      { date: f.tie.date, time: f.tie.time },
    );
  }

  return NextResponse.json({
    ok: true,
    created: diff.toCreate.length,
    updated: diff.toUpdate.length,
    unchanged: diff.unchanged,
    moved: moved.length,
    // Signalées, jamais supprimées : une rencontre peut déjà porter une composition et des
    // réponses, et « plus rien n'est publié » peut n'être qu'un scraping qui a cassé.
    vanished: diff.toDelete.length,
    frozen: frozen.map((u) => u.tie.round),
  });
}
