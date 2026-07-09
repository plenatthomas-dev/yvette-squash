import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { FEATURE_DIRECTORY, FEATURE_RANKING } from "@/lib/features";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/directory
// Annuaire des membres (idée 6). Renvoie UNIQUEMENT les joueurs opt-in (`listed`),
// et pour chacun seulement { id, name } — JAMAIS l'email ni le contactId (l'email
// reste une clé d'identité interne). Réservé aux membres connectés + gated par flag.
export async function GET(req: NextRequest) {
  if (!FEATURE_DIRECTORY) {
    return NextResponse.json({ error: "Annuaire désactivé" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const users = await prisma.user.findMany({
    where: { listed: true },
    select: {
      id: true,
      displayName: true,
      nickname: true,
      // Classement fédéral (idée squashnet) : joint seulement si la fonction est active.
      squashnetRanking: FEATURE_RANKING ? { select: { clt: true, rang: true } } : false,
    },
  });

  // Nom affiché = pseudo si défini, sinon nom réel. Tri alpha (insensible casse/accents).
  // Si le classement est actif, on expose clt (affichage) + rang (tri des têtes de série) ;
  // jamais la licence ni le club (données de traçabilité internes).
  const members = users
    .map((u) => ({
      id: u.id,
      name: u.nickname ?? u.displayName,
      ...(FEATURE_RANKING && u.squashnetRanking
        ? { clt: u.squashnetRanking.clt, rang: u.squashnetRanking.rang }
        : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "fr", { sensitivity: "base" }));

  return NextResponse.json({ members });
}
