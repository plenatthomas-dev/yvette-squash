import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { MAX_COMMENT_LEN } from "@/lib/tricount";
import { FEATURE_TRICOUNT } from "@/lib/features";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/tricount/{id}/comments { body } -> ajoute un commentaire au fil du tricount
// (idée 5a). Tout membre connecté peut commenter un tricount existant.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!FEATURE_TRICOUNT) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const text = typeof body?.body === "string" ? body.body.trim() : "";
  if (text.length === 0 || text.length > MAX_COMMENT_LEN) {
    return NextResponse.json(
      { error: `Message invalide (1 à ${MAX_COMMENT_LEN} caractères)` },
      { status: 400 },
    );
  }

  // Le tricount doit exister (il est créé/supprimé au fil des dépenses).
  const tricount = await prisma.tricount.findUnique({ where: { id }, select: { id: true } });
  if (!tricount) {
    return NextResponse.json({ error: "Tricount introuvable" }, { status: 404 });
  }

  const comment = await prisma.tricountComment.create({
    data: { tricountId: id, userId: session.userId, body: text },
  });
  return NextResponse.json({ id: comment.id }, { status: 201 });
}
