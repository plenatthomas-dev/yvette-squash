import { NextRequest, NextResponse } from "next/server";
import { requireInterclubMember } from "@/lib/interclub-access";
import { estIdentifiant, ficheJoueurEnBase, ficheJoueurRafraichie } from "@/lib/interclub-team-sheet-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET  /api/interclub/poule/joueur?regiid=…  — les matchs d'un joueur, depuis la base.
// POST /api/interclub/poule/joueur?regiid=…  — les mêmes, après relecture de sa fiche fédérale.
//
// Même arbitrage, même ouverture et même garde que `poule/equipe` : le joueur doit figurer dans
// nos données (une rencontre de nos poules, ou un effectif rangé), sinon 404 — sans requête.
// Une fiche jamais lue n'est pas vide pour autant : ses matchs dans nos poules sont tirés des
// rencontres (`source: "poule"`), en attendant que `POST` apporte la fiche complète.

async function handle(req: NextRequest, rafraichir: boolean) {
  const access = await requireInterclubMember(req);
  if (!access.ok) return access.response;

  const regiid = req.nextUrl.searchParams.get("regiid");
  if (!estIdentifiant(regiid)) {
    return NextResponse.json({ error: "Joueur inconnu" }, { status: 400 });
  }
  const fiche = rafraichir ? await ficheJoueurRafraichie(regiid) : await ficheJoueurEnBase(regiid);
  if (!fiche) return NextResponse.json({ error: "Joueur absent de nos poules" }, { status: 404 });
  return NextResponse.json(fiche, { headers: { "Cache-Control": "no-store" } });
}

export function GET(req: NextRequest) {
  return handle(req, false);
}

export function POST(req: NextRequest) {
  return handle(req, true);
}
