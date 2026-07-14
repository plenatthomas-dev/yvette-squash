import type { NextRequest } from "next/server";
import { prisma } from "./db";
import { getSession, normalizeEmail } from "./session";
import { pushToUser, pushConfigured } from "./push";
import type { TokenPurpose } from "./email-auth";

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

/** Ids des Users admin (ceux dont l'email est dans l'allowlist), pour les notifier. */
async function adminUserIds(): Promise<string[]> {
  const emails = [...adminEmails()];
  if (emails.length === 0) return [];
  const users = await prisma.user.findMany({
    where: { email: { in: emails } },
    select: { id: true },
  });
  return users.map((u) => u.id);
}

/**
 * Prévient les admins (push) qu'une nouvelle demande attend leur validation. Best-effort :
 * on n'échoue JAMAIS la requête d'inscription/réinitialisation si le push tombe (l'admin
 * verra de toute façon la demande dans /admin). Suppose que l'admin a activé les notifs.
 */
export async function notifyAdminsOfRequest(purpose: TokenPurpose, email: string): Promise<void> {
  if (!pushConfigured()) return;
  try {
    const ids = await adminUserIds();
    const kind = purpose === "signup" ? "création de compte" : "réinitialisation";
    await Promise.all(
      ids.map((id) =>
        pushToUser(id, {
          title: "Nouvelle demande à valider 🔑",
          body: `Demande de ${kind} : ${email}`,
          url: "/admin",
          tag: "admin-requests",
        }),
      ),
    );
  } catch (e) {
    console.warn("[admin] notif admins échouée:", (e as Error).message);
  }
}
