import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/admin";
import { interclubDisabledResponse } from "@/lib/interclub-access";
import { MAX_PLAYER_NAME_LEN } from "@/lib/interclub-db";
import { parseClassementInput } from "@/lib/interclub-order";
import { allTeamMembers } from "@/lib/interclub-roster";

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
// des joueurs du championnat qui ne l'ont jamais ouverte. D'où les « invités » (InterclubGuest),
// gérés ici aussi — sans eux, la règle « seuls les joueurs de l'équipe peuvent être alignés »
// obligeait à rouvrir la composition à un nom libre, donc à tout le monde.
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
    prisma.interclubGuest.findMany({
      orderBy: { name: "asc" },
      select: { id: true, teamId: true, name: true, clt: true },
    }),
    // Le classement effectif (correction admin sinon rapprochement squashnet) est résolu par
    // `interclub-roster.ts`, comme pour la composition d'une rencontre : une seule définition
    // de « à quel classement joue ce membre », pas une copie par écran.
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
//   { action: "add_guest", teamId, name, clt? } → inscrit un joueur sans compte au roster d'une
//                                                  équipe, avec son classement fédéral si connu
//   { action: "set_guest_clt", guestId, clt }   → corrige le classement d'un invité déjà inscrit
//   { action: "remove_guest", guestId }         → retire un invité du roster
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
    // Un invité n'a pas de compte, donc rien à rapprocher sur squashnet : son classement — qui
    // décide de l'ordre des simples (cf. `lib/interclub-order.ts`) — se saisit ici, à la main.
    const clt = parseClassementInput(body.clt);
    if (!clt.ok) return NextResponse.json({ error: clt.error }, { status: 400 });

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
      const guest = await prisma.interclubGuest.create({
        data: { teamId: team.id, name, clt: clt.value },
        select: { id: true, teamId: true, name: true, clt: true },
      });
      return NextResponse.json({ ok: true, guest }, { status: 201 });
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

  if (body.action === "set_guest_clt") {
    if (typeof body.guestId !== "string" || !body.guestId) {
      return NextResponse.json({ error: "Joueur invalide" }, { status: 400 });
    }
    const clt = parseClassementInput(body.clt);
    if (!clt.ok) return NextResponse.json({ error: clt.error }, { status: 400 });

    const { count } = await prisma.interclubGuest.updateMany({
      where: { id: body.guestId },
      data: { clt: clt.value },
    });
    if (count === 0) {
      return NextResponse.json({ error: "Joueur introuvable" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, clt: clt.value });
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
