-- Connexion biométrique (WebAuthn / passkeys) pour les comptes « email seul ».
-- On ne stocke qu'une clé PUBLIQUE + un compteur anti-rejeu ; la clé privée et la biométrie
-- ne quittent jamais l'appareil. Écrit en « IF NOT EXISTS » pour rester idempotent (cohérent
-- avec les migrations précédentes).

-- CreateTable
CREATE TABLE IF NOT EXISTS "Passkey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" BYTEA NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,
    "transports" TEXT,
    "deviceLabel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "Passkey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Passkey_credentialId_key" ON "Passkey"("credentialId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Passkey_userId_idx" ON "Passkey"("userId");

-- AddForeignKey
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'Passkey_userId_fkey'
  ) THEN
    ALTER TABLE "Passkey"
      ADD CONSTRAINT "Passkey_userId_fkey" FOREIGN KEY ("userId")
      REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
