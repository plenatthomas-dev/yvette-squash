import { randomBytes } from "node:crypto";
import { prisma } from "./db";
import { encrypt, decrypt } from "./crypto";
import { ensureFresh, isResaAuthRejected, isOwnClub } from "./resamania/client";
import { ResaRefreshTransientError, isResaRefreshTransient } from "./resamania/errors";
import type { ResaIdentity, ResaSession } from "./resamania/types";
import type { User, Prisma } from "@prisma/client";

const SESSION_DAYS = 30;

function nameOf(id: ResaIdentity): string {
  return `${id.givenName} ${id.familyName}`.trim() || id.email || "Joueur";
}

/** Normalise un email pour servir de clé d'identité (trim + minuscules). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Retrouve (ou crée) LA ligne User d'une personne, l'email étant la clé d'identité
 * commune. ResaMania (contactId) est un simple attribut attaché à cette même ligne :
 *  - connexion ResaMania d'un membre déjà « email seul » → on lui ATTACHE le contactId
 *    (réconciliation, sans fusion ni migration de données) ;
 *  - connexion email d'un membre déjà connu de ResaMania → on retombe sur la même ligne.
 */
export async function resolveUser(input: {
  displayName: string;
  email?: string | null;
  contactId?: string | null;
}): Promise<User> {
  const email = input.email ? normalizeEmail(input.email) : null;
  const contactId = input.contactId ?? null;
  // ResaMania fait autorité sur l'email : une connexion ResaMania (contactId présent) prouve
  // la possession de l'email → on le marque vérifié s'il ne l'était pas déjà. Les parcours
  // « email seul » (sans contactId) ne posent PAS emailVerifiedAt ici ; c'est le clic sur le
  // lien reçu par mail (routes auth/email) qui le fait.
  const now = new Date();

  // 1) Déjà lié par contactId ? (membres ResaMania existants)
  if (contactId) {
    const byContact = await prisma.user.findUnique({ where: { contactId } });
    if (byContact) {
      // ResaMania fait autorité sur l'email… sauf s'il appartient déjà à une AUTRE ligne User
      // (un compte « email seul » ouvert avec l'adresse que le membre vient d'adopter côté
      // ResaMania). L'écraser violerait `User.email @unique` (P2002) : createSession lèverait,
      // et la connexion — pourtant réussie chez ResaMania — échouerait à CHAQUE tentative tant
      // que les deux lignes coexistent. On garde l'ancienne adresse et on le signale : fusionner
      // deux comptes est une décision d'admin, pas un effet de bord de la connexion.
      // Lecture supplémentaire seulement quand l'email CHANGE (rare) : le chemin courant n'en
      // paie aucune.
      let nextEmail = byContact.email;
      if (email && email !== byContact.email) {
        const owner = await prisma.user.findUnique({ where: { email }, select: { id: true } });
        if (owner && owner.id !== byContact.id) {
          console.warn(
            `[session] email ResaMania déjà porté par un autre compte (user ${owner.id}) : ` +
              `user ${byContact.id} garde son adresse actuelle`,
          );
        } else if (isAllowlistedAdminEmail(email)) {
          // Une adresse de l'allowlist admin ne s'ADOPTE pas par simple changement chez
          // ResaMania : rien ne garantit qu'ils l'aient vérifiée, et l'adopter donnerait les
          // droits d'admin (audit 2026-10, point 1). Un admin rattache la ligne à la main.
          console.warn(
            `[session] user ${byContact.id} : nouvelle adresse ResaMania dans ADMIN_EMAILS, non adoptée`,
          );
        } else {
          nextEmail = email;
        }
      }
      return prisma.user.update({
        where: { id: byContact.id },
        data: {
          displayName: input.displayName,
          email: nextEmail,
          ...(byContact.emailVerifiedAt ? {} : { emailVerifiedAt: now }),
        },
      });
    }
  }

  // 2) Sinon, jointure par email (clé d'identité commune).
  if (email) {
    const byEmail = await prisma.user.findUnique({ where: { email } });
    if (byEmail) {
      // Réconciliation : ResaMania fait autorité sur le contactId de CET email. On l'attache
      // s'il manquait, et on le MET À JOUR s'il a changé — cas d'une migration de club côté
      // ResaMania (août 2026 : `lecomplexbures` fermé → `omafitness`), où le même membre
      // reçoit un contactId tout neuf. Sans cette mise à jour, la base garde l'ancien : ses
      // réservations ne sont plus reconnues comme siennes (planning-annotate) et, pire, la
      // réconciliation du planning croit le créneau pris par un tiers et passe la résa en
      // "cancelled" (cf. api/planning : bookerContactId ≠ user.contactId).
      // Sûr vis-à-vis de l'unicité de `contactId` : si une AUTRE ligne le portait déjà,
      // l'étape 1 (jointure par contactId) l'aurait trouvée et on ne serait pas ici.
      //
      // ⚠️ Mais JAMAIS EN SILENCE quand la ligne en portait déjà un autre (audit 2026-10,
      // point 1) : l'e-mail que renvoie ResaMania fait foi pour l'identité, et un compte
      // ResaMania tout neuf créé avec l'adresse d'un autre membre — admin compris — se serait
      // greffé sur sa ligne. Le rattachement d'un contactId EXISTANT se fait donc seulement
      // pendant une migration de club annoncée (`RESA_CONTACT_RELINK=1`, à retirer ensuite) ;
      // hors de cette fenêtre, la connexion est refusée et journalisée.
      if (contactId && byEmail.contactId && byEmail.contactId !== contactId) {
        if (process.env.RESA_CONTACT_RELINK !== "1") {
          console.warn(
            `[session] user ${byEmail.id} : contactId ResaMania différent de celui enregistré, ` +
              "connexion refusée (RESA_CONTACT_RELINK=1 pour une migration de club)",
          );
          throw new LoginRefusedError("identity_conflict");
        }
        console.warn(`[session] user ${byEmail.id} : contactId ResaMania RÉÉCRIT (RESA_CONTACT_RELINK=1)`);
      }
      const attach = contactId && byEmail.contactId !== contactId ? { contactId } : {};
      // Connexion ResaMania retombant sur une ligne « email seul » → email désormais prouvé.
      const verify = contactId && !byEmail.emailVerifiedAt ? { emailVerifiedAt: now } : {};
      return prisma.user.update({
        where: { id: byEmail.id },
        data: { displayName: input.displayName, ...attach, ...verify },
      });
    }
  }

  // 3) Personne inconnue → nouvelle ligne.
  return prisma.user.create({
    data: {
      displayName: input.displayName,
      email,
      contactId,
      ...(contactId ? { emailVerifiedAt: now } : {}),
    },
  });
}

