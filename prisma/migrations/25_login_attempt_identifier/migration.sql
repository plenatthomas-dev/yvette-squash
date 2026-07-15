-- Rate-limiting du login par COMPTE en plus de par IP : une limite par IP seule ne protège pas
-- un membre précis (botnet, rotation d'IP mobile). On mémorise l'identifiant visé par chaque
-- échec. Nullable : les lignes existantes n'en ont pas (elles seront purgées sous 15 min).
-- AlterTable
ALTER TABLE "LoginAttempt" ADD COLUMN     "identifier" TEXT;

-- CreateIndex
CREATE INDEX "LoginAttempt_identifier_createdAt_idx" ON "LoginAttempt"("identifier", "createdAt");
