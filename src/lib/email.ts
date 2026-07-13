import nodemailer, { type Transporter } from "nodemailer";

/**
 * Envoi d'e-mails (codes, liens d'auth, commentaires). Deux transports SMTP possibles ;
 * on n'a JAMAIS de mot de passe en clair côté appli (identifiants en variables d'env).
 *
 * 1) Brevo (PRIORITAIRE si configuré) — meilleure délivrabilité que le relais Gmail perso
 *    (IP + DKIM du fournisseur), SANS domaine à soi : il suffit de « valider un expéditeur »
 *    dans Brevo (ton adresse Gmail). Recommandé notamment pour les FAI stricts (free.fr).
 *    NB : avec un expéditeur @gmail.com, DMARC n'est pas aligné (DKIM signé par le domaine
 *    Brevo, From @gmail.com) ; pour une fiabilité maximale vers free.fr, utiliser un domaine
 *    à soi validé dans Brevo (SPF + DKIM + DMARC alignés).
 *      BREVO_SMTP_USER  = identifiant SMTP (l'e-mail du compte Brevo)
 *      BREVO_SMTP_KEY   = clé SMTP (Brevo → SMTP & API → SMTP → « Générer une clé SMTP »)
 *      BREVO_SENDER     = adresse expéditrice VALIDÉE dans Brevo (défaut : GMAIL_USER)
 *
 * 2) Gmail (REPLI) — SMTP Gmail avec un « mot de passe d'application ». Gratuit, sans domaine,
 *    mais filtré par certains FAI (free.fr).
 *      GMAIL_USER          = adresse Gmail (ex. moi@gmail.com)
 *      GMAIL_APP_PASSWORD  = mot de passe d'application 16 caractères (les espaces sont tolérés)
 */
const GMAIL_USER = process.env.GMAIL_USER?.trim();
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD?.replace(/\s+/g, "");

const BREVO_SMTP_USER = process.env.BREVO_SMTP_USER?.trim();
const BREVO_SMTP_KEY = process.env.BREVO_SMTP_KEY?.trim();
// Expéditeur : celui validé dans Brevo ; par défaut le même que le compte Gmail.
const BREVO_SENDER = process.env.BREVO_SENDER?.trim() || GMAIL_USER;

const brevoReady = Boolean(BREVO_SMTP_USER && BREVO_SMTP_KEY && BREVO_SENDER);
const gmailReady = Boolean(GMAIL_USER && GMAIL_APP_PASSWORD);

type MailConfig = { transporter: Transporter; from: string };
let cached: MailConfig | null = null;

/** Transport actif + adresse expéditrice (Brevo prioritaire, repli Gmail). `null` si rien. */
function mailer(): MailConfig | null {
  if (cached) return cached;
  if (brevoReady) {
    cached = {
      transporter: nodemailer.createTransport({
        host: "smtp-relay.brevo.com",
        port: 587, // STARTTLS
        secure: false,
        auth: { user: BREVO_SMTP_USER!, pass: BREVO_SMTP_KEY! },
      }),
      from: BREVO_SENDER!,
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

/** L'envoi est-il configuré côté serveur ? (Brevo OU Gmail) */
export function emailConfigured(): boolean {
  return brevoReady || gmailReady;
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
    throw new Error("Envoi d'e-mail non configuré (Brevo ou Gmail).");
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