/**
 * Levée par `createSession` quand la personne s'authentifie correctement (ResaMania) mais que
 * son compte a été DÉSACTIVÉ par un admin : la route de login la traduit en 403 (compte
 * désactivé), à distinguer d'un échec d'identifiants (401 + compteur anti-brute-force).
 */
export class AccountDisabledError extends Error {
  constructor() {
    super("ACCOUNT_DISABLED");
    this.name = "AccountDisabledError";
  }
}

/**
 * Levée par `createSession` / `resolveUser` quand ResaMania a bien authentifié la personne mais
 * que l'appli refuse de lui ouvrir une session (audit 2026-10, points 1 et 2) :
 *  - `foreign_club`       : compte d'un AUTRE club du même tenant ResaMania ;
 *  - `blocked`            : adresse dans la blocklist de modération ;
 *  - `identity_conflict`  : l'adresse est déjà liée à un autre compte ResaMania.
 * La route de login la traduit en 403 — jamais comptée comme mauvais mot de passe.
 */
export class LoginRefusedError extends Error {
  constructor(readonly reason: "foreign_club" | "blocked" | "identity_conflict") {
    super(`LOGIN_REFUSED:${reason}`);
    this.name = "LoginRefusedError";
  }
}

/** Adresse de l'allowlist `ADMIN_EMAILS` (lecture locale : `admin.ts` importe ce module). */
function isAllowlistedAdminEmail(email: string): boolean {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(/[\s,;]+/)
    .some((e) => e && normalizeEmail(e) === email);
}

