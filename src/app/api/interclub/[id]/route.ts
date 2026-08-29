import { NextRequest, NextResponse } from "next/server";
import { requireInterclubMember } from "@/lib/interclub-access";
import { prisma } from "@/lib/db";
import { isAdminEmail } from "@/lib/admin";
import { interclubInclude, serializeInterclub } from "@/lib/interclub-db";
import { teamRoster } from "@/lib/interclub-roster";
import { interclubChanged } from "@/lib/interclub-gate";

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

// DELETE /api/interclub/{id} : créateur ou admin (supprime matchs et jeux en cascade).
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const access = await requireInterclubMember(req);
  if (!access.ok) return access.response;
  const { session } = access;
  const { id } = await params;
  const f = await prisma.interclub.findUnique({ where: { id }, select: { createdById: true } });
  if (!f) {
    return NextResponse.json({ error: "Rencontre introuvable" }, { status: 404 });
  }

  if (f.createdById !== session.userId && !isAdminEmail(session.email)) {
    return NextResponse.json({ error: "Accès réservé" }, { status: 403 });
  }

  await prisma.interclub.delete({ where: { id } });
  interclubChanged();
  return NextResponse.json({ ok: true });
}
