import { randomBytes } from "node:crypto";
import { prisma } from "./db";
import { encrypt, decrypt } from "./crypto";
import { ensureFresh } from "./resamania/client";
import type { ResaIdentity, ResaSession } from "./resamania/types";
import type { User } from "@prisma/client";

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
      return prisma.user.update({
        where: { id: byContact.id },
        data: {
          displayName: input.displayName,
          email: email ?? byContact.email,
          ...(byContact.emailVerifiedAt ? {} : { emailVerifiedAt: now }),
        },
      });
    }
  }

  // 2) Sinon, jointure par email (clé d'identité commune).
  if (email) {
    const byEmail = await prisma.user.findUnique({ where: { email } });
    if (byEmail) {
      // Réconciliation : on n'attache le contactId que s'il manquait encore
      // (ne jamais écraser un contactId déjà présent).
      const attach = contactId && !byEmail.contactId ? { contactId } : {};
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

/** Crée un User (via réconciliation email) + une session ResaMania. Renvoie l'id de cookie. */
export async function createSession(resa: ResaSession): Promise<string> {
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
export async function createEmailSession(userId: string): Promise<string> {
  await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  // Trace la dernière connexion (le refus des comptes désactivés est fait en amont, dans la
  // route de login email qui a déjà chargé le User).
  await prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
  const id = randomBytes(24).toString("base64url");
  await prisma.session.create({
    data: {
      id,
      userId,
      expiresAt: new Date(Date.now() + SESSION_DAYS * 864e5),
      // accessToken / refreshTokenEnc / tokenExpiresAt / identityJson restent NULL
    },
  });
  return id;
}

export interface AppSession {
  userId: string;
  displayName: string;
  resa: ResaSession | null; // null = session « email seul » (sans ResaMania)
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Fenêtre de « réclamation » d'un refresh : pendant ce laps, les requêtes concurrentes
// considèrent le token encore bon — et il l'est réellement, grâce à la marge de 60 s
// prise sur expires_in à l'émission (cf. exchangeToken).
const REFRESH_CLAIM_MS = 20_000;

type SessionTokenFields = {
  id: string;
  accessToken: string | null;
  refreshTokenEnc: string | null;
  tokenExpiresAt: Date | null;
  identityJson: string | null;
};

/**
 * Résout (et rafraîchit si besoin) le jeton ResaMania d'une ligne Session déjà chargée.
 * Factorisé pour être réutilisé par `getSession` (session du cookie courant) ET
 * `getResaTokenForUser` (délégation, idée 4 : jeton d'un AUTRE user, retrouvé par userId
 * plutôt que par cookie — cf. docs/delegation-droits.md).
 *
 * - `undefined` : session « email seul » par nature (jamais eu de jeton) — état normal.
 * - `null`      : jeton attendu mais irrécupérable (déchiffrement/refresh en échec) — la
 *                 session elle-même doit être considérée invalide (déjà supprimée ici).
 * - `ResaSession` : jeton valide (frais, ou tout juste rafraîchi).
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

  // Token (presque) expiré → refresh SÉRIALISÉ entre requêtes concurrentes (la vue
  // Semaine tire 7 /api/planning en parallèle). updateMany atomique : une seule requête
  // « gagne » et rafraîchit, les autres relisent son résultat.
  const claimed = await prisma.session.updateMany({
    where: { id: s.id, tokenExpiresAt: { lte: new Date() } },
    data: { tokenExpiresAt: new Date(Date.now() + REFRESH_CLAIM_MS) },
  });

  if (claimed.count === 1) {
    try {
      const fresh = await ensureFresh(resa);
      resa = { ...fresh, identity: resa.identity };
      await prisma.session.update({
        where: { id: s.id },
        data: {
          accessToken: encrypt(resa.accessToken),
          refreshTokenEnc: encrypt(resa.refreshToken),
          tokenExpiresAt: new Date(resa.expiresAt),
        },
      });
      return resa;
    } catch {
      // refresh impossible (token révoqué…) -> session invalide, reconnexion forcée
      await prisma.session.delete({ where: { id: s.id } }).catch(() => {});
      return null;
    }
  }

  // Une autre requête détient le refresh : on lui laisse le temps d'écrire, puis on relit.
  await sleep(600);
  const s2 = await prisma.session.findUnique({ where: { id: s.id } });
  if (!s2 || !s2.accessToken || !s2.refreshTokenEnc || !s2.tokenExpiresAt) return null;
  try {
    // Si le gagnant n'a pas encore fini d'écrire, on repart avec l'ancien access token :
    // il reste réellement valide ~60 s (marge), assez pour cette requête.
    return {
      accessToken: decrypt(s2.accessToken),
      refreshToken: decrypt(s2.refreshTokenEnc),
      expiresAt: s2.tokenExpiresAt.getTime(),
      identity: resa.identity,
    };
  } catch {
    return null;
  }
}

/** Récupère la session depuis l'id de cookie, en rafraîchissant le token ResaMania si besoin. */
export async function getSession(sid: string | undefined): Promise<AppSession | null> {
  if (!sid) return null;
  const s = await prisma.session.findUnique({ where: { id: sid }, include: { user: true } });
  if (!s) return null;
  if (s.expiresAt < new Date()) {
    await prisma.session.delete({ where: { id: sid } }).catch(() => {});
    return null;
  }

  const resa = await resolveResaToken(s);
  if (resa === null) return null; // jeton irrécupérable → session invalidée (déjà supprimée)
  return { userId: s.userId, displayName: s.user.displayName, resa: resa ?? null };
}

/**
 * Retrouve le jeton ResaMania d'un AUTRE user (délégation, idée 4) : la session la plus
 * récente encore valide de ce user, rafraîchie si besoin — SANS dépendre de son cookie ni
 * de son activité (cf. docs/delegation-droits.md, "le problème du token qui dort"). C'est
 * la requête du DÉLÉGUÉ qui déclenche ce refresh, pas une action du délégant.
 * `null` si aucune session ResaMania utilisable n'existe (jamais connecté via ResaMania,
 * session expirée, ou jeton irrécupérable).
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

export async function destroySession(sid: string | undefined): Promise<void> {
  if (sid) await prisma.session.delete({ where: { id: sid } }).catch(() => {});
}
