-- Connexion « email seul » par mot de passe (remplace l'OTP).
-- AlterTable : champs mot de passe + vérification d'email sur User.
ALTER TABLE "User" ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "passwordHash" TEXT;

-- DropTable : l'OTP est remplacé par le lien à usage unique (EmailToken).
DROP TABLE "EmailOtp";

-- CreateTable : jeton de lien (signup/reset), jamais stocké en clair.
CREATE TABLE "EmailToken" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "passwordHash" TEXT,
    "displayName" TEXT,
    "ip" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailToken_email_createdAt_idx" ON "EmailToken"("email", "createdAt");

-- CreateIndex
CREATE INDEX "EmailToken_ip_createdAt_idx" ON "EmailToken"("ip", "createdAt");
