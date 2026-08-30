import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { MAX_GUEST_NAME_LEN } from "@/lib/tricount";
import { getFeatures } from "@/lib/features-server";
import { readJsonBody } from "@/lib/http-tx";
import { blockEmailOnlyExpenseWrite } from "@/lib/tricount-guard";

export const runtime = "nodejs";

// Bornes du garde-fou anti-emballement (cf. son usage plus bas). Le compteur vit en base, pas
// en mémoire : les fonctions serverless n'en partagent aucune.
const GUEST_WINDOW_MS = 10 * 60_000; // 10 min glissantes
const MAX_GUESTS_PER_WINDOW = 20;
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

  const body = await readJsonBody(req);
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

  // Garde-fou anti-emballement, même motif et même forme que le fil de commentaires : le club
  // est sur invitation, donc le risque n'est pas l'inconnu malveillant mais le client qui
  // boucle ou le compte compromis, qui rempliraient la base. Les invités n'étaient bornés que
  // par l'unicité `(tricountId, name)` — c'est-à-dire pas bornés : il suffit de changer de
  // prénom, ou de date. Volontairement LARGE : une vraie soirée en compte deux ou trois.
  const recents = await prisma.tricountGuest.count({
    where: {
      createdAt: { gte: new Date(Date.now() - GUEST_WINDOW_MS) },
      tricount: { date },
    },
  });
  if (recents >= MAX_GUESTS_PER_WINDOW) {
    return NextResponse.json(
      { error: "Trop d'invités ajoutés d'un coup. Reprends dans quelques minutes." },
      { status: 429 },
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
