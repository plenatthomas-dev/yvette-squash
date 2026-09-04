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
      select: { id: true, name: true },
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
  };

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
