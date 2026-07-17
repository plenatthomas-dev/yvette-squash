import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getFeatures } from "@/lib/features-server";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/auth/webauthn/passkeys — liste MES passkeys (pour les gérer dans les Réglages).
export async function GET(req: NextRequest) {
  // Gated comme les autres routes passkey : la section Réglages qui l'appelle n'est de toute
  // façon montrée que quand la connexion par e-mail est active. (La DELETE, elle, reste
  // TOUJOURS ouverte — cf. sa route — pour qu'on puisse retirer un passkey même flag coupé.)
  if (!(await getFeatures()).emailLogin) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const passkeys = await prisma.passkey.findMany({
    where: { userId: session.userId },
    select: {
      id: true,
      deviceLabel: true,
      createdAt: true,
      lastUsedAt: true,
      backedUp: true, // synchronisé (iCloud/Google) → survit à la perte de l'appareil
      deviceType: true, // "singleDevice" | "multiDevice"
    },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ passkeys });
}