/** Crée un User (via réconciliation email) + une session ResaMania. Renvoie l'id de cookie. */
export async function createSession(resa: ResaSession): Promise<string> {
  // N'importe quel compte du TENANT ResaMania s'authentifie chez eux, y compris ceux des autres
  // clubs : on n'ouvre l'appli qu'aux comptes du nôtre (le chemin e-mail, lui, est sur
  // invitation). Et la blocklist de modération vaut pour les deux chemins.
  if (!isOwnClub(resa.identity.clubId)) throw new LoginRefusedError("foreign_club");
  const resaEmail = resa.identity.email ? normalizeEmail(resa.identity.email) : "";
  if (resaEmail && (await prisma.emailBlock.findUnique({ where: { email: resaEmail } }))) {
    throw new LoginRefusedError("blocked");
  }

  // Purge opportuniste : les sessions expirées ne sont sinon supprimées que si leur
  // propre cookie revient un jour — elles s'accumuleraient avec leurs refresh tokens.
  await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });

  const user = await resolveUser({
    displayName: nameOf(resa.identity),
    email: resa.identity.email || null,
    contactId: resa.identity.contactId,
  });
  // Compte désactivé par un admin : on refuse AVANT d'ouvrir la session (le membre existe et
  // s'authentifie bien côté ResaMania, mais il est bloqué localement).
  if (user.disabledAt) throw new AccountDisabledError();
  // Trace la dernière connexion (repère les comptes inactifs côté admin).
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  const id = randomBytes(24).toString("base64url");
  await prisma.session.create({
    data: {
      id,
      userId: user.id,
      accessToken: encrypt(resa.accessToken),
      refreshTokenEnc: encrypt(resa.refreshToken),
      tokenExpiresAt: new Date(resa.expiresAt),
      identityJson: JSON.stringify(resa.identity),
      expiresAt: new Date(Date.now() + SESSION_DAYS * 864e5),
    },
  });
  return id;
}

/** Crée une session « email seul » (aucun jeton ResaMania). Renvoie l'id de cookie. */
export async function createEmailSession(userId: string, tx: Prisma.TransactionClient = prisma): Promise<string> {
  await tx.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  // Trace la dernière connexion (le refus des comptes désactivés est fait en amont, dans la
  // route de login email qui a déjà chargé le User).
  await tx.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
  const id = randomBytes(24).toString("base64url");
  await tx.session.create({
    data: {
      id,
      userId,
      expiresAt: new Date(Date.now() + SESSION_DAYS * 864e5),
      // accessToken / refreshTokenEnc / tokenExpiresAt / identityJson restent NULL
    },
  });
  return id;
}

/**
 * Connexion biométrique d'un compte ResaMania (« option A ») : plutôt que de redemander le
 * mot de passe ResaMania, on RÉUTILISE la session ResaMania valide la plus récente du user —
 * sa dernière connexion « vraie » — en rafraîchissant son jeton, puis on TRANSFÈRE ces jetons
 * frais dans une nouvelle session (fenêtre 30 j remise à neuf) et on supprime l'ancienne ligne
 * pour qu'une SEULE détienne le refresh token (ResaMania le fait tourner → éviter tout conflit).
 *
 * Renvoie l'id de cookie de la nouvelle session, ou `null` si aucune session ResaMania n'est
 * exploitable (jamais connecté à ResaMania, session > 30 j, ou refresh token révoqué/expiré) —
 * l'appelant doit alors retomber sur un autre mode (session email, ou mot de passe ResaMania).
 *
 * LÈVE `ResaRefreshTransientError` si le rafraîchissement échoue de façon passagère : la
 * session source est alors intacte (rien n'est transféré ni supprimé) et une nouvelle tentative
 * dans quelques secondes réussira. Surtout pas `null`, qui ferait dire « ta connexion ResaMania
 * a expiré » à un membre dont le lien est parfaitement valide.
 */
