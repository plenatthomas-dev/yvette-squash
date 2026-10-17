import { getSession } from "./session";
import { prisma } from "./db";
import { buildHandleMap } from "./handle";
import { isAdminSession } from "./admin";
import { countPendingRequests } from "./email-auth";
import { getAppBlock } from "./settings";
import { getFeatures } from "./features-server";
import { captainTeams } from "./captain-access";

// CE QUE LE CLIENT SAIT DE SON MEMBRE : servi par `GET /api/auth/me` ET rendu côté serveur
// dans la page d'accueil (audit 2026-10, point 26). Le layout est déjà dynamique (CSP à nonce) :
// lire la session pendant le rendu supprime l'aller-retour que l'écran d'accueil attendait
// avant de pouvoir s'afficher. Une seule fonction, pour que les deux ne divergent jamais.

export type MePayload = NonNullable<Awaited<ReturnType<typeof loadMe>>>;

/** `null` = pas de session valide (le client affiche l'écran de connexion). */
export async function loadMe(sid: string | undefined) {
  const session = await getSession(sid);
  if (!session) return null;
  // On renvoie :
  //  - displayName : nom réel (fallback du « Bonjour » si pas de pseudo)
  //  - nickname    : pseudonyme choisi (affiché en priorité dans le « Bonjour »)
  //  - handle      : token dé-doublonné du joueur pour les créneaux (pseudo tronqué
  //    ou diminutif). Calculé sur l'ensemble des joueurs → identique à la grille ;
  //    le client s'en sert pour la mise à jour optimiste des présences.
  //
  // ⚠️ LA ROUTE LA PLUS APPELÉE DE L'APPLI (chaque ouverture, chaque retour au premier plan).
  // Deux choses y coûtaient pour rien :
  //  - l'EMAIL de tous les membres était lu, rien que pour retrouver celui de l'appelant — or
  //    la session le porte déjà (`session.email` vient de la même ligne User, relue par
  //    `getSession` à chaque requête), et c'est lui que lisent toutes les autres routes pour
  //    `isAdminEmail`. On ne charge donc plus que ce que le calcul du handle exige (id, noms,
  //    date de création) plus `listed` pour l'appelant : aucune adresse ne transite plus ;
  //  - quatre lectures INDÉPENDANTES s'enchaînaient l'une après l'autre, chacune payant son
  //    aller-retour vers Neon. Elles partent maintenant ensemble.
  //
  // Admin (allowlist ADMIN_EMAILS) : pilote l'entrée « Admin » + son badge de demandes en attente.
  const isAdmin = isAdminSession(session);
  const [users, pendingRequests, block, captainOf] = await Promise.all([
    prisma.user.findMany({
      select: { id: true, displayName: true, nickname: true, listed: true, createdAt: true },
    }),
    isAdmin ? countPendingRequests() : 0,
    // Appli fermée par un admin : les sessions DÉJÀ ouvertes doivent l'apprendre ici. Sans ça,
    // bloquer la connexion n'aurait quasiment aucun effet le jour où on l'active — les sessions
    // durent 30 jours, donc presque personne n'a besoin de se reconnecter. `null` pour l'admin.
    isAdmin ? null : getAppBlock(),
    // ÉQUIPES DONT CE MEMBRE EST CAPITAINE — ce qui pilote l'onglet « Capitaine ».
    //
    // Même patron qu'`isAdmin` juste au-dessus : le client ne devine pas ses droits, le serveur
    // les lui dit. Une LISTE et non un booléen, parce que le capitanat appartient à l'équipe et
    // que rien n'interdit d'en tenir deux.
    //
    // Une requête de plus SEULEMENT quand la fonction interclub est active : flag à `0`, aucun
    // capitaine, aucun onglet — même garde qu'`/api/directory` sur ses jointures d'équipe.
    getFeatures().then((f) => (f.interclub ? captainTeams(session.userId) : [])),
  ]);
  const me = users.find((u) => u.id === session.userId);
  const handle = buildHandleMap(users).get(session.userId) ?? null;
  return {
    blocked: block?.message ?? null,
    // Id interne du membre : permet au client de se reconnaître dans les listes
    // issues de l'annuaire (ex. s'exclure du choix des délégués).
    id: session.userId,
    displayName: session.displayName,
    nickname: me?.nickname ?? null,
    // Visibilité annuaire (idée 6) : pilote la case opt-out des paramètres.
    listed: me?.listed ?? true,
    handle,
    // Pilote l'UI : "email" = session sans ResaMania (lecture seule, pas de réservation).
    //
    // ⚠️ `resaUnavailable` compte comme ResaMania : c'est un compte ResaMania dont le jeton n'a
    // pas pu être rafraîchi À L'INSTANT (panne passagère, cf. AppSession.resaUnavailable). Le
    // classer « email » faisait basculer tout l'écran en lecture seule — boutons « Réserver »
    // masqués, bandeau « compte email seul » — le temps d'une panne de ResaMania. On garde
    // l'interface telle quelle : une réservation tentée pendant la panne reçoit un 503 lisible
    // (« ResaMania ne répond pas, réessaie dans un instant »), ce qui dit la vérité.
    mode: session.resa || session.resaUnavailable ? "resamania" : "email",
    canBook: !!session.resa || !!session.resaUnavailable,
    // Présent (et `true`) seulement pendant une telle panne : de quoi afficher un bandeau
    // « ResaMania ne répond pas » si l'écran le souhaite. Absent sinon, pour ne rien changer à
    // la réponse ordinaire.
    ...(session.resaUnavailable ? { resaUnavailable: true } : {}),
    isAdmin,
    // `[]` pour l'écrasante majorité des membres : l'onglet est ABSENT, pas grisé. On ne montre
    // pas une porte qu'on ne peut pas ouvrir.
    captainOf,
    pendingRequests,
  };
}
