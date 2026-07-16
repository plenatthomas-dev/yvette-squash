import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// DELETE /api/auth/webauthn/passkeys/{id} — retire un de MES passkeys (appareil perdu, etc.).
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
