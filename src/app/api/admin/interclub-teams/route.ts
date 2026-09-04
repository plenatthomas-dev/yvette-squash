import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/admin";
import { interclubDisabledResponse } from "@/lib/interclub-access";
import { MAX_PLAYER_NAME_LEN } from "@/lib/interclub-db";
import { parseClassementInput, parseRangMInput } from "@/lib/interclub-order";
import { allTeamGuests, allTeamMembers, teamGuest } from "@/lib/interclub-roster";
import { matchGuestRanking } from "@/lib/squashnet/refresh";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Composition des ÉQUIPES interclub — qui appartient à quelle équipe.
//
// POURQUOI C'EST UNE FONCTION D'ADMIN, ET PAS UN RÉGLAGE DE MEMBRE
// L'appartenance à une équipe n'est pas une préférence personnelle : elle décide qui peut être
// aligné dans une rencontre. Laisser chacun se déclarer reviendrait à laisser chacun s'inviter
// dans une composition. Le capitaine / l'admin décide, comme dans la vraie vie du club.
//
// Une équipe interclub NE COÏNCIDE PAS avec la liste des inscrits sur l'appli : il y a toujours
// des joueurs du championnat qui ne l'ont jamais ouverte — et qui n'ont pas forcément envie de
// l'ouvrir, tout en acceptant d'y figurer. D'où les « invités » (InterclubGuest), gérés ici
// aussi — sans eux, la règle « seuls les joueurs de l'équipe peuvent être alignés » obligeait à
// rouvrir la composition à un nom libre, donc à tout le monde.
//
// LEUR CLASSEMENT SE CHERCHE, IL NE SE SAISIT PLUS D'ABORD. Ces joueurs sont licenciés comme
// les autres : squashnet les connaît. L'inscription tente donc le rapprochement sur-le-champ
// (`matchGuestRanking`), et la saisie manuelle (`set_guest_ranking`) devient ce qu'elle aurait
// toujours dû être — un REPLI pour les joueurs que squashnet ne sait pas retrouver (homonymes,
// orthographe divergente, licence pas encore enregistrée), pas la voie normale.
//
// L'ancien contenu de cette route était un outil de RECETTE (« fill » / « clear ») qui
// répartissait les membres en alternance pour éprouver le sélecteur. Il n'a plus de raison
// d'être maintenant qu'une vraie affectation existe, et il inventait des appartenances fausses.

/** Nombre d'invités par équipe. Large pour un club, mais borné : c'est une saisie humaine. */
const MAX_GUESTS_PER_TEAM = 40;

// GET /api/admin/interclub-teams — équipes, leurs membres inscrits et leurs joueurs hors appli.
//
// Les MEMBRES sont désormais rendus NOMINATIVEMENT, avec leur classement effectif — et plus
// seulement comptés. L'écran s'appelle « effectif d'une équipe » : un décompte ne dit ni qui en
// fait partie, ni si la composition tient debout un soir de rencontre (c'est le CLASSEMENT qui
// décide de l'ordre des simples). Il fallait sinon ouvrir la page « Membres » à côté et
// reconstituer l'équipe de tête. L'AFFECTATION, elle, reste sur cette page-là : ici on lit.
export async function GET(req: NextRequest) {
  const off = await interclubDisabledResponse();
  if (off) return off;
  if (!(await requireAdmin(req))) {
    return NextResponse.json({ error: "Accès réservé" }, { status: 403 });
  }

  const [teams, guests, members] = await Promise.all([
    prisma.interclubTeam.findMany({
      orderBy: { order: "asc" },
      select: {
        id: true,
        name: true,
        // Le capitaine, et l'ancrage du championnat sur squashnet : les deux se règlent sur cet
        // écran, donc les deux se lisent ici.
        captainId: true,
        captain: { select: { id: true, displayName: true, nickname: true } },
        snEventId: true,
        snTeamId: true,
        snRoundId: true,
        // `snCheckedAt` répond à la question que le silence ne tranche pas : « le calendrier
        // n'a pas bougé », ou « on n'a pas regardé » ?
        snCheckedAt: true,
      },
    }),
    // Le classement effectif (correction admin sinon rapprochement squashnet) est résolu par
    // `interclub-roster.ts` des DEUX côtés du roster, comme pour la composition d'une
    // rencontre : une seule définition de « à quel classement joue ce joueur », pas une copie
    // par écran. Un invité rend en plus ses deux étages séparément — l'écran doit dire d'où
    // vient le classement, et savoir quand squashnet n'a rien trouvé.
    allTeamGuests(),
    allTeamMembers(),
  ]);

  return NextResponse.json({
    // `memberCount` reste servi : l'en-tête d'équipe l'affiche, et le déduire côté client
    // obligerait chaque appelant à refaire le même filtre.
    teams: teams.map((t) => ({
      id: t.id,
      name: t.name,
      memberCount: members.filter((m) => m.teamId === t.id).length,
      captainId: t.captainId,
      captainName: t.captain ? (t.captain.nickname ?? t.captain.displayName) : null,
      snEventId: t.snEventId,
      snTeamId: t.snTeamId,
      snRoundId: t.snRoundId,
      snCheckedAt: t.snCheckedAt?.toISOString() ?? null,
    })),
    members,
    guests,
  });
}

