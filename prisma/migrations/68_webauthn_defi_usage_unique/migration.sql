-- DÉFI WEBAUTHN À USAGE UNIQUE (audit 2026-10, point 24).
--
-- Le défi d'une cérémonie passkey vivait seulement dans un cookie chiffré de 5 minutes : une
-- réponse d'authentification capturée avec ce cookie pouvait être rejouée jusqu'à l'échéance.
-- On garde l'empreinte de chaque défi consommé, jusqu'à son échéance.
--
-- Rejouable : la base de recette est partagée par toutes les previews (cf. README.md).

CREATE TABLE IF NOT EXISTS "WebauthnChallengeUse" (
    "hash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebauthnChallengeUse_pkey" PRIMARY KEY ("hash")
);

CREATE INDEX IF NOT EXISTS "WebauthnChallengeUse_expiresAt_idx" ON "WebauthnChallengeUse"("expiresAt");
