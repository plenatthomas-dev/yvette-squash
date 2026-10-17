-- SUIVI DES ERREURS NON RATTRAPÉES.
--
-- Les logs du plan Hobby ne vivent qu'environ une heure : une erreur vue par un membre le soir
-- n'existait plus le lendemain matin. Cf. le commentaire du modèle dans schema.prisma et
-- src/lib/error-report.ts.
--
-- Rejouable : la base de recette est partagée par toutes les previews (cf. README.md).

CREATE TABLE IF NOT EXISTS "ErrorReport" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "digest" TEXT,
    "path" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "ErrorReport_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ErrorReport_createdAt_idx" ON "ErrorReport"("createdAt");
