import { NextRequest, NextResponse } from "next/server";
import { requireInterclubMember } from "@/lib/interclub-access";
import { estIdentifiant, ficheEquipeEnBase, ficheEquipeRafraichie } from "@/lib/interclub-team-sheet-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Au plus deux requêtes fédérales espacées (la poule, puis l'effectif) : quelques secondes.
export const maxDuration = 60;

// GET  /api/interclub/poule/equipe?snTeamId=…  — la fiche d'une équipe de nos poules, en base.
// POST /api/interclub/poule/equipe?snTeamId=…  — la même, après relecture de ce qui a vieilli.
//
// TOUCHER UNE ÉQUIPE DU CLASSEMENT : ses rencontres, le détail de chacune, son effectif. C'est le
// même arbitrage que `opponents` : `GET` relit ce qu'on a, tout de suite ; `POST` va chercher chez
// la ligue ce qui est trop ancien (cf. `interclub-team-sheet-db.ts`), et l'écran ne l'appelle que
// si `GET` a répondu `stale`.
//
// OUVERT À TOUT MEMBRE, comme le classement qu'elle prolonge. Les données sont publiques sur
// squashnet ; ce qui est protégé, c'est squashnet lui-même : l'équipe doit figurer au classement
// d'une de nos poules, sinon 404 — sans une requête fédérale.

async function handle(req: NextRequest, rafraichir: boolean) {
  const access = await requireInterclubMember(req);
  if (!access.ok) return access.response;

  const snTeamId = req.nextUrl.searchParams.get("snTeamId");
  if (!estIdentifiant(snTeamId)) {
    return NextResponse.json({ error: "Équipe inconnue" }, { status: 400 });
  }
  const fiche = rafraichir ? await ficheEquipeRafraichie(snTeamId) : await ficheEquipeEnBase(snTeamId);
  if (!fiche) return NextResponse.json({ error: "Équipe absente de nos poules" }, { status: 404 });
  return NextResponse.json(fiche, { headers: { "Cache-Control": "no-store" } });
}

export function GET(req: NextRequest) {
  return handle(req, false);
}

export function POST(req: NextRequest) {
  return handle(req, true);
}
