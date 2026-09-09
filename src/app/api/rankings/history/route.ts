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
// plus.
//
// ⚠️ QUI EST EXPOSÉ SE FILTRE À LA LECTURE, ET PAS SEULEMENT À L'ÉCRITURE (cf. `sujetsVisibles`).
// Ce commentaire affirmait « la liste couvre exactement les joueurs que la passe mensuelle
// mesure déjà », et c'était faux : la requête ne portait aucune condition sur le sujet, donc
// elle couvrait tous les joueurs JAMAIS mesurés. Un membre qui se retirait de l'annuaire
// disparaissait de `/api/directory` et restait ici — nom, classement, rangs et moyenne, mois
// par mois — devant tout membre connecté. Sa courbe gelait (la passe cesse de le mesurer), ce
// qui rendait l'écart d'autant moins visible : rien ne bougeait plus, tout restait affiché.
//
// La table, elle, GARDE ses points : un opt-out masque, il n'efface pas un historique qu'un
// retour dans l'annuaire doit retrouver intact. C'est la lecture qui tranche.
//
// Réservé aux membres connectés + gated par les flags `ranking` ET `rankingHistory`.
//
// DEUX FLAGS, ET « ET » PLUTÔT QUE « OU ». `rankingHistory` existe parce que `ranking` est le
// seul flag ouvert en production : adossée à lui, cette courbe serait apparue devant les membres
// le jour de son merge, sans que personne l'ait décidé. Elle expose autre chose que le badge
// « 5A » — trois ans de trajectoire de chaque joueur, comparables entre eux — et cela se décide
// séparément. `ranking` reste exigé parce que c'est lui qui fait tourner la passe mensuelle : la
// courbe sans lui est un historique qui gèle sans le dire.

/**
 * Profondeur maximale renvoyée, en périodes fédérales. Trois ans : au-delà, la courbe n'est
 * plus lue, et la charge utile grandirait à chaque saison sans que personne ne le demande.
 */
const MOIS_MAX = 36;

/**
 * QUI A LE DROIT DE FIGURER SUR LA COURBE — le miroir exact de `subjectsToRefresh`.
 *
 * La passe mensuelle ne mesure que les membres OPT-IN de l'annuaire et ceux ALIGNÉS en
 * interclub (`{ OR: [{ listed: true }, { teamId: { not: null } }] }`). La lecture applique la
 * même règle, sans quoi l'opt-out d'annuaire ne masque rien ici : un membre qui décoche
 * « Annuaire des membres » sort de `/api/directory` mais garderait sa courbe nominative,
 * exactement ce que `PrivacyNotice` promet le contraire.
 *
 * ⚠️ Le membre RATTACHÉ À UNE ÉQUIPE reste visible même retiré de l'annuaire, et ce n'est pas
 * un oubli : c'est ce que la notice de confidentialité énonce noir sur blanc, et c'est la
 * contrepartie d'être aligné en championnat — le classement d'un joueur composé regarde son
 * équipe. La règle est la même à l'écriture et à la lecture, donc il n'y a qu'un endroit où en
 * discuter.
 *
 * ⚠️ Les joueurs SANS COMPTE n'existent QUE par l'interclub : fonction coupée, aucun n'est lu.
 * Le commentaire précédent annonçait « même garde que l'annuaire » alors que seule la JOINTURE
 * d'équipe était conditionnée — le nom de chaque invité du roster, son classement et sa courbe
 * sortaient quand même, sous un onglet Interclub affiché « bientôt ». C'est maintenant la même
 * garde, au sens propre : `api/directory` fait `interclub ? allTeamGuests() : []`.
 */
function sujetsVisibles(interclub: boolean) {
  const membre = { user: { is: { OR: [{ listed: true }, { teamId: { not: null } }] } } };
  return interclub ? { OR: [membre, { guest: { isNot: null } }] } : membre;
}

export async function GET(req: NextRequest) {
  const { ranking, rankingHistory, interclub } = await getFeatures();
  if (!ranking || !rankingHistory) {
    return NextResponse.json({ error: "Classement désactivé" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  // Les périodes réellement présentes, les plus récentes d'abord pour la coupe — puis remises
  // dans l'ordre chronologique, qui est celui de la courbe.
  //
  // ⚠️ `groupBy` ET NON `findMany({ distinct })`, ET LA DIFFÉRENCE N'EST PAS COSMÉTIQUE.
  // Le `distinct` de Prisma n'est pas un `SELECT DISTINCT` : sauf option de prévisualisation,
  // il est appliqué EN MÉMOIRE, après que la base a rendu ses lignes — donc APRÈS le `take`.
  // « Les 36 dernières périodes » demandait en réalité « les 36 dernières LIGNES, dédoublonnées
  // ensuite » : à quarante joueurs mesurés par mois, cela rendait UN mois, et la courbe se
  // coupait net à une date que rien n'expliquait. Le nombre de mois affichés dépendait du
  // nombre de joueurs, ce qui n'a aucun sens et ne se voyait pas.
  //
  // `groupBy` se traduit par un vrai `GROUP BY` : le `take` porte alors sur des MOIS.
  //
  // Le filtre de visibilité s'applique ICI AUSSI. Sans lui, un mois connu du seul joueur exclu
  // entrerait dans `months` et la courbe ouvrirait une colonne que rien ne remplit — un trou
  // qui dirait « personne n'a été mesuré ce mois-là » au lieu de « ce mois-là ne vous regarde
  // pas ».
  const visibles = sujetsVisibles(interclub);
  const moisRows = await prisma.squashnetRankingPoint.groupBy({
    by: ["month"],
    where: visibles,
    orderBy: { month: "desc" },
    take: MOIS_MAX,
  });
  const months = moisRows.map((m) => m.month).reverse();
  if (months.length === 0) {
    return NextResponse.json({ months: [], series: [] });
  }

  const points = await prisma.squashnetRankingPoint.findMany({
    where: { month: { in: months }, ...visibles },
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
          // L'équipe ne sort que si la fonction interclub est active : un flag à `0` doit
          // rendre les équipes aussi invisibles que leur onglet. La garde qui compte vraiment
          // est en amont (`sujetsVisibles`) — celle-ci ne fait que taire un libellé.
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
