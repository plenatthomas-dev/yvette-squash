import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/health -> vérifie que l'app ET la base répondent (SELECT 1). Léger, sans auth.
// `dbMs` révèle la latence de réveil quand la base Neon sort de veille (cold start) : un
// premier appel après inactivité affichera un dbMs élevé, les suivants ~quelques ms.
// Sert au monitoring et, si on l'accepte (budget compute Neon), à un warm ping externe.
export async function GET() {
  const t0 = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ ok: true, dbMs: Date.now() - t0 });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
