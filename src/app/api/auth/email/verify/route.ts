import { NextRequest, NextResponse } from "next/server";
import { FEATURE_EMAIL_LOGIN } from "@/lib/features";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/auth/email/verify?token=…
// Ancienne cible des liens d'activation. Depuis que le mot de passe se choisit au moment
// d'activer (et non à l'inscription), l'activation et la réinitialisation partagent la même
// page /reinitialiser. On y redirige donc — en conservant les liens d'activation déjà émis.
export async function GET(req: NextRequest) {
  if (!FEATURE_EMAIL_LOGIN) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const url = new URL("/reinitialiser", req.url);
  if (token) url.searchParams.set("token", token);
  return NextResponse.redirect(url, 303);
}
