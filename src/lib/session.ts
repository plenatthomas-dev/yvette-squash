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
      accessToken: resa.accessToken,
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

/** Récupère la session depuis l'id de cookie, en rafraîchissant le token ResaMania si besoin. */
export async function getSession(sid: string | undefined): Promise<AppSession | null> {
  if (!sid) return null;
  const s = await prisma.session.findUnique({ where: { id: sid }, include: { user: true } });
  if (!s) return null;
  if (s.expiresAt < new Date()) {
    await prisma.session.delete({ where: { id: sid } }).catch(() => {});
    return null;
  }

  let resa: ResaSession = {
    accessToken: s.accessToken,
    refreshToken: decrypt(s.refreshTokenEnc),
    expiresAt: s.tokenExpiresAt.getTime(),
    identity: JSON.parse(s.identityJson) as ResaIdentity,
  };

  try {
    const fresh = await ensureFresh(resa);
    if (fresh.accessToken !== resa.accessToken) {
      resa = { ...fresh, identity: resa.identity };
      await prisma.session.update({
        where: { id: sid },
        data: {
          accessToken: resa.accessToken,
          refreshTokenEnc: encrypt(resa.refreshToken),
          tokenExpiresAt: new Date(resa.expiresAt),
        },
      });
    }
  } catch {
    // refresh impossible (token expiré) -> session invalide, on force une reconnexion
    await prisma.session.delete({ where: { id: sid } }).catch(() => {});
    return null;
  }

  return { userId: s.userId, displayName: s.user.displayName, resa };
}

export async function destroySession(sid: string | undefined): Promise<void> {
  if (sid) await prisma.session.delete({ where: { id: sid } }).catch(() => {});
}