export async function createResaSessionFromUser(userId: string): Promise<string | null> {
  const src = await prisma.session.findFirst({
    where: { userId, refreshTokenEnc: { not: null }, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!src) return null;
  const resa = await resolveResaToken(src); // rafraîchit + persiste sur src si besoin
  if (!resa) return null; // jeton irrécupérable → repli à l'appelant

  const id = randomBytes(24).toString("base64url");
  // Crée D'ABORD la nouvelle ligne (on ne perd jamais les jetons), puis retire la source.
  await prisma.session.create({
    data: {
      id,
      userId,
      accessToken: encrypt(resa.accessToken),
      refreshTokenEnc: encrypt(resa.refreshToken),
      tokenExpiresAt: new Date(resa.expiresAt),
      identityJson: JSON.stringify(resa.identity),
      expiresAt: new Date(Date.now() + SESSION_DAYS * 864e5),
    },
  });
  await prisma.session.deleteMany({ where: { id: src.id } });
  await prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
  return id;
}

/**
 * Échec PASSAGER de la résolution du jeton ResaMania : un autre processus rafraîchit encore
 * (attente épuisée), ou ResaMania est indisponible au moment du rafraîchissement (5xx, 429,
 * réseau, délai). Dans les deux cas la session est CONSERVÉE — la requête suivante réessaiera.
 *
 * Définie dans `resamania/errors` (avec un `code` stable, reconnu par `isResaRefreshTransient`
 * même quand un test remplace ce module-ci par une fabrique) et ré-exportée ici pour les
 * appelants historiques.
 *
 * Qui la voit encore : `getResaTokenForUser` (crons, délégation) et `createResaSessionFromUser`
 * (biométrie) la LAISSENT remonter — leurs appelants savent quoi faire d'un « réessaie plus
 * tard ». `getSession`, lui, ne la lève plus : il la traduit en `resaUnavailable` (voir là).
 */
export { ResaRefreshTransientError };

export interface AppSession {
  userId: string;
  displayName: string;
  /**
   * E-mail du membre, DÉJÀ chargé par la lecture de session (`include: { user: true }`) et
   * jusqu'ici jeté. L'exposer épargne un `user.findUnique` par requête à tout appelant qui
   * n'avait besoin que de tester l'allowlist admin (`isAdminEmail`) — sur Neon, chaque requête
   * évitée sur un chemin chaud compte davantage que la ligne de code qu'elle coûte.
   *
   * `null` pour un compte ResaMania sans adresse connue : `isAdminEmail(null)` vaut false, donc
   * le défaut reste fail-safe.
   */
  email: string | null;
  /**
   * Jeton ResaMania exploitable, ou `null`. ⚠️ `null` a DEUX sens, que `resaUnavailable`
   * départage :
   *  - `resaUnavailable` absent → session « email seul » (jamais eu de ResaMania) ;
   *  - `resaUnavailable: true`  → compte ResaMania dont le jeton n'a pas pu être rafraîchi à
   *    l'instant (panne passagère) : PAS un compte email seul.
   */
  resa: ResaSession | null;
  /**
   * `true` quand la session porte des jetons ResaMania mais que leur rafraîchissement vient
   * d'échouer de façon PASSAGÈRE (ResaMania en panne, ou rafraîchissement concurrent qui
   * s'éternise) — `resa` vaut alors `null`. Absent dans tous les autres cas.
   *
   * POURQUOI UN INDICATEUR PLUTÔT QU'UNE EXCEPTION. `getSession` est appelée par une
   * cinquantaine de routes ; l'immense majorité (forum, tricount, interclub, présences…) n'a
   * que faire du jeton ResaMania. Lever ici transformait une panne de ResaMania en 500 sur
   * TOUTE l'appli — forum compris — pour tout membre dont le jeton expirait pendant la panne.
   * Avec l'indicateur, ces routes fonctionnent normalement, et seules celles qui ont besoin du
   * jeton s'en soucient : réservation et annulation répondent 503 « réessaie »
   * (resolveActingContext), le planning se replie sur son snapshot.
   *
   * POURQUOI PAS SIMPLEMENT `resa: null`. Plusieurs écrans et routes lisent `resa === null`
   * comme « compte email seul » (/api/auth/me → `mode`/`canBook`, tricount, tournois,
   * délégations). Sans indicateur distinct, une panne de trente secondes faisait basculer
   * l'interface en lecture seule et afficher « Compte email seul » à un membre ResaMania. Tout
   * test de `resa` à des fins de RÔLE doit donc aussi regarder ce champ.
   *
   * Optionnel (et non `boolean` obligatoire) pour ne pas obliger chaque fabrique de session des
   * tests à le mentionner : l'absence vaut « non ».
   */
  resaUnavailable?: true;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Le verrou ne modifie jamais la véritable expiration du jeton.
const REFRESH_CLAIM_MS = 60_000;
const REFRESH_WAIT_MS = 20_000;

/**
 * Délai avant la n-ième relecture, en attendant qu'une autre requête finisse son
 * rafraîchissement : 250 ms, 500 ms, 1 s, puis 2 s de plateau.
 *
 * POURQUOI PAS 250 MS FIXES, la première version. Le rafraîchissement dure ce qu'il dure —
 * un aller-retour ResaMania, parfois plus quand leur service traîne, et c'est précisément
 * quand il traîne qu'on boucle. À cadence fixe, les 20 s d'attente coûtaient jusqu'à 80
 * lectures de la base à UNE requête, toutes pour la même réponse ; le backoff les ramène à
 * une douzaine sans rien changer au délai perçu dans le cas NORMAL, où la première ou la
 * deuxième relecture suffit.
 *
 * Le plateau à 2 s, plutôt qu'un doublement continu : au-delà, l'attente supplémentaire se
 * paierait en latence ressentie par le membre, pour une économie d'une poignée de lectures.
 *
 * Fonction PURE et exportée pour être vérifiable sans dormir vingt secondes.
 */
export function refreshBackoffMs(essai: number): number {
  return Math.min(250 * 2 ** Math.max(0, essai), 2_000);
}

type SessionTokenFields = {
  id: string;
  accessToken: string | null;
  refreshTokenEnc: string | null;
  tokenExpiresAt: Date | null;
  refreshClaimedAt?: Date | null;
  identityJson: string | null;
};

/**
 * Résout (et rafraîchit si besoin) le jeton ResaMania d'une ligne Session déjà chargée.
 * Factorisé pour être réutilisé par `getSession` (session du cookie courant) ET
 * `getResaTokenForUser` (délégation, idée 4 : jeton d'un AUTRE user, retrouvé par userId
 * plutôt que par cookie — cf. docs/delegation-droits.md).
 *
 * - `undefined` : session « email seul » par nature (jamais eu de jeton) — état normal.
 * - `null`      : jeton attendu mais irrécupérable (déchiffrement en échec, ou refresh
 *                 REFUSÉ par ResaMania) — la session elle-même doit être considérée invalide
 *                 (déjà supprimée ici).
 * - `ResaSession` : jeton valide (frais, ou tout juste rafraîchi).
 * - lève `ResaRefreshTransientError` : échec passager (rafraîchissement concurrent qui
 *   s'éternise, ou ResaMania indisponible) — la session est conservée, verrou relâché.
 */
async function resolveResaToken(s: SessionTokenFields): Promise<ResaSession | null | undefined> {
  // Session « email seul » : aucun jeton ResaMania à déchiffrer/rafraîchir.
  if (!s.accessToken || !s.refreshTokenEnc || !s.tokenExpiresAt || !s.identityJson) {
    return undefined;
  }

  let resa: ResaSession;
  try {
    resa = {
      accessToken: decrypt(s.accessToken),
      refreshToken: decrypt(s.refreshTokenEnc),
      expiresAt: s.tokenExpiresAt.getTime(),
      identity: JSON.parse(s.identityJson) as ResaIdentity,
    };
  } catch {
    // Session illisible (ancien format en clair, ou clé changée) → on la supprime et
    // on force une reconnexion propre.
    await prisma.session.delete({ where: { id: s.id } }).catch(() => {});
    return null;
  }

  if (resa.expiresAt > Date.now()) return resa;

  const deadline = Date.now() + REFRESH_WAIT_MS;
  let essais = 0;
  while (true) {
    const claimedAt = new Date();
    const claimed = await prisma.session.updateMany({
      where: {
        id: s.id,
        tokenExpiresAt: { lte: claimedAt },
        OR: [
          { refreshClaimedAt: null },
          { refreshClaimedAt: { lt: new Date(Date.now() - REFRESH_CLAIM_MS) } },
        ],
      },
      data: { refreshClaimedAt: claimedAt },
    });
    if (claimed.count === 1) {
      let fresh: ResaSession;
      try {
        fresh = await ensureFresh(resa);
      } catch (e) {
        // Refus d'authentification (refresh token révoqué / expiré, `invalid_grant`) : le jeton
        // est mort pour de bon, la session aussi → suppression, reconnexion requise.
        if (isResaAuthRejected(e)) {
          await prisma.session.deleteMany({ where: { id: s.id, refreshClaimedAt: claimedAt } });
          return null;
        }
        // Tout le reste est traité comme PASSAGER (ResaMania en 5xx/429, réseau, délai…). Avant,
        // n'importe quelle erreur supprimait la session : une panne de quelques secondes chez
        // eux déconnectait tous les membres dont le jeton expirait pendant ce temps. Une
        // suppression étant irréversible, seul un refus explicite la justifie.
        // On RELÂCHE le verrou (même filtre : on ne libère que le nôtre) pour que la prochaine
        // requête retente aussitôt, au lieu d'attendre la reprise d'un verrou abandonné (60 s).
        await prisma.session
          .updateMany({ where: { id: s.id, refreshClaimedAt: claimedAt }, data: { refreshClaimedAt: null } })
          .catch(() => {});
        console.warn("[session] rafraîchissement ResaMania en échec passager:", e);
        throw new ResaRefreshTransientError("ResaMania momentanément indisponible — réessaie.", { cause: e });
      }
      // Hors du try, à dessein : une erreur de la BASE ici n'est pas un échec ResaMania et doit
      // remonter telle quelle (isDbUnavailable → 503 chez les appelants qui le gèrent).
      resa = { ...fresh, identity: resa.identity };
      const saved = await prisma.session.updateMany({
        where: { id: s.id, refreshClaimedAt: claimedAt },
        data: {
          accessToken: encrypt(resa.accessToken),
          refreshTokenEnc: encrypt(resa.refreshToken),
          tokenExpiresAt: new Date(resa.expiresAt),
          refreshClaimedAt: null,
        },
      });
      return saved.count === 1 ? resa : null;
    }
    // Une attente épuisée est transitoire : on garde la session et son verrou.
    if (Date.now() >= deadline) throw new ResaRefreshTransientError("Rafraîchissement ResaMania en cours — réessaie.");
    await sleep(refreshBackoffMs(essais++));
    // `select` explicite : on ne relit QUE de quoi savoir si le jeton est devenu frais. Sans
    // lui, chaque tour de boucle rapatriait la ligne entière — identité sérialisée comprise —
    // pour en lire trois colonnes.
    const latest = await prisma.session.findUnique({
      where: { id: s.id },
      select: { accessToken: true, refreshTokenEnc: true, tokenExpiresAt: true },
    });
    if (!latest?.accessToken || !latest.refreshTokenEnc || !latest.tokenExpiresAt) return null;
    try {
      resa = {
        accessToken: decrypt(latest.accessToken),
        refreshToken: decrypt(latest.refreshTokenEnc),
        expiresAt: latest.tokenExpiresAt.getTime(),
        identity: resa.identity,
      };
    } catch {
      return null;
    }
    if (resa.expiresAt > Date.now()) return resa;
  }
}

/**
 * `userId` derrière ce cookie, ou `null` si aucune session vivante. Vérification légère : une
 * lecture par clé primaire, sans déchiffrer ni rafraîchir le jeton ResaMania (contrairement à
 * `getSession`, qui peut appeler ResaMania au passage — inacceptable sur une route publique
 * appelée à chaque chargement de page). S'y ajoute une écriture `lastSeenAt` best-effort et
 * throttlée (cf. `touchLastSeen`), lancée EN PARALLÈLE de la lecture (aucun aller-retour série
 * supplémentaire) et dont l'échec est avalé.
 *
 * ⚠️ À réserver aux décisions d'AFFICHAGE. Ne jamais s'en servir pour autoriser une action :
 * pour ça, c'est `getSession` (qui seule garantit un jeton exploitable).
 */
export async function getLiveSessionUserId(sid: string | undefined): Promise<string | null> {
  if (!sid) return null;
  const now = new Date();
  // Lecture (userId) et écriture best-effort de `lastSeenAt` en PARALLÈLE : l'écriture est cadrée
  // sur le COOKIE (jointure `sessions`), pas sur le userId retourné par la lecture, donc aucune
  // dépendance série → un seul aller-retour de latence. L'échec de l'écriture est avalé : marquer
  // l'activité ne doit jamais faire échouer l'affichage (bannière publique).
  const [s] = await Promise.all([
    prisma.session.findUnique({
      where: { id: sid },
      select: { userId: true, expiresAt: true, user: { select: { disabledAt: true } } },
    }),
    touchLastSeen(sid, now).catch(() => {}),
  ]);
  return s && s.expiresAt > now && !s.user?.disabledAt ? s.userId : null;
}

const LAST_SEEN_THROTTLE_MS = 3_600_000; // 1 h

/**
 * Marque l'activité réelle du membre propriétaire de la session `sid`, appelé à CHAQUE chargement
 * de page (via /api/banner, monté dans le layout). Cadré sur le COOKIE (filtre de relation
 * `sessions: { some }`) et non sur un userId déjà résolu, pour pouvoir tourner EN PARALLÈLE de la
 * lecture de session sans dépendance série. Un `UPDATE ... WHERE` conditionnel est ÉMIS à chaque
 * appel ; c'est l'ÉCRITURE effective de la ligne qui est throttlée (au plus 1×/h/membre), et
 * uniquement si la session est encore valide (`expiresAt > now`) — un cookie expiré, ou un compte
 * désactivé (dont les sessions sont supprimées), n'écrit donc rien. Une seule requête atomique,
 * sans lecture préalable. Contrairement à `lastLoginAt` (posé uniquement à l'authentification),
 * ce champ suit le membre qui revient avec un cookie encore valide.
 */
function touchLastSeen(sid: string, now: Date): Promise<unknown> {
  const cutoff = new Date(now.getTime() - LAST_SEEN_THROTTLE_MS);
  return prisma.user.updateMany({
    where: {
      sessions: { some: { id: sid, expiresAt: { gt: now } } },
      OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: cutoff } }],
    },
    data: { lastSeenAt: now },
  });
}

