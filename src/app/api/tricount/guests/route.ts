import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { MAX_GUEST_NAME_LEN } from "@/lib/tricount";
import { getFeatures } from "@/lib/features-server";
import { readJsonBody } from "@/lib/http-tx";
import { gesteRefuse } from "@/lib/geste-debit";
import { blockEmailOnlyExpenseWrite } from "@/lib/tricount-guard";
import { dateSaisieRecevable } from "@/lib/date-saisie";

export const runtime = "nodejs";

// Bornes du garde-fou anti-emballement (cf. son usage plus bas). Le compteur vit en base, pas
// en mémoire : les fonctions serverless n'en partagent aucune. La fenêtre ne doit pas dépasser
// 15 min (journal partagé, cf. lib/geste-debit.ts — vérifié à l'appel).
const GUEST_WINDOW_MS = 10 * 60_000; // 10 min glissantes
const MAX_GUESTS_PER_WINDOW = 20;
// Âge au-delà duquel un tricount SANS AUCUNE DÉPENSE est un brouillon abandonné (cf. la purge).
const EMPTY_TRICOUNT_TTL_MS = 24 * 3600_000;
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

  // Date RÉELLE et vraisemblable, pas seulement bien formée : « 2026-13-01 » finissait en 500
  // Prisma, « 2026-02-30 » en tricount fantôme (cf. lib/date-saisie.ts).
  if (!dateSaisieRecevable(date)) {
    return NextResponse.json({ error: "Date invalide" }, { status: 400 });
  }
  const cleanName = typeof name === "string" ? name.trim() : "";
  if (cleanName.length === 0 || cleanName.length > MAX_GUEST_NAME_LEN) {
    return NextResponse.json(
      { error: `Nom invalide (1 à ${MAX_GUEST_NAME_LEN} caractères)` },
      { status: 400 },
    );
  }

  // Garde-fou anti-emballement : le club est sur invitation, donc le risque n'est pas l'inconnu
  // malveillant mais le client qui boucle ou le compte compromis, qui rempliraient la base. Les
  // invités n'étaient bornés que par l'unicité `(tricountId, name)` — c'est-à-dire pas bornés :
  // il suffit de changer de prénom, ou de date. Volontairement LARGE : une vraie soirée en
  // compte deux ou trois.
  //
  // ⚠️ COMPTÉ PAR MEMBRE, DANS LE JOURNAL DES GESTES — et non plus sur `TricountGuest` filtré
  // par `tricount: { date }`. Ce filtre-là promettait d'empêcher le contournement « par la
  // date » et l'offrait : changer de date remettait le compteur à zéro, et chaque date créait
  // au passage un tricount vide. `TricountGuest` ne dit pas QUI l'a créé (pas de colonne, et
  // pas de migration pour un garde-fou) ; le journal des gestes, lui, est déjà là
  // (lib/geste-debit.ts) et compte par membre, toutes dates confondues. Une limite GLOBALE sur
  // `TricountGuest` aurait aussi fermé la porte, mais au prix de compter les joueurs du club
  // sans compte que `lierJoueurs` rattache aux dépenses interclub — et un membre qui boucle
  // aurait bloqué tout le club.
  if (await gesteRefuse(`tricount-guest:${session.userId}`, GUEST_WINDOW_MS, MAX_GUESTS_PER_WINDOW)) {
    return NextResponse.json(
      { error: "Trop d'invités ajoutés d'un coup. Reprends dans quelques minutes." },
      { status: 429 },
    );
  }

  // PURGE DES BROUILLONS ABANDONNÉS. Cette route crée le tricount de la date dès le premier
  // invité, avant toute dépense ; saisir un invité puis renoncer laissait un tricount vide que
  // rien ne supprimait jamais (la liste les masque, mais ils s'accumulent en base). On les
  // efface au passage, ici même puisque c'est ici qu'ils naissent : SANS AUCUNE dépense, créés
  // il y a plus de 24 h — le temps de finir une soirée commencée la veille — et jamais celui de
  // la date visée, qu'on s'apprête à réutiliser. La cascade emporte leurs invités et leurs
  // éventuels messages, invisibles de toute façon tant qu'aucune dépense n'existe.
  await prisma.tricount.deleteMany({
    where: {
      expenses: { none: {} },
      createdAt: { lt: new Date(Date.now() - EMPTY_TRICOUNT_TTL_MS) },
      date: { not: date },
    },
  });

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
