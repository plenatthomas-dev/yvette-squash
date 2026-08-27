import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { getFeatures } from "@/lib/features-server";
import { isAdminEmail } from "@/lib/admin";
import { interclubInclude, serializeInterclub } from "@/lib/interclub-db";
import { interclubChanged } from "@/lib/interclub-gate";

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

  // Composition possible : STRICTEMENT les membres de l'équipe qui dispute la rencontre.
  // Règle voulue du club, appliquée ici et non pas seulement à l'écran — c'est la seule
  // façon qu'elle tienne. Conséquence assumée : aligner quelqu'un suppose de l'avoir
  // d'abord rattaché à l'équipe (paramètres du membre, ou espace admin).
  const rosterRows = await prisma.user.findMany({
    where: { teamId: f.teamId, disabledAt: null },
    select: { id: true, displayName: true, nickname: true },
  });
  const roster = rosterRows
    .map((u) => ({ id: u.id, name: u.nickname ?? u.displayName }))
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
  interclubChanged();
  return NextResponse.json({ ok: true });
}
