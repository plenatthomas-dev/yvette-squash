import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { cronAuthorized } from "@/lib/cron-auth";
import { FEATURE_RANKING } from "@/lib/features";
import { getLatestMonth, searchRanking } from "@/lib/squashnet/client";
import { matchRanking } from "@/lib/squashnet/match";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET /api/cron/warm-rankings
// Rafraîchit le classement fédéral (squashnet.fr, source publique) des membres OPT-IN de
// l'annuaire (`listed`). Pour chacun : recherche par nom, rapprochement SÛR (nom+club) ;
// upsert si trouvé, suppression du classement obsolète sinon (le membre n'apparaît plus
// classé). Séquentiel (doux pour squashnet), idempotent. Mensuel (le classement bouge 1×/mois).
export async function GET(req: NextRequest) {
  if (!FEATURE_RANKING) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  if (!cronAuthorized(req)) {
    return NextResponse.json({ error: "Interdit" }, { status: 401 });
  }

  const month = await getLatestMonth();
  if (!month) {
    return NextResponse.json({ matched: 0, reason: "Période de classement introuvable." });
  }

  // On matche sur le VRAI nom (displayName), jamais le pseudo (nickname).
  const members = await prisma.user.findMany({
    where: { listed: true },
    select: { id: true, displayName: true },
  });

  let matched = 0;
  let cleared = 0;
  for (const m of members) {
    const name = m.displayName.trim();
    if (!name) continue;
    // displayName = « Prénom Nom » → on interroge squashnet par le dernier mot (≈ nom de
    // famille) ; la recherche fait un « contient » sur « NOM PRÉNOM », donc l'ordre importe peu.
    const tokens = name.split(/\s+/);
    const query = tokens[tokens.length - 1];
    try {
      const rows = await searchRanking(query, { month });
      const hit = matchRanking({ givenName: "", familyName: name }, rows);
      if (hit) {
        await prisma.squashnetRanking.upsert({
          where: { userId: m.id },
          update: { clt: hit.clt, rang: hit.rang, licence: hit.licence, cat: hit.cat, club: hit.club, month },
          create: {
            userId: m.id,
            clt: hit.clt,
            rang: hit.rang,
            licence: hit.licence,
            cat: hit.cat,
            club: hit.club,
            month,
          },
        });
        matched++;
      } else {
        // Plus de rapprochement sûr → on retire un éventuel classement devenu obsolète.
        const del = await prisma.squashnetRanking.deleteMany({ where: { userId: m.id } });
        cleared += del.count;
      }
    } catch {
      // Erreur ponctuelle squashnet (timeout, 5xx) → on n'écrase rien, on continue.
    }
  }

  return NextResponse.json({ month, members: members.length, matched, cleared });
}
