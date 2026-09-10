import { NextResponse, type NextRequest } from "next/server";
import { getFeatures } from "./features-server";
import { getSession, type AppSession } from "./session";
import { isAdminEmail } from "./admin";
import { prisma } from "./db";

// ============================================================================
//  LE CAPITAINE — ET LE SEUL ENDROIT OÙ C'EST UN DROIT.
//
//  ⚠️ CECI RENVERSE UNE DÉCISION DOCUMENTÉE, et il faut le savoir avant de lire
//  la suite. `interclub-access.ts` énonce, en tête : « Il n'y a qu'un seul rôle :
//  MEMBRE CONNECTÉ », et `docs/interclub.md` en fait une section entière — le
//  capitaine y est « une désignation, pas un droit ». Cette doctrine reste vraie
//  PARTOUT AILLEURS : composer une équipe, prendre le marquage, corriger un
//  score interne demeurent ouverts à tout membre, et ce module n'y touche pas.
//
//  Ce qui change ici, et pourquoi. Le score OFFICIEL ne vit pas dans l'appli : un
//  capitaine le saisit chez la fédération, le capitaine adverse le valide. Ces
//  gestes-là ne se corrigent pas d'un tap — ils engagent la responsabilité de
//  celui qui les pose devant sa ligue, et ils sont visibles de tous les clubs de
//  la poule. La doctrine d'origine réserve déjà ses restrictions à ce qui
//  « protège quelqu'un d'un ÉCRASEMENT » ; on reste dans cette logique, à ceci
//  près que ce qu'on protège est dehors.
//
//  LA PORTÉE EST L'ÉQUIPE, JAMAIS LE CLUB. Un capitaine ne peut rien sur l'équipe
//  d'en face — pas par méfiance, mais parce que c'est la réalité de son accès
//  fédéral : il ne couvre que la sienne. Une portée plus large dans l'appli que
//  chez la fédération promettrait un geste qui échouerait au bout du chemin.
//
//  L'ADMIN PASSE, comme partout ailleurs dans ce dépôt (`isAdminEmail`). Ce n'est
//  pas une porte dérobée : c'est le filet le soir où le capitaine est injoignable
//  et où la ligue attend un score.
// ============================================================================

/**
 * Résultat du contrôle. Union discriminée, comme `InterclubAccess` : l'appelant voit dans sa
 * signature qu'il y a deux chemins, et TypeScript refuse de lui laisser lire `teamIds` sans
 * avoir traité le refus.
 */
export type CaptainAccess =
  | { ok: true; session: AppSession; teamIds: string[]; isAdmin: boolean }
  | { ok: false; response: NextResponse };

/**
 * Les équipes dont ce membre est capitaine. Une LISTE et non une valeur : le capitanat
 * appartient à l'équipe, et rien n'interdit d'en tenir deux (cf. `InterclubTeam.captainOf`).
 *
 * Exporté parce que `/api/auth/me` en a besoin pour dire au client s'il doit afficher l'onglet,
 * et qu'il n'a pas de `NextRequest` à passer à un contrôle d'accès.
 */
export async function captainTeams(userId: string): Promise<{ id: string; name: string }[]> {
  return prisma.interclubTeam.findMany({
    where: { captainId: userId },
    select: { id: true, name: true },
    orderBy: { order: "asc" },
  });
}

/**
 * Les trois contrôles, dans CET ordre, et l'ordre est le même que celui de
 * `requireInterclubMember` — pour la même raison :
 *
 *   1. le FLAG d'abord → 404. Une fonction coupée doit répondre « cette route n'existe pas
 *      ici », y compris à un visiteur non connecté : tester la session en premier lui
 *      répondrait 401, ce qui révèle qu'il y a quelque chose à cette adresse ;
 *   2. la SESSION → 401 ;
 *   3. le RÔLE → 403. Distinct du 401 à dessein : « je ne sais pas qui tu es » et « je sais qui
 *      tu es, et ce n'est pas pour toi » appellent deux réactions différentes côté client.
 */
async function garde(
  req: NextRequest,
): Promise<
  { ok: false; response: NextResponse } | { ok: true; session: AppSession; isAdmin: boolean }
> {
  if (!(await getFeatures()).interclub) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Fonction indisponible" }, { status: 404 }),
    };
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return { ok: false, response: NextResponse.json({ error: "Non authentifié" }, { status: 401 }) };
  }
  return { ok: true, session, isAdmin: isAdminEmail(session.email) };
}

const refus = (): { ok: false; response: NextResponse } => ({
  ok: false,
  response: NextResponse.json({ error: "Réservé aux capitaines" }, { status: 403 }),
});

/**
 * Capitaine d'AU MOINS une équipe — la garde des écrans qui listent (« mes rencontres à
 * vérifier »). `teamIds` borne ce que la route a le droit de lire : elle ne doit jamais
 * repartir de zéro pour décider.
 *
 * Un admin qui n'est capitaine de rien passe avec une liste VIDE, et c'est voulu : les routes
 * de liste traitent `isAdmin` comme « toutes les équipes », celles qui visent une rencontre
 * précise passent par `requireCaptainOf`. Rendre ici la liste complète des équipes pour un
 * admin ferait dire à `teamIds` deux choses différentes selon qui appelle.
 */
export async function requireCaptain(req: NextRequest): Promise<CaptainAccess> {
  const g = await garde(req);
  if (!g.ok) return g;
  const teams = await captainTeams(g.session.userId);
  if (teams.length === 0 && !g.isAdmin) return refus();
  return { ok: true, session: g.session, teamIds: teams.map((t) => t.id), isAdmin: g.isAdmin };
}

/**
 * Capitaine de CETTE équipe — la garde de tout ce qui touche à UNE rencontre.
 *
 * C'est elle qui empêche le capitaine de l'Équipe 1 d'agir sur une rencontre de l'Équipe 2. Le
 * contrôle porte sur l'équipe de la RENCONTRE, jamais sur celle du membre : un joueur peut
 * dépanner en équipe 2 tout en étant capitaine de la 1, et c'est bien son capitanat qui décide.
 */
export async function requireCaptainOf(req: NextRequest, teamId: string): Promise<CaptainAccess> {
  const g = await garde(req);
  if (!g.ok) return g;
  const teams = await captainTeams(g.session.userId);
  const ids = teams.map((t) => t.id);
  if (!ids.includes(teamId) && !g.isAdmin) return refus();
  return { ok: true, session: g.session, teamIds: ids, isAdmin: g.isAdmin };
}
