import { prisma } from "./db";
import { buildHandleMap } from "./handle";
import type { AppSession } from "./session";

export interface MePayload {
  // Id interne du membre : permet au client de se reconnaître dans les listes issues de
  // l'annuaire (ex. s'exclure du choix des délégués).
  id: string;
  displayName: string;
  nickname: string | null;
  listed: boolean;
  handle: string | null;
  mode: "resamania" | "email";
  canBook: boolean;
}

// Partagé entre GET /api/auth/me et le préchargement SSR de la page (évite un aller-retour
// HTTP interne pour la même donnée).
export async function buildMePayload(session: AppSession): Promise<MePayload> {
  const users = await prisma.user.findMany({
    select: { id: true, displayName: true, nickname: true, listed: true, createdAt: true },
  });
  const me = users.find((u) => u.id === session.userId);
  const handle = buildHandleMap(users).get(session.userId) ?? null;
  return {
    id: session.userId,
    displayName: session.displayName,
    nickname: me?.nickname ?? null,
    listed: me?.listed ?? true,
    handle,
    mode: session.resa ? "resamania" : "email",
    canBook: !!session.resa,
  };
}
