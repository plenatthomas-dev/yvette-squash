import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/admin";
import { interclubDisabledResponse } from "@/lib/interclub-access";
import {
  fetchTeamCalendar,
  ownFixtures,
  diffCalendar,
  describeDiff,
  calendarFingerprint,
  matchKey,
  CalendarUnreadableError,
  type OwnTie,
  type StoredTie,
} from "@/lib/squashnet/calendar";
import { interclubChanged } from "@/lib/interclub-gate";
import { isUniqueViolation, readJsonBody } from "@/lib/http-tx";
import {
  UNSET_PLAYER,
  derivedStatus,
  seasonOf,
  parseOptionalText,
  MAX_VENUE_LEN,
  MAX_VENUE_ADDRESS_LEN,
} from "@/lib/interclub-db";
import { notifyFixtureMoved } from "@/lib/interclub-notify";
import { fetchStandings } from "@/lib/squashnet/standings";

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
 * Nombre de simples d'une rencontre importée. Le calendrier fédéral ne le publie pas.
 *
 * QUATRE, ET C'EST RÉCENT : la division 4 se jouait en CINQ simples jusqu'en 2025-26, où un nul
 * était arithmétiquement hors d'atteinte. Ce chiffre commande donc la moitié des issues
 * possibles — c'est lui qui rend le 2-2 réel et fait exister `tieOutcome` et son départage à
 * l'average. Le changer sans y penser ferait afficher des points de classement faux.
 *
 * Il double le `@default(4)` du schéma à dessein : la boucle de création s'en sert aussi pour
 * compter les lignes à écrire. L'admin le corrige à la rencontre si le format diffère.
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
    select: {
      id: true,
      name: true,
      snEventId: true,
      snTeamId: true,
      snRoundId: true,
      snDrawId: true,
      captainId: true,
    },
  });
  if (!team) {
    return { ok: false as const, response: NextResponse.json({ error: "Équipe inconnue" }, { status: 404 }) };
  }
  // LES TROIS DU CALENDRIER. `snRoundId` désigne la POULE : sans lui, squashnet rend celle
  // qu'il veut et le filtrage par `snTeamId` ne retient plus rien — un import de zéro
  // rencontre, muet. La division (`snDrawId`), quatrième pièce de l'ancrage, n'est PAS exigée
  // ici : elle ne sert qu'au classement, et l'action « standings » la réclame pour son compte.
  if (!team.snEventId || !team.snTeamId || !team.snRoundId) {
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
  return {
    ok: true as const,
    team: {
      ...team,
      snEventId: team.snEventId,
      snTeamId: team.snTeamId,
      snRoundId: team.snRoundId,
    },
  };
}

