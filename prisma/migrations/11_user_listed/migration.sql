-- Annuaire des membres (idée 6) : visibilité OPT-OUT dans l'annuaire interne.
-- Défaut TRUE → chaque membre est visible par défaut et peut se retirer depuis ses
-- paramètres. Seuls id + nom/pseudo sont exposés par /api/directory (jamais e-mail).
-- Écrit en « IF NOT EXISTS » pour rester idempotent (cohérent avec les migrations précédentes).

-- AlterTable
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "listed" BOOLEAN NOT NULL DEFAULT true;
