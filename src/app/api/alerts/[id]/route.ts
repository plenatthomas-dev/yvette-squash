import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

// DELETE /api/alerts/{id} -> supprime une de mes alertes.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const { id } = await params;
  // deleteMany borné à mon userId : pas d'accès aux alertes des autres.
  await prisma.slotAlert.deleteMany({ where: { id, userId: session.userId } });
  return NextResponse.json({ ok: true });
}
