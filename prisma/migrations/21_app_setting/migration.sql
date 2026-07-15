-- Réglages applicatifs éditables sans redéploiement (store clé/valeur générique, étape 2 de
-- l'admin). Première clé : "banner" (bannière d'annonce). Réutilisable pour les flags runtime.
-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);
