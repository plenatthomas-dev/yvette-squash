import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { getFeatures } from "@/lib/features-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Lien d'invitation du groupe WhatsApp de l'asso. Volontairement en variable d'env SERVEUR
// (pas NEXT_PUBLIC) : on ne le renvoie qu'aux membres connectés, il ne traîne pas dans le
// bundle JS public. Absent/non-https → pas de bouton côté client (gate naturel, sans flag).
function whatsappGroupUrl(): string | null {
  const url = process.env.WHATSAPP_GROUP_URL;
  return url && url.startsWith("https://") ? url : null;
}

// GET /api/directory
// Annuaire des membres (idée 6). Renvoie UNIQUEMENT les joueurs opt-in (`listed`),
// et pour chacun seulement { id, name } — JAMAIS l'email ni le contactId (l'email
// reste une clé d'identité interne). Réservé aux membres connectés + gated par flag.
export async function GET(req: NextRequest) {
  // Un seul appel : `ranking` et `interclub` servent plus bas à décider des jointures.
  const { directory, ranking, interclub } = await getFeatures();
  if (!directory) {
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
      squashnetRanking: ranking
        ? { select: { clt: true, rang: true, rangM: true, cat: true } }
        : false,
      // Correction admin d'interclub (`interclub-roster.ts`, `memberClt`) : le seul classement
      // disponible pour un membre jamais rapproché sur squashnet (invité d'un autre club, pas
      // encore licencié…). Même priorité qu'en composition — voir plus bas.
      interclubCltOverride: ranking,
      // Équipe interclub où le membre est aligné : jointure seulement si la fonction est active.
      team: interclub ? { select: { id: true, name: true } } : false,
    },
  });

  // Nom affiché = pseudo si défini, sinon nom réel. Tri alpha (insensible casse/accents) :
  // c'est l'ordre par défaut de l'annuaire, le client peut rebasculer sur le classement.
  // Si le classement est actif, on expose clt (badge) + rang (rang dans son genre, tri des
  // têtes de série) + rangM (rang MIXTE : le nombre affiché et trié dans l'annuaire, seule
  // échelle comparable entre tous) + cat (info-bulle) ; jamais la licence ni le club
  // (données de traçabilité internes).
  //
  // `clt` PRIORISE la correction admin (`interclubCltOverride`) sur le rapprochement squashnet
  // — même règle qu'en composition d'interclub (`memberClt`, `interclub-roster.ts`) : c'est ce
  // qui rend visible le classement d'un membre jamais rapproché (pas encore licencié, licence
  // mal orthographiée côté ResaMania…) sans attendre que squashnet le résolve de lui-même.
  // `rang`/`rangM`/`cat`, eux, ne viennent QUE du rapprochement : une correction manuelle ne
  // porte qu'un classement, jamais de rang.
  const members = users
    .map((u) => {
      const clt = u.interclubCltOverride ?? u.squashnetRanking?.clt ?? null;
      return {
        id: u.id,
        name: u.nickname ?? u.displayName,
        ...(ranking && clt
          ? {
              clt,
              ...(u.squashnetRanking
                ? { rang: u.squashnetRanking.rang, rangM: u.squashnetRanking.rangM, cat: u.squashnetRanking.cat }
                : {}),
            }
          : {}),
        // `team` reste absent quand la fonction est coupée ou le membre non aligné : le client
        // n'affiche la colonne que si au moins un membre en porte une.
        ...(interclub && u.team ? { team: u.team.name } : {}),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "fr", { sensitivity: "base" }));

  return NextResponse.json({ members, groupUrl: whatsappGroupUrl() });
}
