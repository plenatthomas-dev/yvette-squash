import { NextRequest, NextResponse } from "next/server";
import { recordError } from "@/lib/error-report";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/client-error { message, digest?, path? }
// Envoyé par les pages d'erreur (`app/error.tsx`, `global-error.tsx`) quand un membre tombe sur
// un écran cassé. Publique (un visiteur déconnecté peut voir l'erreur) et bornée : corps limité,
// plafond horaire global dans `recordError`. Rend toujours 204 — le navigateur n'a rien à en
// faire, et un écran d'erreur ne doit pas en afficher une seconde.
export async function POST(req: NextRequest) {
  const raw = await req.text().catch(() => "");
  if (raw.length <= 4000) {
    let body: { message?: unknown; digest?: unknown; path?: unknown } = {};
    try {
      body = JSON.parse(raw);
    } catch {
      /* corps illisible : rien à consigner */
    }
    if (typeof body.message === "string") {
      await recordError({
        source: "client",
        message: body.message,
        digest: body.digest,
        path: body.path,
        userAgent: req.headers.get("user-agent"),
      });
    }
  }
  return new NextResponse(null, { status: 204 });
}
