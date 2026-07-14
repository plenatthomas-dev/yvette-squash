import type { NextRequest } from "next/server";
import { prisma } from "./db";
import { getSession, normalizeEmail } from "./session";

/**
 * Droits admin par ALLOWLIST d'e-mails (variable d'env `ADMIN_EMAILS`, séparés par virgule
 * ou espace). Volontairement sans colonne en base ni UI de gestion : pour une petite asso, la
 * liste tient dans une variable d'env Vercel, et le défaut « fail-safe » est le bon — si
 * ADMIN_EMAILS est vide/absent, PERSONNE n'est admin (l'espace d'admin reste fermé).
 *
 * NB : ce n'est pas NEXT_PUBLIC_* → lisible uniquement côté serveur (jamais exposé au client).
 */
function adminEmails(): Set<string> {
  return new Set(
    (process.env.ADMIN_EMAILS ?? "")
      .split(/[\s,;]+/)
      .map((e) => normalizeEmail(e))
      .filter(Boolean),
  );
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return adminEmails().has(normalizeEmail(email));
}

/**
 * Vérifie que la requête vient d'un admin connecté. Renvoie `{ userId, email }` si oui,
 * `null` sinon (session absente/expirée, ou email hors allowlist). À appeler en tête de
 * chaque route /api/admin/*.
 */
export async function requireAdmin(
  req: NextRequest,
): Promise<{ userId: string; email: string } | null> {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) return null;
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { email: true },
  });
  if (!user?.email || !isAdminEmail(user.email)) return null;
  return { userId: session.userId, email: user.email };
}
