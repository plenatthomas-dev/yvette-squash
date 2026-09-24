import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/admin";
import { interclubDisabledResponse } from "@/lib/interclub-access";
import { readJsonBody } from "@/lib/http-tx";
import { MAX_PLAYER_NAME_LEN } from "@/lib/interclub-db";
import { teamGuest } from "@/lib/interclub-roster";
import { loadRosters, refreshRosters } from "@/lib/interclub-roster-db";
import { joueursDeLEquipe, notreFiche } from "@/lib/interclub-federal-db";
import type { RosterPlayer } from "@/lib/squashnet/roster";
import {
  absentsDuRoster,
  cltUtile,
  doublonsAppli,
  rangMUtile,
  rapprocherRoster,
} from "@/lib/interclub-federal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================================
//  RAPPROCHER NOTRE FICHE D'ÉQUIPE FÉDÉRALE ET LES JOUEURS DE L'APPLI.
//
//  LE PROBLÈME. Le rapprochement historique interroge le CLASSEMENT national,
//  qui ne contient QUE les joueurs classés : mesuré le 2026-09-24, sept des
//  huit inscrits d'une équipe de D4 y sont introuvables. Ils sont pourtant
//  licenciés et alignables. Un club de loisir en compte une majorité, et chacun
//  demandait jusqu'ici une correction admin à la main, saison après saison.
//
//  LA FICHE D'ÉQUIPE (`ic_a=393480`) les publie tous, avec leur licence. Cette
//  route l'apparie à nos membres et à nos invités, et laisse l'admin trancher
//  ce que le rapprochement n'ose pas conclure.
//
//  LA RÈGLE EST AILLEURS, ET C'EST VOULU : `lib/interclub-federal.ts` est pur
//  et testé sur une fiche réelle. Ici on ne fait que lire, écrire, et refuser.
//
//  ⚠️ CETTE ROUTE N'ÉCRIT QUE SUR NOTRE CLUB. Un roster d'une autre équipe est
//  lisible — c'est ainsi que le menu des adversaires fonctionne — mais rien
//  n'en sort vers nos effectifs. Voir `notreFiche`.
// ============================================================================

/** Nombre d'invités par équipe — la même borne que `interclub-teams`, pour la même raison. */
const MAX_GUESTS_PER_TEAM = 40;

/** L'équipe, son ancrage fédéral, ses membres et ses invités. */
async function chargerEquipe(teamId: unknown) {
  if (typeof teamId !== "string" || !teamId) {
    return { ok: false as const, response: NextResponse.json({ error: "Équipe invalide" }, { status: 400 }) };
  }
  const team = await prisma.interclubTeam.findUnique({
    where: { id: teamId },
    select: { id: true, name: true, snTeamId: true },
  });
  if (!team) {
    return { ok: false as const, response: NextResponse.json({ error: "Équipe inconnue" }, { status: 404 }) };
  }
  if (!team.snTeamId) {
    // Message explicite plutôt qu'une fiche vide : « 0 joueur » enverrait chercher la panne du
    // côté de la fédération alors que la configuration manque ici. Même doctrine que l'import
    // du calendrier (`anchoredTeam`, api/admin/interclub-calendar).
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: "Cette équipe n'est pas rattachée à un championnat squashnet." },
        { status: 400 },
      ),
    };
  }
  return { ok: true as const, team: { ...team, snTeamId: team.snTeamId } };
}

/** Ce qu'une ligne fédérale apporterait à un joueur de l'appli. */
function valeursDe(p: RosterPlayer) {
  return {
    licence: (p.licence ?? "").trim() || null,
    clt: cltUtile(p),
    // ⚠️ Nul pour un NC : la fédération publie 9311 pour tous les non-classés, une sentinelle
    // et non un rang (cf. `rangMUtile`).
    rangM: rangMUtile(p),
  };
}

