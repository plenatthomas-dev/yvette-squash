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

// Rate-limit d'envoi d'e-mails (motif repris de l'ancien otp/request) : fenêtre glissante.
const SEND_WINDOW_MS = 10 * 60_000;
const MAX_PER_EMAIL = 3; // anti-spam de la boîte visée
const MAX_PER_IP = 10; // anti-abus d'envoi (une source qui arrose des centaines d'adresses)

// Derrière Vercel, x-forwarded-for est posé par la plateforme (1re IP = client réel).
export function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
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
 * Un envoi d'e-mail est-il rate-limité pour cet email/IP ? Purge d'abord les jetons expirés
 * (garde la table petite), puis compte les créations récentes par IP puis par email.
 */
export async function emailSendRateLimited(email: string, ip: string): Promise<boolean> {
  await prisma.emailToken.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  const since = new Date(Date.now() - SEND_WINDOW_MS);
  const fromIp = await prisma.emailToken.count({ where: { ip, createdAt: { gte: since } } });
  if (fromIp >= MAX_PER_IP) return true;
  const fromEmail = await prisma.emailToken.count({ where: { email, createdAt: { gte: since } } });
  return fromEmail >= MAX_PER_EMAIL;
}

/**
 * Crée un jeton de lien et renvoie sa valeur EN CLAIR (à mettre dans l'URL du mail ; seule
 * sa version hachée est persistée). Pour "signup", porte le mot de passe déjà haché + le nom.
 */
export async function createEmailToken(opts: {
  email: string;
  purpose: TokenPurpose;
  ip: string;
  passwordHash?: string | null;
  displayName?: string | null;
}): Promise<string> {
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
    },
  });
  return token;
}

/**
 * Retrouve un jeton valide (non expiré) pour un usage donné, par comparaison de son hash.
 * Le jeton étant à haute entropie et à usage unique, on n'a pas besoin de compteur d'essais
 * (contrairement à un code à 6 chiffres). `null` si absent/expiré.
 */
export async function findEmailToken(token: string, purpose: TokenPurpose) {
  if (!token) return null;
  return prisma.emailToken.findFirst({
    where: { tokenHash: hashToken(token), purpose, expiresAt: { gt: new Date() } },
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

export async function sendVerificationEmail(to: string, origin: string, token: string) {
  const link = `${origin}/api/auth/email/verify?token=${encodeURIComponent(token)}`;
  await sendEmail({
    to,
    subject: "Active ton compte — Squash de l'Yvette",
    text:
      `Bienvenue ! Clique sur ce lien pour activer ton compte et te connecter :\n\n${link}\n\n` +
      `Le lien est valable 24 h. Si tu n'as rien demandé, ignore ce message.`,
  });
}

export async function sendResetEmail(to: string, origin: string, token: string) {
  const link = `${origin}/reinitialiser?token=${encodeURIComponent(token)}`;
  await sendEmail({
    to,
    subject: "Réinitialise ton mot de passe — Squash de l'Yvette",
    text:
      `Tu as demandé à réinitialiser ton mot de passe. Clique sur ce lien pour en choisir un ` +
      `nouveau :\n\n${link}\n\nLe lien est valable 1 h. Si tu n'as rien demandé, ignore ce message ` +
      `(ton mot de passe reste inchangé).`,
  });
}

/** Envoyé quand une inscription vise un email qui a DÉJÀ un compte actif (anti-énumération). */
export async function sendAlreadyRegisteredEmail(to: string, origin: string) {
  await sendEmail({
    to,
    subject: "Tu as déjà un compte — Squash de l'Yvette",
    text:
      `Quelqu'un vient de tenter de créer un compte avec cette adresse, mais tu en as déjà un.\n\n` +
      `Connecte-toi ici : ${origin}/\n` +
      `Mot de passe oublié ? Utilise « Mot de passe oublié » sur l'écran de connexion.\n\n` +
      `Si ce n'était pas toi, ignore ce message.`,
  });
}
