-- EmailOtp : on mémorise l'IP qui a demandé le code, pour rate-limiter aussi PAR IP
-- (en plus du rate limiting par email). Empêche qu'une seule source arrose des centaines
-- d'adresses différentes → protège le quota d'envoi Gmail et les OTP légitimes.
-- Écrit en « IF (NOT) EXISTS » pour rester idempotent (au cas où la colonne/index existerait
-- déjà via un `prisma db push` antérieur), comme les migrations précédentes.

-- AlterTable
ALTER TABLE "EmailOtp" ADD COLUMN IF NOT EXISTS "ip" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "EmailOtp_ip_createdAt_idx" ON "EmailOtp"("ip", "createdAt");
