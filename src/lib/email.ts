import nodemailer, { type Transporter } from "nodemailer";

/**
 * Envoi d'e-mails via le SMTP de Gmail (compte perso + « mot de passe d'application »).
 * Gratuit, sans domaine à vérifier, et bonne délivrabilité (l'envoi part de gmail.com).
 * Le « from » est forcément le compte Gmail authentifié (Gmail réécrit sinon).
 *   GMAIL_USER          = adresse Gmail (ex. moi@gmail.com)
 *   GMAIL_APP_PASSWORD  = mot de passe d'application 16 caractères (les espaces sont tolérés)
 */
const GMAIL_USER = process.env.GMAIL_USER?.trim();
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, "");

let cached: Transporter | null = null;
function transporter(): Transporter | null {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) return null;
  if (!cached) {
    cached = nodemailer.createTransport({
      service: "gmail",
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });
  }
  return cached;
}

/** L'envoi est-il configuré côté serveur ? */
export function emailConfigured(): boolean {
  return Boolean(GMAIL_USER && GMAIL_APP_PASSWORD);
}

/** Envoie un e-mail texte. Lève si la configuration Gmail manque ou si l'envoi échoue. */
export async function sendEmail(opts: {
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
  fromName?: string;
}): Promise<void> {
  const t = transporter();
  if (!t || !GMAIL_USER) {
    throw new Error("Envoi d'e-mail non configuré (GMAIL_USER / GMAIL_APP_PASSWORD manquants).");
  }
  await t.sendMail({
    from: `"${opts.fromName ?? "Squash de l'Yvette"}" <${GMAIL_USER}>`,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    replyTo: opts.replyTo,
  });
}
