import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getFeatures } from "@/lib/features-server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// DELETE /api/auth/webauthn/passkeys/{id} — retire un de MES passkeys (appareil perdu, etc.).
// VOLONTAIREMENT non gated par le flag `biometry` (contrairement au GET et aux cérémonies) :
// si l'admin coupe la biométrie, un membre doit tout de même pouvoir supprimer un passkey déjà
// enrôlé (retrait d'un appareil perdu) — jamais le piéger dans son compte.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const { id } = await params;
  // deleteMany borné à userId : impossible de supprimer le passkey d'un autre.
  const r = await prisma.passkey.deleteMany({ where: { id, userId: session.userId } });
  if (r.count === 0) {
    return NextResponse.json({ error: "Passkey introuvable" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

// PATCH /api/auth/webauthn/passkeys/{id}  { deviceLabel } — renomme UN de MES passkeys (donner un
// nom lisible à un appareil : « iPhone de Tom »). Gated comme le GET (flag `biometry`) : la
// section Réglages qui l'appelle n'est montrée que quand la biométrie est active.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await getFeatures()).biometry) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { deviceLabel?: unknown };
  // Libellé vide/absent → null (revient à « Cet appareil »). Sinon borné à 40 caractères,
  // comme à l'enrôlement.
  const deviceLabel =
    typeof body.deviceLabel === "string" && body.deviceLabel.trim()
      ? body.deviceLabel.trim().slice(0, 40)
      : null;
  // updateMany borné à userId : impossible de renommer le passkey d'un autre.
  const r = await prisma.passkey.updateMany({
    where: { id, userId: session.userId },
    data: { deviceLabel },
  });
  if (r.count === 0) {
    return NextResponse.json({ error: "Passkey introuvable" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, deviceLabel });
}
