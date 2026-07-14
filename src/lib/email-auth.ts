// Briques partagées de la connexion « email seul » par mot de passe (inscription,
// vérification, connexion, mot de passe oublié, réinitialisation). Les routes
// src/app/api/auth/email/* restent minces en s'appuyant sur ces helpers.
//
// Principes de sécurité :
//  - mot de passe haché avec scrypt (crypto.hashPassword), jamais en clair ;
//  - jetons de lien à haute entropie (32 octets), stockés seulement hachés (crypto.hashToken),
//    à usage unique et expirants ;
//  - anti-énumération : les routes register/forgot répondent toujours pareil, qu'un compte
//    existe ou non ;
//  - rate-limiting des envois (par IP et par email) pour protéger le quota Gmail.

import type { NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { prisma } from "./db";
import { hashToken } from "./crypto";
import { sendEmail } from "./email";

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MIN_PASSWORD_LEN = 8;
export const MAX_PASSWORD_LEN = 200; // borne le coût scrypt (anti-DoS)

export type TokenPurpose = "signup" | "reset";

// Durée de vie des liens : l'inscription est plus tolérante (on relève ses mails plus tard),
// la réinitialisation est courte (fenêtre de risque réduite si la boîte est compromise).
const TTL_MS: Record<TokenPurpose, number> = {
  signup: 24 * 60 * 60_000, // 24 h
  reset: 60 * 60_000, // 1 h
};

// Rate-limit des demandes (inscription / réinitialisation) : fenêtre glissante.
const SEND_WINDOW_MS = 10 * 60_000;
const MAX_PER_EMAIL = 3; // demandes récentes pour un même email
const MAX_PER_IP = 5; // demandes récentes depuis une même IP (anti-arrosage d'adresses)
// Plafond GLOBAL de demandes en attente : backstop anti-noyade de la file d'attente admin,
// au cas où le rate-limit par IP serait contourné (multi-IP). Généreux pour ne pas bloquer
// des inscriptions légitimes en usage normal (petite asso).
const MAX_PENDING_TOTAL = 200;

// IP du client. Sur Vercel, `x-real-ip` est posé par la PLATEFORME (non falsifiable par le
// client), contrairement à `x-forwarded-for` dont un client peut injecter la 1re valeur pour
// tourner l'IP à chaque requête. On préfère donc x-real-ip ; repli sur la DERNIÈRE entrée de
// x-forwarded-for (celle ajoutée par la plateforme, la moins falsifiable).
export function clientIp(req: NextRequest): string {
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return "local";
}

/** Valide la robustesse minimale d'un mot de passe. `null` = OK, sinon message d'erreur. */
export function passwordProblem(pw: unknown): string | null {
  if (typeof pw !== "string" || pw.length < MIN_PASSWORD_LEN) {
    return `Mot de passe trop court (${MIN_PASSWORD_LEN} caractères minimum).`;
  }
  if (pw.length > MAX_PASSWORD_LEN) return "Mot de passe trop long.";
  return null;
}

/**
 * La demande doit-elle être refusée (rate-limit) ? Purge d'abord les jetons expirés (garde la
 * table petite), puis vérifie, dans l'ordre : le plafond GLOBAL de demandes en attente (anti-
 * noyade multi-IP), le nombre récent par IP, puis par email.
 */
export async function emailSendRateLimited(email: string, ip: string): Promise<boolean> {
  await prisma.emailToken.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  const pending = await prisma.emailToken.count({ where: { approvedAt: null } });
  if (pending >= MAX_PENDING_TOTAL) return true;
  const since = new Date(Date.now() - SEND_WINDOW_MS);
  const fromIp = await prisma.emailToken.count({ where: { ip, createdAt: { gte: since } } });
  if (fromIp >= MAX_PER_IP) return true;
  const fromEmail = await prisma.emailToken.count({ where: { email, createdAt: { gte: since } } });
  return fromEmail >= MAX_PER_EMAIL;
}

/**
 * Crée un jeton de lien et renvoie sa valeur EN CLAIR (seule sa version hachée est persistée).
 * Pour "signup", porte le mot de passe déjà haché + le nom.
 *
 * `approved` : dans le modèle « inscription sur invitation », une demande est créée NON
 * approuvée (`false`) → elle n'est qu'une entrée dans la file d'attente admin, son jeton clair
 * n'est révélé à personne. C'est `approveRequest` qui régénère un jeton frais et l'approuve.
 */
export async function createEmailToken(opts: {
  email: string;
  purpose: TokenPurpose;
  ip: string;
  passwordHash?: string | null;
  displayName?: string | null;
  approved?: boolean;
}): Promise<string> {
  // Dédup : une seule demande EN ATTENTE par email+usage. Sans ça, une même adresse pourrait
  // empiler plusieurs entrées dans la file d'attente admin. On ne touche pas aux jetons déjà
  // approuvés (liens en cours de remise).
  if (!opts.approved) {
    await prisma.emailToken.deleteMany({
      where: { email: opts.email, purpose: opts.purpose, approvedAt: null },
    });
  }
  const token = randomBytes(32).toString("base64url");
  await prisma.emailToken.create({
    data: {
      email: opts.email,
      tokenHash: hashToken(token),
      purpose: opts.purpose,
      passwordHash: opts.passwordHash ?? null,
      displayName: opts.displayName ?? null,
      ip: opts.ip,
      expiresAt: new Date(Date.now() + TTL_MS[opts.purpose]),
      approvedAt: opts.approved ? new Date() : null,
    },
  });
  return token;
}

/**
 * Retrouve un jeton valide (non expiré ET APPROUVÉ par un admin) pour un usage donné, par
 * comparaison de son hash. Le jeton étant à haute entropie et à usage unique, on n'a pas besoin
 * de compteur d'essais (contrairement à un code à 6 chiffres). `null` si absent/expiré/en attente.
 */
export async function findEmailToken(token: string, purpose: TokenPurpose) {
  if (!token) return null;
  return prisma.emailToken.findFirst({
    where: {
      tokenHash: hashToken(token),
      purpose,
      expiresAt: { gt: new Date() },
      approvedAt: { not: null },
    },
    orderBy: { createdAt: "desc" },
  });
}

/** Nombre de demandes en attente (badge admin). */
export async function countPendingRequests(): Promise<number> {
  return prisma.emailToken.count({ where: { approvedAt: null, expiresAt: { gt: new Date() } } });
}

/** Demandes de compte/réinitialisation EN ATTENTE d'approbation admin (les plus anciennes d'abord). */
export async function listPendingRequests() {
  return prisma.emailToken.findMany({
    where: { approvedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "asc" },
    select: { id: true, email: true, purpose: true, displayName: true, createdAt: true },
  });
}

/**
 * Approuve une demande en attente : régénère un jeton frais (le jeton d'origine n'a jamais été
 * révélé), date l'approbation et repart sur une TTL pleine depuis maintenant. Renvoie de quoi
 * construire le lien à transmettre à la personne, ou `null` si la demande n'existe plus / déjà
 * traitée. Le jeton clair n'est renvoyé qu'ICI, une seule fois.
 */
export async function approveRequest(
  id: string,
): Promise<{ token: string; purpose: TokenPurpose; email: string } | null> {
  const row = await prisma.emailToken.findFirst({ where: { id, approvedAt: null } });
  if (!row) return null;
  const purpose = row.purpose as TokenPurpose;
  const token = randomBytes(32).toString("base64url");
  await prisma.emailToken.update({
    where: { id },
    data: {
      tokenHash: hashToken(token),
      approvedAt: new Date(),
      expiresAt: new Date(Date.now() + TTL_MS[purpose]),
    },
  });
  return { token, purpose, email: row.email };
}

/** Rejette (supprime) une demande en attente. */
export async function rejectRequest(id: string): Promise<void> {
  await prisma.emailToken.deleteMany({ where: { id, approvedAt: null } });
}

/** Lien d'auth à transmettre. Activation ET réinitialisation mènent à la même page où la
 *  personne choisit son mot de passe (le clic sur le lien prouve la possession de l'email). */
export function authLinkFor(_origin: string, _purpose: TokenPurpose, token: string): string {
  return `${_origin}/reinitialiser?token=${encodeURIComponent(token)}`;
}

/**
 * Retrouve un jeton valide APPROUVÉ quel que soit son usage (signup OU reset). Utilisé par la
 * page « définis ton mot de passe », commune aux deux parcours : le comportement (créer le
 * compte vs juste changer le mot de passe) est décidé d'après `purpose` du jeton trouvé.
 */
export async function findApprovedToken(token: string) {
  if (!token) return null;
  return prisma.emailToken.findFirst({
    where: { tokenHash: hashToken(token), expiresAt: { gt: new Date() }, approvedAt: { not: null } },
    orderBy: { createdAt: "desc" },
  });
}

/** Consomme tous les jetons d'un email pour un usage (usage unique + ménage). */
export async function consumeEmailTokens(email: string, purpose: TokenPurpose): Promise<void> {
  await prisma.emailToken.deleteMany({ where: { email, purpose } });
}

/**
 * Nom d'affichage par défaut dérivé de l'email ("jean.dupont@x" -> "Jean Dupont").
 * (Repris tel quel de l'ancien flux OTP.)
 */
export function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  return (
    local
      .replace(/[._-]+/g, " ")
      .trim()
      .split(" ")
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ") || email
  );
}

