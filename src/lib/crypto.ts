import crypto from "node:crypto";

/**
 * Chiffrement symétrique des identifiants ResaMania (AES-256-GCM).
 * La clé vient de la variable d'environnement CREDENTIALS_SECRET (base64, 32 octets).
 * On ne stocke JAMAIS de mot de passe en clair.
 */

const ALGO = "aes-256-gcm";

function getKey(): Buffer {
  const secret = process.env.CREDENTIALS_SECRET;
  if (!secret) {
    throw new Error(
      "CREDENTIALS_SECRET manquant. Générer une clé : openssl rand -base64 32",
    );
  }
  const key = Buffer.from(secret, "base64");
  if (key.length !== 32) {
    throw new Error(
      `CREDENTIALS_SECRET doit faire 32 octets une fois décodé (actuel : ${key.length}).`,
    );
  }
  return key;
}

/** Chiffre une chaîne. Format de sortie : base64(iv).base64(tag).base64(ciphertext) */
export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

/** Déchiffre une chaîne produite par encrypt(). */
export function decrypt(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Format chiffré invalide.");
  }
  const decipher = crypto.createDecipheriv(
    ALGO,
    getKey(),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Hash HMAC-SHA256 d'un code OTP (clé = CREDENTIALS_SECRET). Le code n'est jamais
 * stocké en clair : on ne persiste que ce hash et on le recompare à la vérification.
 * Déterministe → comparable ; à comparer en temps constant (crypto.timingSafeEqual).
 */
export function hashOtp(code: string): string {
  return crypto.createHmac("sha256", getKey()).update(code).digest("hex");
}
