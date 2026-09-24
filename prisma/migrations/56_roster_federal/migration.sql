-- LE RAPPROCHEMENT AVEC NOTRE PROPRE FICHE D'ÉQUIPE FÉDÉRALE.
--
-- POURQUOI DE NOUVELLES COLONNES PLUTÔT QUE `SquashnetRanking`. Ce sont deux lectures
-- différentes du même site, et une seule connaît les non-classés :
--
--   * le CLASSEMENT national (`ic_a=131079`) ne contient que les joueurs classés. Mesuré le
--     2026-09-24 sur la fiche de Verrieres 4 : sept inscrits sur huit y sont introuvables —
--     « DOXAT » rend zéro ligne, « BOUGARDIER » zéro, « CAGLIULI » zéro. Ils sont pourtant
--     licenciés et alignables ;
--   * la FICHE D'ÉQUIPE (`ic_a=393480`) les publie tous, avec licence et classement.
--
-- La passe MENSUELLE écrit les colonnes du classement. Faire écrire les deux sources au même
-- endroit ferait donc effacer un rapprochement de fiche par un run de classement, en silence —
-- exactement la panne muette que ce dépôt passe son temps à éviter. La priorité de LECTURE est
-- dans `lib/interclub-roster.ts` : correction admin, puis classement, puis fiche.
--
-- ⚠️ `snRosterRangM` / `rosterRangM` SONT NULS POUR UN NC. La fédération publie 9311 pour tous
-- les non-classés : c'est une sentinelle, pas un rang (vérifié sur les sept NC de la fiche, tous
-- à la même valeur à la même seconde). L'écrire placerait ces joueurs au 9311e rang national —
-- un nombre qui a l'air d'un fait, et qui se trie. Cf. `rangMUtile` dans `interclub-federal.ts`.
--
-- Rejouable : la base de recette est partagée par toutes les previews, et une branche voisine
-- peut avoir déjà posé ces colonnes (cf. prisma/migrations/README.md).

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "snLicence" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "snRosterClt" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "snRosterRangM" INTEGER;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "snRosterAt" TIMESTAMP(3);

ALTER TABLE "InterclubGuest" ADD COLUMN IF NOT EXISTS "rosterClt" TEXT;
ALTER TABLE "InterclubGuest" ADD COLUMN IF NOT EXISTS "rosterRangM" INTEGER;
ALTER TABLE "InterclubGuest" ADD COLUMN IF NOT EXISTS "rosterAt" TIMESTAMP(3);
