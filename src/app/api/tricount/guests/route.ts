import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { MAX_GUEST_NAME_LEN } from "@/lib/tricount";
import { getFeatures } from "@/lib/features-server";
import { blockEmailOnlyExpenseWrite } from "@/lib/tricount-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/tricount/guests -> ajoute (ou retrouve) un invité hors asso sur le
// tricount du jour choisi. { date: "YYYY-MM-DD", name }
// Un invité n'a ni compte ni connexion : il ne peut porter qu'une part (jamais
// payeur d'une vraie dépense). Le tricount de cette date est créé s'il n'existe
// pas encore, comme pour une dépense (POST /api/tricount/expenses). Idempotent
// par (tricountId, name) : renvoie l'invité existant s'il l'est déjà.
export async function POST(req: NextRequest) {
  if (!(await getFeatures()).tricount) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const blocked = blockEmailOnlyExpenseWrite(session);
  if (blocked) return blocked;

  const body = await req.json().catch(() => ({}));
  const { date, name } = body as { date?: unknown; name?: unknown };

  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "Date invalide" }, { status: 400 });
  }
  const cleanName = typeof name === "string" ? name.trim() : "";
  if (cleanName.length === 0 || cleanName.length > MAX_GUEST_NAME_LEN) {
    return NextResponse.json(
      { error: `Nom invalide (1 à ${MAX_GUEST_NAME_LEN} caractères)` },
      { status: 400 },
    );
  }

  const tricount = await prisma.tricount.upsert({
    where: { date },
    update: {},
    create: { date },
  });
  const guest = await prisma.tricountGuest.upsert({
    where: { tricountId_name: { tricountId: tricount.id, name: cleanName } },
    update: {},
    create: { tricountId: tricount.id, name: cleanName },
  });
  return NextResponse.json({ id: guest.id, tricountId: tricount.id, name: guest.name });
}