// GET /api/admin/interclub-roster?teamId=… — la fiche fédérale appariée, sans rien écrire.
export async function GET(req: NextRequest) {
  const off = await interclubDisabledResponse();
  if (off) return off;
  if (!(await requireAdmin(req))) {
    return NextResponse.json({ error: "Accès réservé" }, { status: 403 });
  }

  const chargee = await chargerEquipe(req.nextUrl.searchParams.get("teamId"));
  if (!chargee.ok) return chargee.response;
  const { team } = chargee;

  const [rosters, joueurs, ligne] = await Promise.all([
    loadRosters([team.snTeamId]),
    joueursDeLEquipe(team.id),
    prisma.squashnetTeamRoster.findUnique({
      where: { snTeamId: team.snTeamId },
      select: { fetchedAt: true },
    }),
  ]);

  const fiche = notreFiche(rosters.get(team.snTeamId));
  // TROIS ÉTATS, ET ILS NE SE CONFONDENT PAS : jamais téléchargée, téléchargée mais appartenant
  // à un autre club (donc un ancrage faux), ou lisible. Les afficher pareil enverrait chercher
  // une panne de la fédération là où c'est notre configuration qui est fausse.
  const brute = rosters.get(team.snTeamId);
  const etat = !brute ? "absente" : fiche ? "ok" : "autre_club";

  const doublons = doublonsAppli(joueurs);
  // Un membre déjà identifié comme doublon d'un invité N'EST PAS un absent : il est inscrit
  // chez la fédération, sous la ligne que l'invité porte encore. Le compter deux fois ferait
  // lire « pas inscrit » sur quelqu'un qui l'est.
  const couverts = new Set(doublons.map((d) => d.membre.id));

  return NextResponse.json({
    team: { id: team.id, name: team.name, snTeamId: team.snTeamId },
    etat,
    fiche: fiche
      ? {
          teamName: fiche.teamName,
          club: fiche.club,
          code: fiche.code,
          captain: fiche.captain,
          fetchedAt: ligne?.fetchedAt.toISOString() ?? null,
        }
      : null,
    // Le club de la fiche reçue, même quand elle n'est pas la nôtre : sans lui, « autre_club »
    // ne dit pas LEQUEL, et l'admin n'a aucun moyen de deviner quel chiffre il a raté.
    clubRecu: brute?.club ?? null,
    lignes: fiche
      ? rapprocherRoster(fiche, joueurs).map((l) => ({
          player: l.player,
          valeurs: valeursDe(l.player),
          appariement: l.appariement,
        }))
      : [],
    absents: fiche
      ? absentsDuRoster(fiche, joueurs).filter((j) => !(j.kind === "member" && couverts.has(j.id)))
      : [],
    doublons,
  });
}