// POST /api/admin/interclub-teams
//   { action: "add_guest", teamId, name }                  → inscrit un joueur sans compte au
//        roster d'une équipe, PUIS tente de rapprocher son classement sur squashnet
//   { action: "rematch_guest", guestId }                   → retente ce rapprochement
//   { action: "set_guest_ranking", guestId, clt, rangM }   → force classement et rang mixte
//        d'un invité que squashnet ne sait pas retrouver (les deux ensemble : ils forment un
//        seul geste, « voilà où joue ce joueur »)
//   { action: "remove_guest", guestId }                    → retire un invité du roster
//   { action: "set_captain", teamId, userId }              → nomme (ou retire, userId null) le
//        capitaine de l'équipe
//   { action: "set_squashnet_event", teamId, eventId, roundId, snTeamId } → ancre l'équipe sur
//        son championnat fédéral (épreuve, POULE et équipe), ce qui rend l'import possible
export async function POST(req: NextRequest) {
  const off = await interclubDisabledResponse();
  if (off) return off;
  if (!(await requireAdmin(req))) {
    return NextResponse.json({ error: "Accès réservé" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    action?: unknown;
    teamId?: unknown;
    guestId?: unknown;
    name?: unknown;
    clt?: unknown;
    rangM?: unknown;
    userId?: unknown;
    eventId?: unknown;
    snTeamId?: unknown;
    roundId?: unknown;
  };

  // LE CAPITAINE — une désignation, pas un droit.
  //
  // Il ne peut rien que les autres ne puissent : composer une équipe reste ouvert à tout membre
  // (cf. lib/interclub-access.ts), et verrouiller créerait un point de blocage le soir où le
  // capitaine n'est pas là. Ce qu'il apporte est ailleurs : l'équipe sait à qui parler, et lui
  // seul reçoit le récapitulatif des disponibilités et les alertes de calendrier — deux choses
  // qui, diffusées à tous, deviendraient un bruit que chacun ignore.
  if (body.action === "set_captain") {
    if (typeof body.teamId !== "string" || !body.teamId) {
      return NextResponse.json({ error: "Équipe invalide" }, { status: 400 });
    }
    const userId = typeof body.userId === "string" && body.userId ? body.userId : null;
    if (userId) {
      const u = await prisma.user.findUnique({
        where: { id: userId },
        select: { teamId: true, displayName: true, nickname: true },
      });
      // Le capitaine doit JOUER dans l'équipe. Nommer quelqu'un d'extérieur est presque
      // toujours une erreur de saisie, et le laisser passer donnerait un destinataire d'alertes
      // qui ne se sent pas concerné — donc des alertes que personne ne traite.
      if (!u) return NextResponse.json({ error: "Membre introuvable." }, { status: 404 });
      if (u.teamId !== body.teamId) {
        return NextResponse.json(
          { error: "Ce membre n'est pas dans cette équipe." },
          { status: 400 },
        );
      }
    }
    await prisma.interclubTeam.update({ where: { id: body.teamId }, data: { captainId: userId } });
    return NextResponse.json({ ok: true, captainId: userId });
  }

  // L'ANCRAGE FÉDÉRAL — de quel championnat cette équipe joue le calendrier.
  //
  // Les TROIS identifiants sont nécessaires et vont ensemble :
  //   * `eventId`  dit quelle ÉPREUVE télécharger ;
  //   * `roundId`  dit quelle POULE de cette épreuve — une épreuve en contient plusieurs, et
  //                sans lui squashnet rend celle qu'il veut. Mesuré sur notre propre critérium :
  //                la réponse était une poule où l'Yvette ne figure pas, donc un import de zéro
  //                rencontre, sans erreur et sans explication ;
  //   * `snTeamId` dit lesquelles des rencontres rendues sont les nôtres — le paramètre `teamid`
  //                de squashnet ne filtre RIEN, il rend la poule entière.
  // N'en poser que deux rendrait l'import inutile tout en donnant l'impression d'être configuré.
  if (body.action === "set_squashnet_event") {
    if (typeof body.teamId !== "string" || !body.teamId) {
      return NextResponse.json({ error: "Équipe invalide" }, { status: 400 });
    }
    const eventId = typeof body.eventId === "string" ? body.eventId.trim() : "";
    const snTeamId = typeof body.snTeamId === "string" ? body.snTeamId.trim() : "";
    const roundId = typeof body.roundId === "string" ? body.roundId.trim() : "";
    const poses = [eventId, snTeamId, roundId].filter(Boolean).length;
    if (poses !== 0 && poses !== 3) {
      return NextResponse.json(
        {
          error:
            "Donne les trois identifiants — épreuve, poule et équipe — ou laisse les trois vides.",
        },
        { status: 400 },
      );
    }
    // Formes vérifiées sur le site : l'épreuve est un hachage hexadécimal, l'équipe un entier.
    // Les contrôler ici évite un import qui échoue plus tard sans qu'on sache lequel des deux
    // champs était fautif.
    if (eventId && !/^[0-9a-f]{16,64}$/i.test(eventId)) {
      return NextResponse.json({ error: "Identifiant d'épreuve invalide." }, { status: 400 });
    }
    if (snTeamId && !/^\d{1,12}$/.test(snTeamId)) {
      return NextResponse.json({ error: "Identifiant d'équipe invalide." }, { status: 400 });
    }
    if (roundId && !/^\d{1,12}$/.test(roundId)) {
      return NextResponse.json({ error: "Identifiant de poule invalide." }, { status: 400 });
    }
    await prisma.interclubTeam.update({
      where: { id: body.teamId },
      data: {
        snEventId: eventId || null,
        snTeamId: snTeamId || null,
        snRoundId: roundId || null,
        // Changer d'ancrage rend l'ancienne empreinte caduque : la garder ferait passer le
        // premier contrôle du nouveau championnat pour « rien n'a bougé ».
        snCalendarHash: null,
        snCheckedAt: null,
      },
    });
    return NextResponse.json({ ok: true, snEventId: eventId || null, snTeamId: snTeamId || null });
  }

  if (body.action === "add_guest") {
    if (typeof body.teamId !== "string" || !body.teamId) {
      return NextResponse.json({ error: "Équipe invalide" }, { status: 400 });
    }
    if (typeof body.name !== "string") {
      return NextResponse.json({ error: "Nom invalide" }, { status: 400 });
    }
    // Espaces normalisés : « Jean  Dupont » et « Jean Dupont » sont le même joueur, et sans
    // cela l'unicité par nom se contournerait d'une frappe.
    const name = body.name.trim().replace(/\s+/g, " ").slice(0, MAX_PLAYER_NAME_LEN);
    if (!name) {
      return NextResponse.json({ error: "Nom manquant" }, { status: 400 });
    }
    const team = await prisma.interclubTeam.findUnique({
      where: { id: body.teamId },
      select: { id: true, _count: { select: { guests: true } } },
    });
    if (!team) {
      return NextResponse.json({ error: "Équipe inconnue" }, { status: 400 });
    }
    if (team._count.guests >= MAX_GUESTS_PER_TEAM) {
      return NextResponse.json(
        { error: `Cette équipe a déjà ${MAX_GUESTS_PER_TEAM} joueurs hors appli.` },
        { status: 400 },
      );
    }

    try {
      const created = await prisma.interclubGuest.create({
        data: { teamId: team.id, name },
        select: { id: true, name: true },
      });
      // « Sans compte » n'est pas « sans licence » : ce joueur dispute le même championnat, donc
      // squashnet le connaît. On cherche TOUT DE SUITE plutôt que d'attendre le cron mensuel —
      // c'est au moment où l'admin l'inscrit qu'il a le nom sous les yeux, donc le seul moment
      // où « pas trouvable » est actionnable (il corrige l'orthographe, ou force le classement).
      //
      // Ne lève jamais et n'annule jamais la création : un hoquet squashnet ne doit pas faire
      // perdre l'inscription, le repli manuel existe précisément pour ça.
      const status = await matchGuestRanking(created);
      const guest = await teamGuest(created.id);
      return NextResponse.json({ ok: true, guest, status }, { status: 201 });
    } catch (e) {
      // P2002 = @@unique([teamId, name]) : le même joueur est déjà au roster. Ce n'est pas une
      // erreur d'admin, juste un doublon — on le dit sans dramatiser.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
        return NextResponse.json(
          { error: "Ce joueur est déjà dans cette équipe." },
          { status: 409 },
        );
      }
      throw e;
    }
  }

  if (body.action === "rematch_guest") {
    if (typeof body.guestId !== "string" || !body.guestId) {
      return NextResponse.json({ error: "Joueur invalide" }, { status: 400 });
    }
    const g = await prisma.interclubGuest.findUnique({
      where: { id: body.guestId },
      select: { id: true, name: true },
    });
    if (!g) return NextResponse.json({ error: "Joueur introuvable" }, { status: 404 });

    // À utiliser après avoir corrigé l'orthographe d'un nom, ou quand une licence vient d'être
    // enregistrée côté fédération : le cron mensuel finirait par y arriver, mais pas avant le
    // prochain jeudi de championnat.
    const status = await matchGuestRanking(g);
    return NextResponse.json({ ok: true, status, guest: await teamGuest(g.id) });
  }

  if (body.action === "set_guest_ranking") {
    if (typeof body.guestId !== "string" || !body.guestId) {
      return NextResponse.json({ error: "Joueur invalide" }, { status: 400 });
    }
    // Les DEUX critères de l'ordre des simples se forcent ensemble (cf. `interclub-order.ts`) :
    // forcer un « 5A » sans rang mixte laisserait le joueur inalignable, avec un message qui
    // renvoie à un champ que l'écran n'aurait pas proposé. Un `NC` fait exception — la
    // fédération ne les ordonne pas entre eux, donc `rangM` y reste facultatif.
    const clt = parseClassementInput(body.clt);
    if (!clt.ok) return NextResponse.json({ error: clt.error }, { status: 400 });
    const rangM = parseRangMInput(body.rangM);
    if (!rangM.ok) return NextResponse.json({ error: rangM.error }, { status: 400 });

    const { count } = await prisma.interclubGuest.updateMany({
      where: { id: body.guestId },
      // Écrit les colonnes d'OVERRIDE, jamais celles du rapprochement : un classement forcé ne
      // doit pas se faire passer pour une donnée squashnet, sans quoi le prochain run mensuel
      // l'écraserait sans que personne comprenne pourquoi la correction a disparu.
      data: { cltOverride: clt.value, rangMOverride: rangM.value },
    });
    if (count === 0) {
      return NextResponse.json({ error: "Joueur introuvable" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, guest: await teamGuest(body.guestId) });
  }

  if (body.action === "remove_guest") {
    if (typeof body.guestId !== "string" || !body.guestId) {
      return NextResponse.json({ error: "Joueur invalide" }, { status: 400 });
    }
    // Les rencontres déjà jouées survivent : `InterclubMatch.homeGuestId` est en SetNull et
    // `homeDisplayName` porte le nom figé. Retirer quelqu'un du roster ne réécrit pas l'histoire.
    const { count } = await prisma.interclubGuest.deleteMany({ where: { id: body.guestId } });
    if (count === 0) {
      return NextResponse.json({ error: "Joueur introuvable" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Action inconnue" }, { status: 400 });
}
