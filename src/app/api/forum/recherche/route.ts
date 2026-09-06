import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { getFeatures } from "@/lib/features-server";
import { SELECT_MESSAGE, shapeMessage } from "@/lib/forum-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Plafond du corpus rendu. Le fil est borné à 12 mois pour ~30 membres : quelques centaines à
 * quelques milliers de messages, soit au grand maximum un méga-octet de texte. Deux mille est
 * donc très au-dessus de l'usage réel, et reste une réponse qu'un téléphone charge et filtre
 * sans y penser.
 *
 * Le plafond existe malgré tout, parce qu'une route qui rend « tout » sans borne rend un jour
 * ce que personne n'avait prévu. Quand il mord, la réponse le DIT (`tronque`) au lieu de faire
 * silencieusement une recherche partielle — voir plus bas.
 */
const MAX_CORPUS = 2000;

/**
 * GET /api/forum/recherche -> { messages, tronque }
 *
 * LE CORPUS ENTIER DU FIL, pour que la recherche se fasse dans le navigateur.
 *
 * POURQUOI PAS UN `?q=` CÔTÉ SERVEUR. Un `ILIKE '%reserve%'` ne trouve pas « réservé » : il
 * faudrait l'extension `unaccent`, un index trigramme, et le premier `$queryRaw` métier du
 * dépôt — tout cela pour interroger un méga-octet. Le filtre en mémoire, lui, réutilise le
 * repli sans accent qu'on écrit de toute façon pour SOULIGNER le terme trouvé, et rend la
 * frappe instantanée. C'est le dimensionnement qui décide, pas le principe : le jour où le fil
 * pèserait cent fois plus, cette route deviendrait `?q=` et l'écran ne changerait qu'à peine.
 *
 * POURQUOI UNE ROUTE À PART et non un troisième mode du `GET /api/forum`. Celui-ci porte déjà
 * un contrat difficile (`complet` / `fenetre` / élagage, cf. son en-tête) où chaque champ dit
 * au client s'il doit SUBSTITUER, COMPLÉTER ou ÉLAGUER son état. Y greffer une réponse d'une
 * autre forme, que le client ne doit surtout pas fusionner dans le fil, c'était ajouter un cas
 * particulier au seul endroit du fil qui n'en supporte pas.
 *
 * CE QUE LA RÉPONSE NE PORTE PAS : ni réactions, ni sondages. Une vue de recherche est une vue
 * de LECTURE — l'écran y rend les bulles sans pastille ni action (voir Forum.tsx). Les charger
 * pour deux mille messages coûterait six ordres SQL sur des milliers de lignes, à chaque
 * ouverture de la recherche, pour un affichage qu'on a délibérément choisi de ne pas faire.
 *
 * Les lignes sont mises en forme par `shapeMessage`, exactement comme celles du fil : la
 * citation reste RELUE par jointure, et rien du texte d'un membre n'est recopié nulle part.
 */
export async function GET(req: NextRequest) {
  if (!(await getFeatures()).forum) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  // `desc` puis `+1` : c'est la tranche la plus RÉCENTE qu'on garde quand le plafond mord.
  // Trier `asc` aurait rendu les deux mille plus anciens — exactement ceux qu'on ne cherche
  // jamais — et la troncature serait passée inaperçue.
  const rows = await prisma.forumMessage.findMany({
    orderBy: { createdAt: "desc" },
    take: MAX_CORPUS + 1,
    select: SELECT_MESSAGE,
  });
  const tronque = rows.length > MAX_CORPUS;
  const page = tronque ? rows.slice(0, MAX_CORPUS) : rows;

  return NextResponse.json({
    // Remis du plus ANCIEN au plus récent, comme le fil : les résultats se lisent dans le même
    // sens que la conversation, et le composant n'a rien à retourner.
    messages: page.reverse().map(shapeMessage),
    // Une recherche qui ne couvre qu'une partie du fil sans le dire est pire que pas de
    // recherche du tout : on conclut « personne n'en a jamais parlé » d'un silence qui n'est
    // que le plafond. L'écran affiche l'avertissement quand ce drapeau est levé.
    tronque,
  });
}
