import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Depuis Prisma 7, le client parle à Postgres par un ADAPTATEUR (ici `pg`) : plus de moteur
// binaire, et l'URL ne vient plus du schéma — elle se passe ici.
//
// `connectionTimeoutMillis` : `pg` attend sans limite une connexion libre par défaut. Prisma 6
// abandonnait au bout de 10 s (pool_timeout) ; on garde ce plafond, pour qu'une base saturée
// donne une erreur plutôt qu'une fonction qui pend jusqu'au timeout de Vercel.
export function creeClient(url = process.env.DATABASE_URL, max?: number): PrismaClient {
  const adapter = new PrismaPg({ connectionString: sslmodeExplicite(url), connectionTimeoutMillis: 10_000, ...(max ? { max } : {}) });
  return new PrismaClient({ adapter });
}

/**
 * `sslmode=require` (ou `prefer`, `verify-ca`) → `sslmode=verify-full`.
 *
 * `pg` traite DÉJÀ ces trois modes comme `verify-full`, et le dit à chaque démarrage à froid par
 * un « SECURITY WARNING » qui encombre les erreurs d'exécution de Vercel. Écrire le mode qu'il
 * applique réellement ne change donc RIEN à la connexion — et la garde telle quand `pg` v9 donnera
 * à ces modes leur sens libpq, plus faible. Neon exige TLS avec un certificat valide : rien ne
 * casse.
 *
 * On ne touche qu'au paramètre, en texte : un mot de passe à caractères spéciaux ferait échouer
 * un `new URL()`. Une URL qui a choisi `uselibpqcompat` a déjà pris parti : on la laisse.
 */
export function sslmodeExplicite(url: string | undefined): string | undefined {
  if (!url || /[?&]uselibpqcompat=/i.test(url)) return url;
  return url.replace(/([?&]sslmode=)(?:prefer|require|verify-ca)(?=&|#|$)/i, "$1verify-full");
}

// Singleton Prisma (évite d'ouvrir trop de connexions en dev avec le hot-reload de Next).
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? creeClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
