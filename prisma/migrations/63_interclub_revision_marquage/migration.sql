-- RÉVISION DU MARQUAGE (audit 2026-10, point 17).
--
-- La garde `knownGameCount` ne compare que les jeux TERMINÉS : deux appareils (deux marqueurs,
-- ou le même compte sur deux téléphones) pouvaient encore s'écraser le jeu en cours. Chaque
-- écriture incrémente désormais cette révision ; un envoi bâti sur une autre est refusé.
--
-- Rejouable : la base de recette est partagée par toutes les previews (cf. README.md).

ALTER TABLE "InterclubMatch" ADD COLUMN IF NOT EXISTS "liveRev" INTEGER NOT NULL DEFAULT 0;
