import nodemailer, { type Transporter } from "nodemailer";

/**
 * Envoi d'e-mails (codes, liens d'auth, commentaires). Deux transports SMTP possibles ;
 * on n'a JAMAIS de mot de passe en clair côté appli (identifiants en variables d'env).
 *
 * 1) Mailjet (PRIORITAIRE si configuré) — meilleure délivrabilité que le relais Gmail perso
 *    (IP + DKIM du fournisseur), SANS domaine à soi : il suffit de « valider un expéditeur »
 *    dans Mailjet (ton adresse Gmail). Recommandé notamment pour les FAI stricts (free.fr).
 *      MAILJET_API_KEY     = clé API publique (Account → API Key Management)
 *      MAILJET_SECRET_KEY  = clé secrète associée
 *      MAILJET_SENDER      = adresse expéditrice VALIDÉE dans Mailjet (défaut : GMAIL_USER)
 *
 * 2) Gmail (REPLI) — SMTP Gmail avec un « mot de passe d'application ». Gratuit, sans domaine,
 *    mais filtré par certains FAI (free.fr).
 *      GMAIL_USER          = adresse Gmail (ex. moi@gmail.com)
 *      GMAIL_APP_PASSWORD  = mot de passe d'application 16 caractères (les espaces sont tolérés)
 */
const GMAIL_USER = process.env.GMAIL_USER?.trim();
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, "");

const MAILJET_API_KEY = process.env.MAILJET_API_KEY?.trim();
const MAILJET_SECRET_KEY = process.env.MAILJET_SECRET_KEY?.trim();
// Expéditeur : celui validé dans Mailjet ; par défaut le même que le compte Gmail.
const MAILJET_SENDER = process.env.MAILJET_SENDER?.trim() || GMAIL_USER;

const mailjetReady = Boolean(MAILJET_API_KEY && MAILJET_SECRET_KEY && MAILJET_SENDER);
const gmailReady = Boolean(GMAIL_USER && GMAIL_APP_PASSWORD);

type MailConfig = { transporter: Transporter; from: string };
let cached: MailConfig | null = null;

/** Transport actif + adresse expéditrice (Mailjet prioritaire, repli Gmail). `null` si rien. */
function mailer(): MailConfig | null {
  if (cached) return cached;
  if (mailjetReady) {
    cached = {
      transporter: nodemailer.createTransport({
        host: "in-v3.mailjet.com",
        port: 587, // STARTTLS
        secure: false,
        auth: { user: MAILJET_API_KEY!, pass: MAILJET_SECRET_KEY! },
      }),
      from: MAILJET_SENDER!,
    };
    return cached;
  }
  if (gmailReady) {
    cached = {
      transporter: nodemailer.createTransport({
        service: "gmail",
        auth: { user: GMAIL_USER!, pass: GMAIL_APP_PASSWORD! },
      }),
      from: GMAIL_USER!,
    };
    return cached;
  }
  return null;
}

/** L'envoi est-il configuré côté serveur ? (Mailjet OU Gmail) */
export function emailConfigured(): boolean {
  return mailjetReady || gmailReady;
}

/**
 * Envoie un e-mail. Fournir `html` en plus de `text` produit un message multipart/alternative
 * (mieux perçu par les filtres anti-spam qu'un texte brut seul). Lève si aucun transport n'est
 * configuré ou si l'envoi échoue.
 */
export async function sendEmail(opts: {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  fromName?: string;
}): Promise<void> {
  const m = mailer();
  if (!m) {
    throw new Error("Envoi d'e-mail non configuré (Mailjet ou Gmail).");
  }
  await m.transporter.sendMail({
    from: `"${opts.fromName ?? "Squash de l'Yvette"}" <${m.from}>`,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
    replyTo: opts.replyTo,
  });
}