/**
 * Récupère la session depuis l'id de cookie, en rafraîchissant le token ResaMania si besoin.
 *
 * Ne lève PAS sur une panne passagère de ResaMania au rafraîchissement : la session est rendue
 * sans jeton, avec `resaUnavailable: true` (cf. `AppSession.resaUnavailable` pour le pourquoi).
 * Une erreur de la BASE, elle, remonte telle quelle (isDbUnavailable → 503 « maintenance »
 * chez les appelants qui le gèrent) : ce n'est pas le même incident.
 */
export async function getSession(sid: string | undefined): Promise<AppSession | null> {
  if (!sid) return null;
  const s = await prisma.session.findUnique({ where: { id: sid }, include: { user: true } });
  if (!s) return null;
  if (s.expiresAt <= new Date() || s.user.disabledAt) {
    await prisma.session.delete({ where: { id: sid } }).catch(() => {});
    return null;
  }

  const base = { userId: s.userId, displayName: s.user.displayName, email: s.user.email };
  let resa: ResaSession | null | undefined;
  try {
    resa = await resolveResaToken(s);
  } catch (e) {
    // Seule l'erreur PASSAGÈRE typée est absorbée ; tout le reste (base…) remonte.
    if (!isResaRefreshTransient(e)) throw e;
    // La session reste VALIDE (rien n'a été supprimé, le verrou est relâché) : le membre est
    // bien authentifié, seul le jeton ResaMania manque pour l'instant. La prochaine requête
    // retentera le rafraîchissement.
    return { ...base, resa: null, resaUnavailable: true };
  }
  if (resa === null) return null; // jeton irrécupérable → session invalidée (déjà supprimée)
  return { ...base, resa: resa ?? null };
}

