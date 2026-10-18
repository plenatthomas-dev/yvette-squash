// Configuration de la CLI Prisma (Prisma 7) : où trouver le schéma, et l'URL des commandes qui
// touchent la base — `migrate deploy`, `db push`, `db execute` (cf. db:renumerote).
//
// Cette URL est la connexion DIRECTE (DIRECT_URL, host sans `-pooler`) : les migrations ont
// besoin d'une vraie session Postgres, ce que le pooler de Neon ne garantit pas. L'appli, elle,
// passe par la connexion « pooled » (DATABASE_URL) — cf. src/lib/db.ts.
//
// ⚠️ Prisma 7 ne lit plus `.env` tout seul : on le charge ici, s'il existe (poste de dev).
// Sur Vercel et en CI, les variables sont déjà dans l'environnement.
//
// ⚠️ PAS de `env("DIRECT_URL")` : il jette si la variable manque, et `prisma generate` (lancé
// par `postinstall`, donc par chaque `npm ci` de la CI, sans base) n'en a pas besoin.
import { existsSync } from "node:fs";
import { defineConfig } from "prisma/config";

if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: { url: process.env.DIRECT_URL ?? process.env.DATABASE_URL },
});
