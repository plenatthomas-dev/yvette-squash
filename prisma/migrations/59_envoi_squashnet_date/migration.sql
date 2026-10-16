-- QUAND LE SCORE EST PARTI SUR SQUASHNET.
--
-- L'envoi depuis l'espace capitaine ne laissait aucune trace : rouvrir la rencontre proposait
-- d'envoyer à nouveau, sans dire que c'était fait. Cf. le commentaire du champ dans schema.prisma.
--
-- Rejouable : la base de recette est partagée par toutes les previews (cf. README.md).

ALTER TABLE "InterclubOfficial" ADD COLUMN IF NOT EXISTS "sentAt" TIMESTAMP(3);
