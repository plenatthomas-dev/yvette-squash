import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { getFeatures } from "@/lib/features-server";
import type { HistorySeries } from "@/lib/ranking-history";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/rankings/history
//
// L'HISTORIQUE DU CLASSEMENT FÉDÉRAL de tous les joueurs mesurés, pour la courbe de
// progression. Deux populations mêlées, comme l'annuaire : un MEMBRE ou un joueur d'équipe
// SANS COMPTE — à l'écran, un joueur est un joueur.
//
// TOUT EST RENVOYÉ D'UN COUP, ET LE FILTRE EST CÔTÉ CLIENT. C'est le point de conception de cet
// écran : on y bouge une plage de mois et on coche des joueurs, deux gestes qu'on refait dix
// fois de suite. Les servir par des allers-retours rendrait chaque coche perceptible, pour un
// volume qui tient dans une poignée de kilo-octets — quarante joueurs sur deux ans font mille
// lignes de cinq nombres. La borne `MOIS_MAX` empêche seulement ce chiffre de grandir sans fin
// à mesure que les saisons s'accumulent.
//
// CE QUI EST EXPOSÉ, ET CE QUI NE L'EST PAS. Le nom, l'équipe et les mesures publiées par la
// fédération (classement, rangs, moyenne) ; jamais la licence, jamais le club rapproché, jamais
// l'email — ce sont des données de traçabilité interne, et l'annuaire ne les montre pas non
// plus. La liste couvre exactement les joueurs que la passe mensuelle mesure déjà : les membres
// opt-in de l'annuaire et ceux alignés en interclub (cf. `subjectsToRefresh`).
//
// Réservé aux membres connectés + gated par le flag `ranking`.

/**
 * Profondeur maximale renvoyée, en périodes fédérales. Trois ans : au-delà, la courbe n'est
 * plus lue, et la charge utile grandirait à chaque saison sans que personne ne le demande.
 */
const MOIS_MAX = 36;

export async function GET(req: NextRequest) {
  const { ranking, interclub } = await getFeatures();
  if (!ranking) {
    return NextResponse.json({ error: "Classement désactivé" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  // Les périodes réellement présentes, les plus récentes d'abord pour la coupe — puis remises
  // dans l'ordre chronologique, qui est celui de la courbe.
  const moisRows = await prisma.squashnetRankingPoint.findMany({
    distinct: ["month"],
    select: { month: true },
    orderBy: { month: "desc" },
    take: MOIS_MAX,
  });
  const months = moisRows.map((m) => m.month).reverse();
  if (months.length === 0) {
    return NextResponse.json({ months: [], series: [] });
  }

  const points = await prisma.squashnetRankingPoint.findMany({
    where: { month: { in: months } },
    orderBy: { month: "asc" },
    select: {
      month: true,
      clt: true,
      rang: true,
      rangM: true,
      mean: true,
      user: {
        select: {
          id: true,
          displayName: true,
          nickname: true,
          // L'équipe ne sort que si la fonction interclub est active — même garde que
          // l'annuaire : un flag à `0` doit rendre les équipes aussi invisibles que leur onglet.
          team: interclub ? { select: { name: true } } : false,
        },
      },
      guest: {
        select: { id: true, name: true, team: interclub ? { select: { name: true } } : false },
      },
    },
  });

  // Regroupement par joueur. Les points arrivent déjà triés par mois : chaque série est donc
  // chronologique sans nouveau tri, ce que la courbe suppose.
  const parJoueur = new Map<string, HistorySeries>();
  for (const p of points) {
    const sujet = p.user
      ? {
          cle: `member:${p.user.id}`,
          id: p.user.id,
          kind: "member" as const,
          // Le pseudo s'il existe, comme partout où un membre s'affiche.
          name: p.user.nickname ?? p.user.displayName,
          team: p.user.team?.name ?? null,
        }
      : p.guest
        ? {
            // Préfixé, comme dans l'annuaire : rien ne garantit qu'un identifiant d'invité ne
            // ressemble pas à celui d'un compte, et les deux partagent une liste (donc des clés).
            cle: `guest:${p.guest.id}`,
            id: `guest:${p.guest.id}`,
            kind: "guest" as const,
            name: p.guest.name,
            team: p.guest.team?.name ?? null,
          }
        : null;
    // Une ligne sans sujet est impossible (contrainte `sn_point_un_seul_sujet`) ; l'ignorer
    // plutôt que de la laisser lever garde l'écran debout si la contrainte tombe un jour.
    if (!sujet) continue;

    const serie =
      parJoueur.get(sujet.cle) ??
      { id: sujet.id, kind: sujet.kind, name: sujet.name, team: sujet.team, points: [] };
    serie.points.push({ month: p.month, clt: p.clt, rang: p.rang, rangM: p.rangM, mean: p.mean });
    parJoueur.set(sujet.cle, serie);
  }

  const series = [...parJoueur.values()].sort((a, b) =>
    a.name.localeCompare(b.name, "fr", { sensitivity: "base" }),
  );
  return NextResponse.json({ months, series });
}
