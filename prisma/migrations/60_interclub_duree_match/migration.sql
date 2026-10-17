-- DURÉE D'UN SIMPLE D'INTERCLUB.
--
-- Rien ne gardait l'heure du premier point, et l'heure de fin de chaque jeu était réécrite à
-- chaque jeu terminé. Deux colonnes, posées par le marquage en direct seulement. Cf. le
-- commentaire des champs dans schema.prisma et src/lib/interclub-duree.ts.
--
-- Rejouable : la base de recette est partagée par toutes les previews (cf. README.md).

ALTER TABLE "InterclubMatch" ADD COLUMN IF NOT EXISTS "startedAt" TIMESTAMP(3);
ALTER TABLE "InterclubMatch" ADD COLUMN IF NOT EXISTS "finishedAt" TIMESTAMP(3);
