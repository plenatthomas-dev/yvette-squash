import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { getFeatures } from "@/lib/features-server";
import { allTeamGuests } from "@/lib/interclub-roster";

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
// Annuaire des JOUEURS DU CLUB. Deux populations, une seule liste :
//
//  * les MEMBRES opt-in (`listed`) — le cas historique. Pour chacun, { id, name } et le
//    classement si la fonction est active ; JAMAIS l'email ni le contactId (l'email reste une
//    clé d'identité interne) ;
//  * les joueurs d'une ÉQUIPE INTERCLUB SANS COMPTE (`InterclubGuest`). Ils jouent le
//    championnat sous les couleurs du club sans avoir jamais ouvert l'appli — souvent
//    délibérément —, et leur absence de l'annuaire donnait une photo fausse de l'effectif :
//    on cherchait quelqu'un qu'on avait vu jouer la veille et il n'existait pas.
//
// Une entrée porte donc son `kind`. Il n'est PAS cosmétique : les autres consommateurs de
// `/api/directory` (délégation de droits, têtes de série d'un tournoi) proposent des actions
// qui supposent un COMPTE, et doivent écarter les joueurs qui n'en ont pas — cf.
// `accountHolders` dans `lib/directoryCache.ts`.
//
// Réservé aux membres connectés + gated par flag.
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

  const [users, guests] = await Promise.all([
    prisma.user.findMany({
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
        // Et la correction du RANG MIXTE, pour la même raison : depuis que l'ordre des simples
        // interclub s'en sert, un admin peut en forcer un — le taire ici laisserait l'annuaire
        // trier un membre corrigé à une place que plus rien ne justifie.
        interclubRangMOverride: ranking,
        // Équipe interclub où le membre est aligné : jointure seulement si la fonction est active.
        team: interclub ? { select: { id: true, name: true } } : false,
      },
    }),
    // Les joueurs sans compte n'existent QUE par l'interclub : fonction coupée, aucun n'est lu.
    // Ce n'est pas une optimisation, c'est la même garde que partout ailleurs — le flag à `0`
    // doit rendre le roster des équipes aussi invisible que l'onglet qui le sert.
    interclub ? allTeamGuests() : Promise.resolve([]),
  ]);
  // Le nom des équipes, pour nommer celle d'un invité : `allTeamGuests` ne rend qu'un `teamId`,
  // et l'annuaire affiche un libellé. Une requête de plus seulement quand il y a des invités.
  const teamNames = new Map<string, string>(
    guests.length
      ? (await prisma.interclubTeam.findMany({ select: { id: true, name: true } })).map((t) => [
          t.id,
          t.name,
        ])
      : [],
  );

  // Nom affiché = pseudo si défini, sinon nom réel. Tri alpha (insensible casse/accents) :
  // c'est l'ordre par défaut de l'annuaire, le client peut rebasculer sur le classement.
  // Si le classement est actif, on expose clt (badge) + rang (rang dans son genre, tri des
  // têtes de série) + rangM (rang MIXTE : le nombre affiché et trié dans l'annuaire, seule
  // échelle comparable entre tous) + cat (info-bulle) ; jamais la licence ni le club
  // (données de traçabilité internes).
  //
  // `clt` ET `rangM` PRIORISENT la correction admin (`interclubCltOverride`,
  // `interclubRangMOverride`) sur le rapprochement squashnet — même règle qu'en composition
  // d'interclub (`memberClt`/`memberRangM`, `interclub-roster.ts`) : c'est ce qui rend visible
  // le classement d'un membre jamais rapproché (pas encore licencié, licence mal orthographiée
  // côté ResaMania…) sans attendre que squashnet le résolve de lui-même.
  //
  // `rang` (le rang DANS SON GENRE) et `cat`, eux, ne viennent QUE du rapprochement : ils ne
  // se corrigent nulle part, faute d'un écran qui les demande — le premier ne sert qu'aux têtes
  // de série du tournoi, le second qu'à une info-bulle.
  const memberRows = users
    .map((u) => {
      const clt = u.interclubCltOverride ?? u.squashnetRanking?.clt ?? null;
      const rangM = u.interclubRangMOverride ?? u.squashnetRanking?.rangM ?? null;
      return {
        id: u.id,
        kind: "member" as const,
        name: u.nickname ?? u.displayName,
        ...(ranking && clt
          ? {
              clt,
              // `rangM` sort du rapprochement OU de la correction, d'où sa sortie du bloc
              // `squashnetRanking` : un membre corrigé de bout en bout n'a aucune ligne
              // rapprochée, et resterait sinon sans rang dans l'annuaire.
              ...(rangM != null ? { rangM } : {}),
              ...(u.squashnetRanking
                ? { rang: u.squashnetRanking.rang, cat: u.squashnetRanking.cat }
                : {}),
            }
          : {}),
        // `team` reste absent quand la fonction est coupée ou le membre non aligné : le client
        // n'affiche la colonne que si au moins un membre en porte une.
        ...(interclub && u.team ? { team: u.team.name } : {}),
      };
    });

  // Un joueur sans compte n'a ni pseudo, ni `rang` dans son genre, ni catégorie d'âge : son
  // rapprochement squashnet n'en retient que ce qui sert l'ordre des simples. Il porte donc
  // strictement ce que l'annuaire sait montrer de lui — et son équipe, toujours, puisque c'est
  // la seule raison pour laquelle il y figure.
  const guestRows = guests.map((g) => ({
    // Préfixé : rien ne garantit qu'un identifiant d'invité ne ressemble pas à celui d'un
    // compte, et les deux populations partagent maintenant une liste (donc des clés React).
    id: `guest:${g.id}`,
    kind: "guest" as const,
    name: g.name,
    ...(ranking && g.clt ? { clt: g.clt, ...(g.rangM != null ? { rangM: g.rangM } : {}) } : {}),
    ...(teamNames.has(g.teamId) ? { team: teamNames.get(g.teamId) as string } : {}),
  }));

  // UNE liste triée par nom, les deux populations mêlées : à l'écran, un joueur est un joueur.
  // Les séparer en deux sections obligerait à savoir dans laquelle chercher — exactement ce
  // qu'on ne sait pas quand on cherche quelqu'un.
  const members = [...memberRows, ...guestRows].sort((a, b) =>
    a.name.localeCompare(b.name, "fr", { sensitivity: "base" }),
  );

  return NextResponse.json({ members, groupUrl: whatsappGroupUrl() });
}
