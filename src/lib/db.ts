import { PrismaClient } from "@prisma/client";
import { PrismaNeon } from "@prisma/adapter-neon";
import { neonConfig } from "@neondatabase/serverless";
import ws from "ws";

// Driver Neon serverless (WebSocket, pipelining des requêtes) au lieu du pilote TCP+TLS
// classique de Prisma : évite d'établir une connexion Postgres complète à chaque instance
// de fonction froide. N'élimine pas le réveil d'un compute Neon endormi (ça, c'est Neon
// qui le décide), mais réduit le coût de connexion par-dessus. Réutilise DATABASE_URL
// (déjà l'URL "pooled" du dashboard Neon).
neonConfig.webSocketConstructor = ws;
const adapter = new PrismaNeon({ connectionString: process.env.DATABASE_URL! });

// Singleton Prisma (évite d'ouvrir trop de connexions en dev avec le hot-reload de Next).
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