// --- E-mails --------------------------------------------------------------------------

// Échappe le strict minimum pour interpoler une URL sans risque dans le HTML. Les jetons sont
// en base64url (pas de caractère spécial), mais on reste défensif sur l'`origin`.
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Gabarit d'e-mail transactionnel commun (texte + HTML). Volontairement sobre — pas d'image
// ni de couleur criarde, lien visible EN CLAIR sous le bouton (pas de lien « masqué », ce qui
// rassure les filtres anti-phishing). Signé au nom de l'association.
//
// NB : pour l'instant on n'envoie QUE la partie `text` (cf. sendVerificationEmail…) — le HTML
// déclenchait des « Content Blocked » chez free.fr. La partie `html` reste produite ici pour
// pouvoir la réactiver le jour où un domaine aligné (DKIM/DMARC) rend l'envoi de confiance.
function renderEmail(opts: {
  title: string;
  lead: string;
  cta?: { label: string; url: string };
  expiry?: string;
  footer: string;
}): { text: string; html: string } {
  const { title, lead, cta, expiry, footer } = opts;

  const textLines = [lead];
  if (cta) textLines.push("", `${cta.label} :`, cta.url);
  if (expiry) textLines.push("", `Ce lien est valable ${expiry}.`);
  textLines.push("", footer, "", "— Le Squash de l'Yvette");
  const text = textLines.join("\n");

  const button = cta
    ? `<p style="margin:0 0 14px;"><a href="${esc(cta.url)}" style="display:inline-block;background:#1e3a8a;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:6px;font-weight:600;">${esc(cta.label)}</a></p>
       <p style="margin:0 0 16px;font-size:13px;color:#6b7280;word-break:break-all;">Si le bouton ne marche pas, copie ce lien dans ton navigateur :<br>${esc(cta.url)}</p>`
    : "";
  const expiryHtml = expiry
    ? `<p style="margin:0 0 8px;font-size:13px;color:#6b7280;">Ce lien est valable ${esc(expiry)}.</p>`
    : "";
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937;max-width:480px;margin:0 auto;padding:20px 16px;">
  <h2 style="margin:0 0 12px;font-size:18px;">${esc(title)}</h2>
  <p style="margin:0 0 16px;line-height:1.5;">${esc(lead)}</p>
  ${button}${expiryHtml}
  <p style="margin:0 0 16px;font-size:13px;color:#6b7280;">${esc(footer)}</p>
  <p style="margin:20px 0 0;font-size:13px;color:#6b7280;">— Le Squash de l'Yvette</p>
</div>`;
  return { text, html };
}

export async function sendVerificationEmail(to: string, origin: string, token: string) {
  const link = `${origin}/api/auth/email/verify?token=${encodeURIComponent(token)}`;
  const { text } = renderEmail({
    title: "Bienvenue au Squash de l'Yvette",
    lead: "Pour activer ton compte et te connecter, confirme ton adresse en cliquant ci-dessous.",
    cta: { label: "Activer mon compte", url: link },
    expiry: "24 heures",
    footer: "Tu n'as pas créé de compte ? Ignore ce message, rien ne sera activé.",
  });
  await sendEmail({ to, subject: "Active ton compte au Squash de l'Yvette", text });
}

export async function sendResetEmail(to: string, origin: string, token: string) {
  const link = `${origin}/reinitialiser?token=${encodeURIComponent(token)}`;
  const { text } = renderEmail({
    title: "Nouveau mot de passe",
    lead: "Tu as demandé à définir un nouveau mot de passe pour ton compte du Squash de l'Yvette. Clique ci-dessous pour le choisir.",
    cta: { label: "Choisir un nouveau mot de passe", url: link },
    expiry: "1 heure",
    footer: "Tu n'as rien demandé ? Ignore ce message : ton mot de passe actuel reste valable.",
  });
  await sendEmail({ to, subject: "Ton nouveau mot de passe — Squash de l'Yvette", text });
}

/** Envoyé quand une inscription vise un email qui a DÉJÀ un compte actif (anti-énumération). */
export async function sendAlreadyRegisteredEmail(to: string, origin: string) {
  const { text } = renderEmail({
    title: "Tu as déjà un compte",
    lead: "Quelqu'un a tenté de créer un compte avec cette adresse au Squash de l'Yvette, mais tu en as déjà un. Tu peux te connecter directement.",
    cta: { label: "Se connecter", url: `${origin}/` },
    footer:
      "Mot de passe oublié ? Utilise « Mot de passe oublié » sur l'écran de connexion. Si ce n'était pas toi, ignore ce message.",
  });
  await sendEmail({ to, subject: "Tu as déjà un compte au Squash de l'Yvette", text });
}
