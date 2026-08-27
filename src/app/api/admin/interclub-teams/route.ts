import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/admin";
import { getFeatures } from "@/lib/features-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/admin/interclub-teams { mode: "fill" | "clear" }
//
// Outil de MISE EN PLACE, pas une fonction du produit : répartit les membres entre les équipes
// pour pouvoir éprouver le sélecteur de composition en recette.
//
// Délibérément une action d'admin et NON une migration : une migration s'appliquerait aussi à
// la production le jour du merge, et y inventerait des appartenances d'équipe fausses, visibles
// de tous dans l'annuaire. Ici rien ne bouge tant que personne n'appuie sur le bouton.
//
//  - "fill"  : n'affecte QUE les membres sans équipe, en alternant pour équilibrer. Les
//              affectations déjà faites à la main sont préservées.
//  - "clear" : remet tout le monde sans équipe (marche arrière).
export async function POST(req: NextRequest) {
  if (!(await getFeatures()).interclub) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const admin = await requireAdmin(req);
  if (!admin) {
    return NextResponse.json({ error: "Accès réservé" }, { status: 403 });
  }

  const { mode } = (await req.json().catch(() => ({}))) as { mode?: unknown };

  if (mode === "clear") {
    const { count } = await prisma.user.updateMany({
      where: { teamId: { not: null } },
      data: { teamId: null },
    });
    return NextResponse.json({ ok: true, cleared: count });
  }

  if (mode !== "fill") {
    return NextResponse.json({ error: "Mode invalide" }, { status: 400 });
  }

  const teams = await prisma.interclubTeam.findMany({ orderBy: { order: "asc" }, select: { id: true } });
  if (teams.length === 0) {
    return NextResponse.json({ error: "Aucune équipe en base" }, { status: 400 });
  }

  const orphans = await prisma.user.findMany({
    where: { teamId: null, disabledAt: null },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });

  // Alternance plutôt que tirage au sort : le résultat est équilibré et reproductible, alors
  // qu'un vrai hasard peut mettre tout le monde dans la même équipe et ne rien démontrer.
  let assigned = 0;
  for (let i = 0; i < orphans.length; i++) {
    await prisma.user.update({
      where: { id: orphans[i].id },
      data: { teamId: teams[i % teams.length].id },
    });
    assigned += 1;
  }

  return NextResponse.json({ ok: true, assigned, teams: teams.length });
}