// POST /api/admin/interclub-calendar
//   { action: "preview",  teamId }          → télécharge et compare, SANS RIEN ÉCRIRE
//   { action: "apply",    teamId, seen }    → applique l'écart, puis enregistre l'empreinte
//                                             SI plus rien ne reste à faire à la main
//   { action: "standings", teamId }         → retélécharge le CLASSEMENT de la poule, tout de suite
//
// `seen` est l'empreinte que la PRÉVISUALISATION a montrée, et elle est OBLIGATOIRE. Sans elle,
// les deux temps ne tenaient l'un à l'autre par rien : `apply` retélécharge et recalcule, si
// bien que l'admin qui prévisualise, s'absente et revient appliquer valide un écart qu'il n'a
// jamais vu — y compris un effacement de disponibilités. Le geste en deux temps protégeait de
// l'inattention, pas de ce que l'en-tête de ce fichier annonce.
export async function POST(req: NextRequest) {
  const off = await interclubDisabledResponse();
  if (off) return off;
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: "Accès réservé" }, { status: 403 });

  // `readJsonBody` et non `req.json().catch(() => ({}))` : ce dernier ne rattrape que le JSON
  // ILLISIBLE. Le corps littéral `null` est du JSON parfaitement valide, `json()` le résout, et
  // c'est `body.action` qui casse — « Cannot read properties of null », en 500 non géré, là où
  // toutes les autres malformations finissent en 400 propre.
  const body = (await readJsonBody(req)) as {
    action?: unknown;
    teamId?: unknown;
    /** L'empreinte que la prévisualisation a montrée — cf. l'en-tête de la route. */
    seen?: unknown;
  };
  if (body.action !== "preview" && body.action !== "apply" && body.action !== "standings") {
    return NextResponse.json({ error: "Action inconnue" }, { status: 400 });
  }

  const anchored = await anchoredTeam(body.teamId);
  if (!anchored.ok) return anchored.response;
  const { team } = anchored;

  // LE CLASSEMENT, À LA DEMANDE.
  //
  // La passe hebdomadaire le rafraîchit déjà, mais elle passe le lundi : sans ce bouton,
  // l'admin qui vient de renseigner l'ancrage attendrait jusqu'à six jours pour vérifier qu'il
  // a saisi les bons identifiants. Or c'est exactement le moment où il faut pouvoir vérifier —
  // une division fausse rend un tableau parfaitement crédible d'une autre poule.
  if (body.action === "standings") {
    if (!team.snDrawId) {
      return NextResponse.json(
        { error: "Renseigne la division (Tableau/Division) pour lire le classement." },
        { status: 400 },
      );
    }
    let rows;
    try {
      rows = await fetchStandings(team.snEventId, team.snDrawId, team.snRoundId);
    } catch {
      return NextResponse.json(
        { error: "squashnet n'a pas répondu. Réessaie dans un moment." },
        { status: 502 },
      );
    }
    // Zéro ligne n'est pas un classement vide : c'est une poule non publiée, ou un ancrage
    // faux. L'écrire écraserait un tableau valide par du vide, en silence.
    if (rows.length === 0) {
      return NextResponse.json(
        { error: "Aucun classement publié pour cette poule (ou identifiants incorrects)." },
        { status: 404 },
      );
    }
    const at = new Date();
    await prisma.interclubTeam.update({
      where: { id: team.id },
      data: { snStandingsJson: JSON.stringify(rows), snStandingsAt: at },
    });
    return NextResponse.json({ ok: true, rows: rows.length, standingsAt: at.toISOString() });
  }

  let published: OwnTie[];
  try {
    published = ownFixtures(
      await fetchTeamCalendar(team.snEventId, team.snRoundId),
      team.snTeamId,
    );
  } catch (e) {
    // DEUX PANNES, DEUX PHRASES. « Réessaie » sur un rendu qu'on ne sait plus lire enverrait
    // l'admin cliquer dix fois avant d'aller voir le code ; « le format a changé » sur un
    // hoquet réseau enverrait rouvrir le parsing pour rien.
    if (e instanceof CalendarUnreadableError) {
      return NextResponse.json({ error: e.message }, { status: 502 });
    }
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
      // Ce que l'admin a sous les yeux, à renvoyer avec l'`apply` : c'est ce qui lie les deux
      // temps. La même fonction que l'empreinte enregistrée, donc la même définition de
      // « le même calendrier » — deux définitions finiraient par se contredire.
      seen: calendarFingerprint(published),
      toCreate: diff.toCreate,
      toUpdate: diff.toUpdate,
      toDelete: diff.toDelete,
      // Rapporté, jamais appliqué : c'est une déduction qui ne doit pas écraser une correction
      // humaine (cf. `CalendarDiff.confirmDrift`).
      confirmDrift: diff.confirmDrift,
      frozen: frozen.map((u) => u.tie.round),
      unchanged: diff.unchanged,
      summary: describeDiff(diff),
    });
  }

  // --- APPLICATION -------------------------------------------------------------------------

  // ON N'APPLIQUE QUE CE QUI A ÉTÉ MONTRÉ. La ligue peut publier autre chose entre les deux
  // clics, et le second temps retélécharge : sans ce garde-fou, « Appliquer » validerait un
  // écart que personne n'a lu. On refuse plutôt que d'écrire, et l'écran refait un aperçu —
  // 409 parce que c'est un état qui a bougé, pas une faute de l'admin.
  //
  // ⚠️ ET `seen` EST EXIGÉE, alors que le garde ne s'armait que si elle était présente. Une
  // règle qu'on peut faire sauter en omettant un champ n'est pas une règle : un `POST` direct
  // `{action:"apply", teamId}` écrivait ce que personne n'avait lu, effacements de
  // disponibilités compris — exactement ce que l'en-tête de ce fichier promet d'empêcher.
  // L'écran l'envoie toujours (le bouton n'existe que dans le bloc de prévisualisation), donc
  // l'exiger ne coûte rien à personne. 400 et non 409 : il ne manque pas un état, il manque
  // un champ.
  if (typeof body.seen !== "string") {
    return NextResponse.json(
      { error: "Prévisualise avant d'appliquer." },
      { status: 400 },
    );
  }
  if (body.seen !== calendarFingerprint(published)) {
    return NextResponse.json(
      {
        error:
          "Le calendrier publié a changé depuis l'aperçu. Reprévisualise pour voir ce qui serait écrit.",
        code: "stale_preview",
      },
      { status: 409 },
    );
  }

  const moved: { id: string; from: string; opponent: string }[] = [];

  // LES TEXTES LIBRES DE LA LIGUE PASSENT PAR LA MÊME PORTE QUE LA SAISIE HUMAINE.
  //
  // `venue` et `venueAddress` étaient écrits bruts, alors que le `PATCH` les borne à 80 et 200
  // caractères : le chemin AUTOMATIQUE — celui que personne ne relit — était le moins prudent
  // des deux, et l'adresse repartait entière dans le corps du rappel de la veille. `round` est
  // borné ailleurs, à la source (cf. `MAX_ROUND`, lib/squashnet/calendar.ts) : il sert aussi de
  // clé d'ancrage, et le couper ici ferait diverger la clé stockée de celle que l'import
  // recalcule au passage suivant.
  const borne = (v: string | null, max: number): string | null => {
    const r = parseOptionalText(v, max);
    // `v` est déjà `string | null`, donc la branche « mal typé » est inatteignable ici ; on la
    // traite quand même plutôt que de l'écarter par une assertion.
    return r.ok ? r.value : null;
  };

  for (const tie of diff.toCreate) {
    // Une rencontre importée naît avec ses simples « à désigner », exactement comme une
    // rencontre créée à la main : le calendrier fédéral dit QUAND on joue, pas QUI joue.
    //
    // Le nombre de simples est POSÉ explicitement et réutilisé pour créer les lignes : laisser
    // la colonne à son défaut tout en créant « 4 » matchs en dur ferait diverger les deux le
    // jour où une division en compte cinq, et la rencontre se croirait incomplète pour
    // toujours. La ligue ne publie pas cette information — l'admin la corrige si besoin.
    // DEUX CLICS SUR « APPLIQUER » NE SONT PAS UNE FAUTE. Le second repassait par le même
    // `create`, violait l'index unique `(teamId, snMatchKey)` et sortait en 500 — APRÈS des
    // écritures partielles, et sans poser l'empreinte, si bien que le contrôle hebdomadaire
    // re-signalait ensuite un écart déjà appliqué. La rencontre est déjà là : il n'y a rien à
    // faire, et c'est exactement ce qu'on fait.
    try {
      await prisma.interclub.create({
        data: {
          matchCount: IMPORTED_MATCH_COUNT,
          date: tie.date,
          time: tie.time,
          teamId: team.id,
          opponent: tie.opponent,
          home: tie.home,
          venue: borne(tie.venue, MAX_VENUE_LEN),
          venueAddress: borne(tie.venueAddress, MAX_VENUE_ADDRESS_LEN),
          round: tie.round,
          dateConfirmed: tie.dateConfirmed,
          // LA SAISON, DÉDUITE DE LA DATE. L'import ne la posait pas, et le filtre par saison
          // des statistiques — qui se nourrit d'un `DISTINCT season` — se vidait à mesure que
          // l'import remplaçait la saisie à la main. Sans erreur : il proposait simplement de
          // moins en moins de choix. La ligue ne publie pas ce libellé ; il se lit de la date
          // (bascule au 1er août, cf. `seasonOf`).
          season: seasonOf(tie.date) || null,
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
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
    }
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
          // LA SAISON SUIT LA DATE, sinon elle ment dès le premier report. Elle n'était posée
          // qu'à la CRÉATION : J01 importée le 28 juillet gardait « 2025/2026 » après un report
          // au 10 septembre, et le filtre par saison des statistiques — nourri d'un
          // `DISTINCT season` — rangeait la rencontre dans la saison précédente. Sans erreur et
          // sans message, exactement le symptôme que poser `season` à l'import devait clore.
          // Déduite de la date (bascule au 1er août, cf. `seasonOf`), donc recalculée avec elle.
          ...(dateChanged ? { season: seasonOf(u.tie.date) || null } : {}),
          time: u.tie.time,
          home: u.tie.home,
          opponent: u.tie.opponent,
          venue: borne(u.tie.venue, MAX_VENUE_LEN),
          venueAddress: borne(u.tie.venueAddress, MAX_VENUE_ADDRESS_LEN),
          // `dateConfirmed` N'EST PAS RÉÉCRIT. Il l'était sans condition, et le gel des
          // rencontres commencées ne protégeait que `date` : la ligue programmait deux journées
          // le même soir, l'admin corrigeait les deux à la main pour rouvrir l'appel, puis le
          // premier « Appliquer » suivant — pour un lieu changé trois semaines plus tard — les
          // remettait à « prévisionnelle », et l'équipe cessait d'être convoquée sans un mot.
          // L'écart est désormais SIGNALÉ (`confirmDrift`) et corrigé à la main s'il le faut.
          ...(dateChanged ? { availabilityOpenedAt: null, availabilityRemindedAt: null } : {}),
        },
      });
    });
    if (dateChanged && known) moved.push({ id: u.id, from: known.date, opponent: u.tie.opponent });
  }

  // L'EMPREINTE NE SE POSE QUE SUR UN ÉCART ENTIÈREMENT RÉSOLU.
  //
  // Elle n'était enregistrée qu'après application, ce qui est nécessaire mais pas suffisant :
  // elle l'était SANS CONDITION, y compris quand l'application venait de ne rien écrire. Or
  // trois choses ne s'appliquent jamais ici, à dessein — le statut de date (`confirmDrift`,
  // corrigé à la main), la journée retirée (`toDelete`, jamais supprimée d'office) et la
  // rencontre déjà commencée (`frozen`, dont la date ne bouge plus). Poser l'empreinte du
  // calendrier PUBLIÉ par-dessus revenait à déclarer résolu ce qu'on venait de refuser de
  // résoudre, et le cron sort sur l'égalité d'empreinte AVANT de reconstruire le moindre écart.
  //
  // Ce que cela coûtait, mesuré sur le chemin nominal : J03 stockée « prévisionnelle », la ligue
  // la publie ferme, l'alerte du lundi le dit, l'admin clique « Appliquer » — rien n'est écrit,
  // l'empreinte absorbe le statut publié, et plus jamais un lundi ne le resignale. `dateConfirmed`
  // reste `false`, le cron quotidien filtre là-dessus, et l'équipe n'est jamais convoquée pour une
  // rencontre bien réelle. Même mécanique pour une journée retirée, qu'on continuait à convoquer.
  //
  // `snCheckedAt` est posée dans tous les cas : elle répond à l'autre question — « on a regardé »
  // —, et un écart qui subsiste ne veut pas dire qu'on n'a pas regardé.
  const resteUnEcart =
    diff.confirmDrift.length > 0 || diff.toDelete.length > 0 || frozen.length > 0;
  await prisma.interclubTeam.update({
    where: { id: team.id },
    data: {
      ...(resteUnEcart ? {} : { snCalendarHash: calendarFingerprint(published) }),
      snCheckedAt: new Date(),
    },
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
    // CE QUI RESTE À LA MAIN, DIT À L'APPELANT. Tant que ce drapeau est vrai, l'empreinte n'a pas
    // été posée et le contrôle du lundi continuera de signaler l'écart — ce qui est le
    // comportement voulu, mais qui se comprend mieux quand la réponse le dit.
    pending: resteUnEcart,
  });
}