// POST /api/admin/interclub-roster
//   { action: "refresh", teamId, force? }              → retélécharge NOTRE fiche chez la ligue
//   { action: "link", teamId, licence, kind, id }      → lie une ligne à un membre ou un invité
//   { action: "unlink", kind, id }                     → défait la liaison
//   { action: "create_guest", teamId, licence }        → crée l'invité DEPUIS la ligne
//   { action: "promote_guest", teamId, userId, guestId } → l'invité a maintenant un compte
export async function POST(req: NextRequest) {
  const off = await interclubDisabledResponse();
  if (off) return off;
  if (!(await requireAdmin(req))) {
    return NextResponse.json({ error: "Accès réservé" }, { status: 403 });
  }
  const body = await readJsonBody(req);

  // ─── Retélécharger NOTRE fiche ────────────────────────────────────────────────────────────
  if (body.action === "refresh") {
    const chargee = await chargerEquipe(body.teamId);
    if (!chargee.ok) return chargee.response;
    // `force` traverse la fraîcheur d'une semaine : c'est le bouton qu'on presse le soir où le
    // capitaine vient d'inscrire quelqu'un chez la fédération.
    const [outcome] = await refreshRosters([chargee.team.snTeamId], { force: body.force === true });
    return NextResponse.json({ ok: true, outcome });
  }

  // ─── Défaire une liaison ──────────────────────────────────────────────────────────────────
  //
  // Placé AVANT `link` et sans `teamId` : défaire doit rester possible même quand l'ancrage est
  // devenu faux, puisque c'est précisément ce qu'on vient corriger.
  if (body.action === "unlink") {
    const id = typeof body.id === "string" ? body.id : "";
    if (!id) return NextResponse.json({ error: "Joueur invalide" }, { status: 400 });
    if (body.kind === "member") {
      const { count } = await prisma.user.updateMany({
        where: { id },
        data: { snLicence: null, snRosterClt: null, snRosterRangM: null, snRosterAt: null },
      });
      if (count === 0) return NextResponse.json({ error: "Membre introuvable" }, { status: 404 });
    } else if (body.kind === "guest") {
      const { count } = await prisma.interclubGuest.updateMany({
        where: { id },
        data: { snLicence: null, rosterClt: null, rosterRangM: null, rosterAt: null },
      });
      if (count === 0) return NextResponse.json({ error: "Joueur introuvable" }, { status: 404 });
    } else {
      return NextResponse.json({ error: "Type de joueur invalide" }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  }

  // ─── Lier une ligne fédérale à un joueur, ou créer l'invité qui manque ─────────────────────
  if (body.action === "link" || body.action === "create_guest") {
    const chargee = await chargerEquipe(body.teamId);
    if (!chargee.ok) return chargee.response;
    const { team } = chargee;

    const rosters = await loadRosters([team.snTeamId]);
    const fiche = notreFiche(rosters.get(team.snTeamId));
    if (!fiche) {
      // Le refus nomme la cause : sans fiche on ne peut rien lire, et avec la fiche d'un autre
      // club on importerait ses joueurs chez nous.
      return NextResponse.json(
        {
          error: rosters.has(team.snTeamId)
            ? "La fiche téléchargée est celle d'un autre club — vérifie l'identifiant d'équipe."
            : "Aucune fiche d'équipe téléchargée. Rafraîchis-la d'abord.",
        },
        { status: 400 },
      );
    }

    const licence = typeof body.licence === "string" ? body.licence.trim() : "";
    // LA LIGNE EST RELUE DANS LA FICHE, jamais reçue du client. Sinon n'importe quel classement
    // et n'importe quelle licence pourraient être posés sur n'importe quel joueur, par un appel
    // forgé — et c'est exactement ce dont dépend l'ordre des simples.
    const player = fiche.players.find((p) => (p.licence ?? "").trim() === licence && licence !== "");
    if (!player) {
      return NextResponse.json(
        { error: "Cette ligne ne figure pas (ou plus) sur la fiche d'équipe." },
        { status: 409 },
      );
    }
    const v = valeursDe(player);

    if (body.action === "create_guest") {
      if (await prisma.interclubGuest.count({ where: { teamId: team.id } }) >= MAX_GUESTS_PER_TEAM) {
        return NextResponse.json(
          { error: `Cette équipe a déjà ${MAX_GUESTS_PER_TEAM} joueurs hors appli.` },
          { status: 400 },
        );
      }
      // Espaces normalisés comme dans `add_guest` : sans cela l'unicité par nom se contourne
      // d'une frappe. Le nom vient de la fédération, en capitales — c'est ce qu'elle publie, et
      // c'est ce sous quoi le capitaine le retrouvera sur la feuille de match.
      const name = player.name.trim().replace(/\s+/g, " ").slice(0, MAX_PLAYER_NAME_LEN);
      if (!name) return NextResponse.json({ error: "Ligne sans nom" }, { status: 409 });
      try {
        const created = await prisma.interclubGuest.create({
          data: {
            teamId: team.id,
            name,
            snLicence: v.licence,
            rosterClt: v.clt,
            rosterRangM: v.rangM,
            rosterAt: new Date(),
          },
          select: { id: true },
        });
        // ⚠️ ON N'APPELLE PAS `matchGuestRanking` ICI, contrairement à `add_guest`. Ce chemin
        // sert d'abord les NC, que le classement national ne contient pas : la recherche
        // rendrait « introuvable » et ferait croire à un problème là où la fiche vient de tout
        // donner. La passe mensuelle les rapprochera d'elle-même le jour où ils seront classés,
        // et son résultat passera alors devant (cf. la priorité dans `interclub-roster.ts`).
        return NextResponse.json({ ok: true, guest: await teamGuest(created.id) }, { status: 201 });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
          return NextResponse.json(
            { error: "Ce joueur est déjà au roster de cette équipe." },
            { status: 409 },
          );
        }
        throw e;
      }
    }

    // --- link -------------------------------------------------------------------------------
    const id = typeof body.id === "string" ? body.id : "";
    if (!id) return NextResponse.json({ error: "Joueur invalide" }, { status: 400 });
    const donnees = {
      snLicence: v.licence,
      rosterClt: v.clt,
      rosterRangM: v.rangM,
      rosterAt: new Date(),
    };
    if (body.kind === "member") {
      // `updateMany` avec le `teamId` dans le `where` : un identifiant de membre d'une AUTRE
      // équipe ne doit pas pouvoir recevoir une ligne de celle-ci. La garde est dans la
      // requête, pas dans une lecture préalable qu'une écriture concurrente périmerait.
      const { count } = await prisma.user.updateMany({
        where: { id, teamId: team.id },
        data: {
          snLicence: donnees.snLicence,
          snRosterClt: donnees.rosterClt,
          snRosterRangM: donnees.rosterRangM,
          snRosterAt: donnees.rosterAt,
        },
      });
      if (count === 0) {
        return NextResponse.json({ error: "Membre introuvable dans cette équipe." }, { status: 404 });
      }
    } else if (body.kind === "guest") {
      const { count } = await prisma.interclubGuest.updateMany({
        where: { id, teamId: team.id },
        data: donnees,
      });
      if (count === 0) {
        return NextResponse.json({ error: "Joueur introuvable dans cette équipe." }, { status: 404 });
      }
    } else {
      return NextResponse.json({ error: "Type de joueur invalide" }, { status: 400 });
    }
    return NextResponse.json({ ok: true, valeurs: v });
  }

  // ─── L'invité a maintenant un compte ──────────────────────────────────────────────────────
  if (body.action === "promote_guest") {
    const chargee = await chargerEquipe(body.teamId);
    if (!chargee.ok) return chargee.response;
    const { team } = chargee;
    const userId = typeof body.userId === "string" ? body.userId : "";
    const guestId = typeof body.guestId === "string" ? body.guestId : "";
    if (!userId || !guestId) {
      return NextResponse.json({ error: "Joueurs invalides" }, { status: 400 });
    }
    return promouvoir(team.id, userId, guestId);
  }

  return NextResponse.json({ error: "Action inconnue" }, { status: 400 });
}

/**
 * Fondre un invité dans le membre qu'il est devenu.
 *
 * ⚠️ L'ORDRE DES TROIS ÉTAPES N'EST PAS ARBITRAIRE, et la deuxième est celle qu'on oublie.
 * Supprimer l'invité sans réattribuer ses simples À VENIR laisserait des lignes de composition
 * avec un nom figé (`homeDisplayName`) mais plus personne derrière (`homeGuestId` en SetNull) :
 * ni disponibilité, ni revendication, ni ordre des simples vérifiable. La rencontre aurait l'air
 * composée, et ne le serait plus.
 *
 * Les rencontres PASSÉES, elles, ne bougent pas : leur `homeDisplayName` porte le nom du jour,
 * et réécrire l'histoire pour qu'elle désigne un compte créé depuis serait faux.
 *
 * ⚠️ LES DISPONIBILITÉS DE L'INVITÉ SONT PERDUES (cascade sur `InterclubAvailability`). C'est
 * acceptable — le membre répond désormais lui-même, ce qui est tout l'intérêt — mais l'écran
 * doit le dire AVANT, pas après.
 */
async function promouvoir(teamId: string, userId: string, guestId: string) {
  const [membre, invite] = await Promise.all([
    prisma.user.findFirst({ where: { id: userId, teamId }, select: { id: true } }),
    prisma.interclubGuest.findFirst({
      where: { id: guestId, teamId },
      select: { id: true, snLicence: true, rosterClt: true, rosterRangM: true, rosterAt: true },
    }),
  ]);
  if (!membre) {
    return NextResponse.json({ error: "Membre introuvable dans cette équipe." }, { status: 404 });
  }
  if (!invite) {
    return NextResponse.json({ error: "Joueur introuvable dans cette équipe." }, { status: 404 });
  }

  // Les simples à réattribuer sont choisis AVANT la transaction, mais relus par identifiant
  // dedans : on ne déplace que ce qui est encore là.
  const aVenir = await prisma.interclubMatch.findMany({
    where: {
      homeGuestId: invite.id,
      // « Pas encore jouée » au sens le plus simple et le plus sûr : aucun jeu marqué sur la
      // rencontre entière. `derivedStatus` dirait la même chose en lisant tous les simples ; ici
      // une rencontre dont UN simple a commencé est laissée entière, ce qui est le bon défaut —
      // on ne découpe pas une soirée en cours.
      interclub: { matches: { every: { gamesHome: 0, gamesAway: 0 } } },
    },
    select: { id: true },
  });

  const deplaces = await prisma.$transaction(async (tx) => {
    const { count } = await tx.interclubMatch.updateMany({
      where: { id: { in: aVenir.map((m) => m.id) }, homeGuestId: invite.id },
      data: { homeGuestId: null, homeUserId: membre.id },
    });
    await tx.user.updateMany({
      where: { id: membre.id },
      data: {
        // On ne recopie QUE ce que l'invité tenait de la fiche fédérale. Sa correction admin
        // (`cltOverride`) reste derrière lui : elle a été posée pour un joueur sans compte, et
        // le membre a la sienne, qui peut déjà dire autre chose.
        snLicence: invite.snLicence,
        snRosterClt: invite.rosterClt,
        snRosterRangM: invite.rosterRangM,
        snRosterAt: invite.rosterAt ?? new Date(),
      },
    });
    // Les rencontres passées survivent : `homeGuestId` est en SetNull et `homeDisplayName`
    // porte le nom figé. C'est déjà ce que fait `remove_guest`.
    await tx.interclubGuest.delete({ where: { id: invite.id } });
    return count;
  });

  return NextResponse.json({ ok: true, deplaces });
}
