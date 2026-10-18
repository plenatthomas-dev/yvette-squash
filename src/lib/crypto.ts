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

/**
 * UNE CLÉ PAR USAGE (audit 2026-10, point 24). `CREDENTIALS_SECRET` servait telle quelle au
 * chiffrement ET aux HMAC : une faiblesse — ou une fuite — d'un usage engageait l'autre. On
 * en DÉRIVE désormais une sous-clé par usage (HKDF-SHA256, étiquette distincte) ; le secret
 * lui-même ne change pas, aucune variable d'environnement à ajouter.
 */
function subKey(label: "enc" | "token" | "session"): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", getKey(), Buffer.alloc(0), `yvette-squash:${label}`, 32));
}

/** Préfixe des chiffrés produits avec la sous-clé (les anciens n'en ont pas). */
const V2 = "v2";

/**
 * Chiffre une chaîne. Format de sortie : `v2.base64(iv).base64(tag).base64(ciphertext)`.
 * Les chiffrés d'avant la dérivation (sans `v2.`, clé brute) restent lisibles par `decrypt` ;
 * ils sont réécrits au format courant à leur prochaine écriture (rafraîchissement du jeton).
 */
export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, subKey("enc"), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    V2,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

/** Déchiffre une chaîne produite par encrypt() — format courant ou d'avant la dérivation. */
export function decrypt(payload: string): string {
  const parts = payload.split(".");
  const courant = parts[0] === V2;
  const [ivB64, tagB64, dataB64] = courant ? parts.slice(1) : parts;
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Format chiffré invalide.");
  }
  const decipher = crypto.createDecipheriv(
    ALGO,
    courant ? subKey("enc") : getKey(),
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
  return crypto.createHmac("sha256", subKey("token")).update(token).digest("hex");
}

/**
 * Les empreintes sous lesquelles un jeton a PU être enregistré : la courante, et celle d'avant
 * la dérivation des clés (clé brute). Les liens envoyés juste avant le déploiement (24 h au
 * plus) restent ainsi valables. La seconde pourra être retirée passé ce délai.
 */
export function tokenHashCandidates(token: string): string[] {
  return [hashToken(token), crypto.createHmac("sha256", getKey()).update(token).digest("hex")];
}

/**
 * Identifiant de session STOCKÉ, dérivé de celui du cookie (audit 2026-10, point 24). La table
 * `Session` gardait l'identifiant du cookie en clair : une lecture de la base (sauvegarde,
 * accès de diagnostic) suffisait à se faire passer pour chaque membre connecté. Seule
 * l'empreinte HMAC y vit désormais ; le cookie garde la valeur brute. Préfixée pour se
 * distinguer des anciens identifiants (cf. `session.ts`, migration paresseuse).
 */
export function hashSessionId(sid: string): string {
  return `h:${crypto.createHmac("sha256", subKey("session")).update(sid).digest("base64url")}`;
}

/**
 * Compare deux chaînes en TEMPS CONSTANT. À utiliser dès qu'on compare un secret reçu à un
 * secret attendu : `===` s'arrête au premier octet différent, ce qui laisse fuiter, par la
 * durée, le nombre d'octets corrects — de quoi reconstruire un secret octet par octet.
 *
 * Des longueurs différentes renvoient `false` tout de suite : `timingSafeEqual` exige des
 * buffers de même taille, et la LONGUEUR d'un secret n'est pas ce qu'on protège.
 *
 * N'exige aucune clé (contrairement au reste du module) : utilisable sans CREDENTIALS_SECRET.
 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
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
