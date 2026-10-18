import type { NextRequest } from "next/server";
import { prisma } from "./db";
import { getSession, normalizeEmail } from "./session";
import { pushToUser, pushConfigured } from "./push";
import type { TokenPurpose } from "./email-auth";

/**
 * Droits admin par ALLOWLIST, en variables d'env (jamais NEXT_PUBLIC_* → lisibles uniquement
 * côté serveur). Volontairement sans colonne en base ni UI de gestion : pour une petite asso,
 * la liste tient dans une variable d'env Vercel, et le défaut « fail-safe » est le bon — si
 * aucune liste n'est posée, PERSONNE n'est admin (l'espace d'admin reste fermé).
 *
 * DEUX listes, par ordre de préférence :
 *  - `ADMIN_USER_IDS` : ids de `User` (cuid), séparés par virgule ou espace. Identifiant
 *    STABLE : il ne bouge pas quand ResaMania renvoie un autre e-mail. Quand elle est posée,
 *    ELLE SEULE fait foi.
 *  - `ADMIN_EMAILS` : l'ancien mécanisme, gardé tant que la première n'est pas renseignée.
 *    Faible : l'e-mail que renvoie ResaMania fait foi pour l'identité, et un compte ResaMania
 *    qui s'attribue l'adresse d'un admin (sans vérification chez eux) s'y greffait — l'audit
 *    2026-10 (point 1). Les ids se lisent dans /admin/membres.
 */
function splitList(raw: string | undefined): string[] {
  return (raw ?? "").split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean);
}

function adminEmails(): Set<string> {
  return new Set(splitList(process.env.ADMIN_EMAILS).map((e) => normalizeEmail(e)).filter(Boolean));
}

function adminIds(): Set<string> {
  return new Set(splitList(process.env.ADMIN_USER_IDS));
}

/**
 * Vrai si cet e-mail est dans `ADMIN_EMAILS`. ⚠️ Ne décide plus seul dès qu'`ADMIN_USER_IDS`
 * est posée : passer par `isAdminUser` / `isAdminSession`, qui connaissent l'id.
 */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return adminEmails().has(normalizeEmail(email));
}

/** Le membre (id + e-mail) est-il admin ? `ADMIN_USER_IDS` d'abord, `ADMIN_EMAILS` à défaut. */
export function isAdminUser(user: { id: string; email: string | null | undefined } | null | undefined): boolean {
  if (!user) return false;
  const ids = adminIds();
  if (ids.size > 0) return ids.has(user.id);
  return isAdminEmail(user.email);
}

/** Raccourci pour une session déjà lue (`getSession` rend `userId` et `email`). */
export function isAdminSession(session: { userId: string; email: string | null } | null | undefined): boolean {
  return !!session && isAdminUser({ id: session.userId, email: session.email });
}

/**
 * Vérifie que la requête vient d'un admin connecté. Renvoie `{ userId, email }` si oui,
 * `null` sinon (session absente/expirée, ou hors allowlist). À appeler en tête de
 * chaque route /api/admin/*.
 */
export async function requireAdmin(
  req: NextRequest,
): Promise<{ userId: string; email: string } | null> {
  const session = await getSession(req.cookies.get("sid")?.value, { resa: false });
  if (!session) return null;
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { email: true },
  });
  if (!user?.email || !isAdminUser({ id: session.userId, email: user.email })) return null;
  return { userId: session.userId, email: user.email };
}

/**
 * Ids des Users admin, pour les notifier.
 *
 * EXPORTÉE parce qu'elle avait déjà un jumeau. Le cron du calendrier chargeait TOUS les emails
 * du club — dans sa boucle, une fois par équipe — pour n'en retenir que deux ou trois en
 * mémoire. Deux définitions de « qui est admin » côté requête, c'est deux occasions de diverger
 * en silence : celle-ci filtre en base, et c'est la seule.
 *
 * Les comptes désactivés sont exclus : les notifier ne produit rien, et c'est ce que faisait
 * déjà le jumeau du cron.
 */
export async function adminUserIds(): Promise<string[]> {
  const ids = [...adminIds()];
  const emails = [...adminEmails()];
  if (ids.length === 0 && emails.length === 0) return [];
  const users = await prisma.user.findMany({
    where: ids.length > 0 ? { id: { in: ids }, disabledAt: null } : { email: { in: emails }, disabledAt: null },
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
          // `renotify` comme partout ailleurs dans le dépôt : sans lui, la spécification impose
          // un remplacement SILENCIEUX. Deux demandes rapprochées, et la seconde arrivait sans
          // bruit ni vibration — c'est-à-dire qu'elle n'arrivait pas.
          renotify: true,
        }),
      ),
    );
  } catch (e) {
    console.warn("[admin] notif admins échouée:", (e as Error).message);
  }
}
