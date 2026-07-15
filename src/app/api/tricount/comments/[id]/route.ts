import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { getFeatures } from "@/lib/features-server";

export const runtime = "nodejs";

// DELETE /api/tricount/comments/{id} -> supprime SON propre commentaire (idée 5a).
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await getFeatures()).tricount) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const { id } = await params;
  const comment = await prisma.tricountComment.findUnique({
    where: { id },
    select: { userId: true },
  });
  if (!comment || comment.userId !== session.userId) {
    return NextResponse.json({ error: "Commentaire introuvable ou non autorisé" }, { status: 404 });
  }
  await prisma.tricountComment.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
