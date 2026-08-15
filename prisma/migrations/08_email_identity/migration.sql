-- User : contactId devient nullable (comptes « email seul » sans ResaMania).
-- email devient la clé d'identité commune (normalisé + unique). On normalise l'existant
-- AVANT de créer l'index unique, sinon des doublons de casse le feraient échouer.
ALTER TABLE "User" ALTER COLUMN "contactId" DROP NOT NULL;
UPDATE "User" SET "email" = lower(trim("email")) WHERE "email" IS NOT NULL;

-- Session : les champs jeton ResaMania deviennent nullables (sessions « email seul »).
ALTER TABLE "Session" ALTER COLUMN "accessToken" DROP NOT NULL;
ALTER TABLE "Session" ALTER COLUMN "refreshTokenEnc" DROP NOT NULL;
ALTER TABLE "Session" ALTER COLUMN "tokenExpiresAt" DROP NOT NULL;
ALTER TABLE "Session" ALTER COLUMN "identityJson" DROP NOT NULL;

-- CreateTable
CREATE TABLE "EmailOtp" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailOtp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "EmailOtp_email_createdAt_idx" ON "EmailOtp"("email", "createdAt");
