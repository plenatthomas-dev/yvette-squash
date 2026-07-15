import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { MAX_COMMENT_LEN } from "@/lib/tricount";
import { getFeatures } from "@/lib/features-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Garde-fou anti-emballement : au-delà de MAX_PER_WINDOW messages en WINDOW_MS pour un même
// membre, on refuse. Volontairement LARGE — une vraie conversation n'en approche jamais. Ce
// n'est pas une limite d'usage mais un filet : le club est sur invitation, donc le risque n'est
// pas l'inconnu malveillant mais le client qui boucle ou le compte compromis, qui rempliraient
// la base (Neon Hobby) de messages. Le compteur vit en base (pas de mémoire partagée entre
// fonctions serverless), comme pour le login et le feedback.
// ⚠️ Contrairement à LoginAttempt/FeedbackMessage, on ne PURGE rien ici : ces lignes sont le
// contenu lui-même, on se contente de les compter.
const WINDOW_MS = 10 * 60_000; // 10 min glissantes
const MAX_PER_WINDOW = 30;

// POST /api/tricount/{id}/comments { body } -> ajoute un commentaire au fil du tricount
// (idée 5a). Tout membre connecté peut commenter un tricount existant.
export async function POST(
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

  // Tous fils confondus : la limite vise le membre, pas le tricount (sinon il suffirait de
  // changer de fil pour la contourner).
  const recent = await prisma.tricountComment.count({
    where: { userId: session.userId, createdAt: { gte: new Date(Date.now() - WINDOW_MS) } },
  });
  if (recent >= MAX_PER_WINDOW) {
    return NextResponse.json(
      { error: "Trop de messages d'un coup. Reprends dans quelques minutes." },
      { status: 429 },
    );
  }

  const comment = await prisma.tricountComment.create({
    data: { tricountId: id, userId: session.userId, body: text },
  });
  return NextResponse.json({ id: comment.id }, { status: 201 });
}