/**
 * Retrouve le jeton ResaMania d'un AUTRE user (délégation, idée 4) : la session la plus
 * récente encore valide de ce user, rafraîchie si besoin — SANS dépendre de son cookie ni
 * de son activité (cf. docs/delegation-droits.md, "le problème du token qui dort"). C'est
 * la requête du DÉLÉGUÉ qui déclenche ce refresh, pas une action du délégant.
 * `null` si aucune session ResaMania utilisable n'existe (jamais connecté via ResaMania,
 * session expirée, ou jeton irrécupérable).
 *
 * LÈVE `ResaRefreshTransientError` sur une panne passagère — volontairement, contrairement à
 * `getSession` : `null` déclenche chez les appelants des actes définitifs (le cron keep-alive
 * prévient le délégant que sa délégation « ne fonctionne plus », resolveActingContext répond
 * « session du délégant plus valide »). Une panne de ResaMania ne doit produire ni l'un ni
 * l'autre ; chaque appelant traite donc l'exception (report au passage suivant, ou 503).
 */
export async function getResaTokenForUser(userId: string): Promise<ResaSession | null> {
  const s = await prisma.session.findFirst({
    where: { userId, refreshTokenEnc: { not: null }, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!s) return null;
  const resa = await resolveResaToken(s);
  return resa ?? null; // undefined (email-seule) ne devrait pas arriver ici, traité pareil
}

/**
 * Échéance de la session ResaMania utilisée pour ce user — la même ligne que celle que
 * `getResaTokenForUser` retiendra (la plus récente encore valide). C'est le PLAFOND de
 * fonctionnement d'une délégation : `Session.expiresAt` est fixé à la connexion
 * (30 jours, non glissants), le cron keep-alive rafraîchit le jeton ResaMania mais ne
 * prolonge pas la session. `null` si aucune session ResaMania valide.
 */
export async function getResaSessionExpiry(userId: string): Promise<Date | null> {
  const s = await prisma.session.findFirst({
    where: { userId, refreshTokenEnc: { not: null }, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
    select: { expiresAt: true },
  });
  return s?.expiresAt ?? null;
}

/**
 * Ferme la session portée par le cookie. Le `sid` est TOUJOURS invalidé — la ligne qui le
 * porte est supprimée, donc un cookie qui aurait fuité ne rouvre rien.
 *
 * Mais si cette ligne détenait des jetons ResaMania, on les TRANSFÈRE d'abord dans une ligne
 * « dormante » à identifiant NEUF : aucun cookie ne la désigne (l'identifiant n'est renvoyé
 * à personne), elle n'ouvre donc aucun accès par elle-même. Elle sert uniquement de réserve
 * à la reconnexion biométrique, qui reconstruit une session à partir du refresh token le
 * plus récent du membre (cf. `createResaSessionFromUser`).
 *
 * Sans ce transfert, se déconnecter détruisait le seul lien ResaMania réutilisable : la
 * biométrie répondait alors « Biométrie reconnue mais ta connexion ResaMania a expiré » à
 * chaque tentative, alors même que l'empreinte venait d'être validée.
 *
 * Pour vraiment couper le lien (appareil prêté, perdu…), il faut retirer ses passkeys :
 * sans passkey, la ligne dormante n'est plus atteignable et s'éteint à son échéance.
 */
export async function destroySession(sid: string | undefined): Promise<void> {
  if (!sid) return;
  const s = await prisma.session.findUnique({ where: { id: sid } }).catch(() => null);
  if (!s) return;

  // Ordre volontaire : on crée la réserve AVANT de supprimer, pour ne jamais perdre les
  // jetons entre les deux. Si la création échoue, la déconnexion aboutit quand même (on
  // perd seulement la reprise biométrique) — se déconnecter ne doit jamais échouer.
  if (s.accessToken && s.refreshTokenEnc && s.tokenExpiresAt && s.identityJson) {
    await prisma.session
      .create({
        data: {
          id: randomBytes(24).toString("base64url"),
          userId: s.userId,
          accessToken: s.accessToken,
          refreshTokenEnc: s.refreshTokenEnc,
          tokenExpiresAt: s.tokenExpiresAt,
          identityJson: s.identityJson,
          expiresAt: s.expiresAt, // même échéance : la déconnexion ne prolonge rien
        },
      })
      .catch(() => {});
  }

  await prisma.session.delete({ where: { id: sid } }).catch(() => {});
}
