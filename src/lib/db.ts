import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Depuis Prisma 7, le client parle à Postgres par un ADAPTATEUR (ici `pg`) : plus de moteur
// binaire, et l'URL ne vient plus du schéma — elle se passe ici.
//
// `connectionTimeoutMillis` : `pg` attend sans limite une connexion libre par défaut. Prisma 6
// abandonnait au bout de 10 s (pool_timeout) ; on garde ce plafond, pour qu'une base saturée
// donne une erreur plutôt qu'une fonction qui pend jusqu'au timeout de Vercel.
export function creeClient(url = process.env.DATABASE_URL, max?: number): PrismaClient {
  const adapter = new PrismaPg({ connectionString: url, connectionTimeoutMillis: 10_000, ...(max ? { max } : {}) });
  return new PrismaClient({ adapter });
}

// Singleton Prisma (évite d'ouvrir trop de connexions en dev avec le hot-reload de Next).
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? creeClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
