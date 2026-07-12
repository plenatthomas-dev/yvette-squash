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
 * Hash HMAC-SHA256 d'un secret opaque (clé = CREDENTIALS_SECRET). Le secret n'est jamais
 * stocké en clair : on ne persiste que ce hash et on le recompare à la vérification.
 * Déterministe → comparable ; à comparer en temps constant (crypto.timingSafeEqual).
 *
 * Utilisé pour les jetons de lien e-mail (inscription / réinitialisation) : le jeton est
 * un secret aléatoire à haute entropie, donc un HMAC rapide suffit (contrairement à un mot
 * de passe humain, qui exige un hash lent — cf. hashPassword).
 */
export function hashToken(token: string): string {
  return crypto.createHmac("sha256", getKey()).update(token).digest("hex");
}

/**
 * Hachage d'un MOT DE PASSE humain avec scrypt (KDF lent, intégré à node:crypto — aucune
 * dépendance). Chaque mot de passe a son propre sel aléatoire, donc deux comptes au même
 * mot de passe ont des hachages différents. Le mot de passe n'est JAMAIS stocké en clair.
 *
 * Format stocké : `scrypt$N$r$p$selBase64$hashBase64` — les paramètres voyagent avec le
 * hash, ce qui permet de les durcir plus tard sans invalider les hachages existants
 * (verifyPassword relit les paramètres de la chaîne).
 */
const SCRYPT_N = 16384; // coût CPU/mémoire (2^14) — solide et rapide côté serveur
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const SCRYPT_KEYLEN = 32;
// maxmem doit couvrir 128 * N * r octets (ici ~16 Mo) : on prend une marge confortable.
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      SCRYPT_KEYLEN,
      { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p, maxmem: SCRYPT_MAXMEM },
      (err, derived) => {
        if (err) return reject(err);
        resolve(
          [
            "scrypt",
            SCRYPT_N,
            SCRYPT_r,
            SCRYPT_p,
            salt.toString("base64"),
            derived.toString("base64"),
          ].join("$"),
        );
      },
    );
  });
}

/**
 * Vérifie un mot de passe contre une chaîne produite par hashPassword(). Recalcule le
 * hachage avec les paramètres/sel lus dans la chaîne, puis compare en TEMPS CONSTANT.
 * Renvoie false (jamais d'exception) si la chaîne stockée est invalide/illisible.
 */
export function verifyPassword(password: string, stored: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const [scheme, nStr, rStr, pStr, saltB64, hashB64] = stored.split("$");
      if (scheme !== "scrypt" || !saltB64 || !hashB64) return resolve(false);
      const N = Number(nStr);
      const r = Number(rStr);
      const p = Number(pStr);
      const salt = Buffer.from(saltB64, "base64");
      const expected = Buffer.from(hashB64, "base64");
      if (!N || !r || !p || salt.length === 0 || expected.length === 0) {
        return resolve(false);
      }
      crypto.scrypt(
        password,
        salt,
        expected.length,
        { N, r, p, maxmem: SCRYPT_MAXMEM },
        (err, derived) => {
          if (err) return resolve(false);
          resolve(derived.length === expected.length && crypto.timingSafeEqual(derived, expected));
        },
      );
    } catch {
      resolve(false);
    }
  });
}
