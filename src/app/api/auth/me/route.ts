import { NextRequest, NextResponse } from "next/server";
import { loadMe } from "@/lib/me";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/auth/me — ce que le client sait de son membre (cf. lib/me : la page d'accueil le
// reçoit déjà au rendu serveur ; la route sert les relectures, retour au premier plan compris).
export async function GET(req: NextRequest) {
  const me = await loadMe(req.cookies.get("sid")?.value);
  if (!me) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  return NextResponse.json(me);
}
