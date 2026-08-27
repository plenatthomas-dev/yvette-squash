import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { getFeatures } from "@/lib/features-server";
import { isAdminEmail } from "@/lib/admin";
import { interclubInclude, serializeInterclub } from "@/lib/interclub-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/interclub/{id} : état complet de la rencontre (matchs, jeux, direct éventuel).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getFeatures()).interclub) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const { id } = await params;
  const f = await prisma.interclub.findUnique({ where: { id }, include: interclubInclude });
  if (!f) {
    return NextResponse.json({ error: "Rencontre introuvable" }, { status: 404 });
  }

  // Membres alignés dans une équipe, pour le sélecteur de composition. On renvoie TOUTES les
  // équipes et pas seulement celle de la rencontre : un joueur de l'équipe 1 dépanne
  // régulièrement l'équipe 2. Le client met l'équipe de la rencontre en tête.
  const rosterRows = await prisma.user.findMany({
    where: { teamId: { not: null }, disabledAt: null },
    select: { id: true, displayName: true, nickname: true, team: { select: { id: true, name: true } } },
  });
  const roster = rosterRows
    .map((u) => ({
      id: u.id,
      name: u.nickname ?? u.displayName,
      teamId: u.team?.id ?? null,
      teamName: u.team?.name ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "fr", { sensitivity: "base" }));

  const view = { ...serializeInterclub(f, session.userId), roster };
  // Auto-cicatrisation : le statut DÉDUIT fait foi. Si la colonne a divergé (dernier score
  // saisi ailleurs, rencontre laissée « en cours »), on la recale pour que la LISTE soit juste.
  if (view.status !== f.status) {
    await prisma.interclub.update({ where: { id }, data: { status: view.status } }).catch(() => {});
  }
  return NextResponse.json(view);
}

// DELETE /api/interclub/{id} : créateur ou admin (supprime matchs et jeux en cascade).
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getFeatures()).interclub) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const { id } = await params;
  const f = await prisma.interclub.findUnique({ where: { id }, select: { createdById: true } });
  if (!f) {
    return NextResponse.json({ error: "Rencontre introuvable" }, { status: 404 });
  }

  if (f.createdById !== session.userId) {
    const me = await prisma.user.findUnique({ where: { id: session.userId }, select: { email: true } });
    if (!isAdminEmail(me?.email)) {
      return NextResponse.json({ error: "Accès réservé" }, { status: 403 });
    }
  }

  await prisma.interclub.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
