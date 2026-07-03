import { randomBytes } from "node:crypto";
import { prisma } from "./db";
import { encrypt, decrypt } from "./crypto";
import { ensureFresh } from "./resamania/client";
import type { ResaIdentity, ResaSession } from "./resamania/types";

const SESSION_DAYS = 30;

function nameOf(id: ResaIdentity): string {
  return `${id.givenName} ${id.familyName}`.trim() || id.email || "Joueur";
}

/** Crée un User (si besoin) + une session applicative. Renvoie l'id de cookie. */
export async function createSession(resa: ResaSession): Promise<string> {
  // Purge opportuniste : les sessions expirées ne sont sinon supprimées que si leur
  // propre cookie revient un jour — elles s'accumuleraient avec leurs refresh tokens.
  await prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });

  const id = randomBytes(24).toString("base64url");
  const user = await prisma.user.upsert({
    where: { contactId: resa.identity.contactId },
    update: { displayName: nameOf(resa.identity), email: resa.identity.email || undefined },
    create: {
      contactId: resa.identity.contactId,
      displayName: nameOf(resa.identity),
      email: resa.identity.email || undefined,
    },
  });
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

export interface AppSession {
  userId: string;
  displayName: string;
  resa: ResaSession;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Fenêtre de « réclamation » d'un refresh : pendant ce laps, les requêtes concurrentes
// considèrent le token encore bon — et il l'est réellement, grâce à la marge de 60 s
// prise sur expires_in à l'émission (cf. exchangeToken).
const REFRESH_CLAIM_MS = 20_000;

/** Récupère la session depuis l'id de cookie, en rafraîchissant le token ResaMania si besoin. */
export async function getSession(sid: string | undefined): Promise<AppSession | null> {
  if (!sid) return null;
  const s = await prisma.session.findUnique({ where: { id: sid }, include: { user: true } });
  if (!s) return null;
  if (s.expiresAt < new Date()) {
    await prisma.session.delete({ where: { id: sid } }).catch(() => {});
    return null;
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
    // Session illisible (ancien format avec access token en clair, ou clé changée)
    // → on la supprime et on force une reconnexion propre.
    await prisma.session.delete({ where: { id: sid } }).catch(() => {});
    return null;
  }

  if (resa.expiresAt <= Date.now()) {
    // Token (presque) expiré → refresh SÉRIALISÉ entre requêtes concurrentes : la vue
    // Semaine tire 7 /api/planning en parallèle, et plusieurs refresh simultanés avec
    // le même refresh token (usage unique) détruiraient la session (déconnexions
    // sporadiques). updateMany atomique : une seule requête « gagne » et rafraîchit,
    // les autres relisent son résultat.
    const claimed = await prisma.session.updateMany({
      where: { id: sid, tokenExpiresAt: { lte: new Date() } },
      data: { tokenExpiresAt: new Date(Date.now() + REFRESH_CLAIM_MS) },
    });

    if (claimed.count === 1) {
      try {
        const fresh = await ensureFresh(resa);
        resa = { ...fresh, identity: resa.identity };
        await prisma.session.update({
          where: { id: sid },
          data: {
            accessToken: encrypt(resa.accessToken),
            refreshTokenEnc: encrypt(resa.refreshToken),
            tokenExpiresAt: new Date(resa.expiresAt),
          },
        });
      } catch {
        // refresh impossible (token révoqué…) -> session invalide, reconnexion forcée
        await prisma.session.delete({ where: { id: sid } }).catch(() => {});
        return null;
      }
    } else {
      // Une autre requête détient le refresh : on lui laisse le temps d'écrire, puis on relit.
      await sleep(600);
      const s2 = await prisma.session.findUnique({ where: { id: sid } });
      if (!s2) return null; // le refresh concurrent a échoué → session supprimée
      try {
        resa = {
          accessToken: decrypt(s2.accessToken),
          refreshToken: decrypt(s2.refreshTokenEnc),
          expiresAt: s2.tokenExpiresAt.getTime(),
          identity: resa.identity,
        };
      } catch {
        return null;
      }
      // Si le gagnant n'a pas encore fini d'écrire, on repart avec l'ancien access
      // token : il reste réellement valide ~60 s (marge), assez pour cette requête.
    }
  }

  return { userId: s.userId, displayName: s.user.displayName, resa };
}

export async function destroySession(sid: string | undefined): Promise<void> {
  if (sid) await prisma.session.delete({ where: { id: sid } }).catch(() => {});
}
