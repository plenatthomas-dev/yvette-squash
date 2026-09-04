-- Le RANG MIXTE entre dans l'ordre des simples d'une rencontre interclub, et les joueurs
-- sans compte sont désormais rapprochés sur squashnet comme les membres.
--
-- POURQUOI. L'ordre des simples ne se décidait que sur le CLASSEMENT (« 5A », « 4D »…), et deux
-- joueurs de même classement étaient réputés interchangeables. Ce n'est pas la règle de la
-- compétition : à classement égal, c'est le rang mixte (`rangM`) qui départage — sauf entre NC,
-- qui restent équivalents. Il fallait donc que TOUT joueur alignable ait un rang mixte connu,
-- des deux côtés du roster.
--
-- 1) MEMBRES : le rang mixte venait uniquement du rapprochement squashnet
--    (`SquashnetRanking.rangM`). Un membre dont le rapprochement échoue recevait une correction
--    de classement (`interclubCltOverride`) mais aucun rang — il devenait donc inalignable sans
--    qu'aucun écran puisse y remédier. D'où la correction symétrique.
ALTER TABLE "User" ADD COLUMN "interclubRangMOverride" INTEGER;

-- 2) INVITÉS : `InterclubGuest.clt` était une saisie manuelle, seule source possible faute de
--    rapprochement. Or ces joueurs sont licenciés comme les autres — squashnet les connaît. On
--    sépare donc les deux sources, pour que le rafraîchissement mensuel n'écrase pas la
--    correction de l'admin, et réciproquement :
--      * `cltOverride` / `rangMOverride` — la saisie ADMIN, prioritaire ;
--      * `snClt` / `snRangM` / … — le RAPPROCHEMENT squashnet, automatique.
--    L'ancienne colonne `clt` portait déjà une saisie manuelle : on la RENOMME plutôt que d'en
--    créer une de plus, ce qui préserve les classements déjà saisis en recette.
ALTER TABLE "InterclubGuest" RENAME COLUMN "clt" TO "cltOverride";
ALTER TABLE "InterclubGuest" ADD COLUMN "rangMOverride" INTEGER;
ALTER TABLE "InterclubGuest" ADD COLUMN "snClt" TEXT;
ALTER TABLE "InterclubGuest" ADD COLUMN "snRangM" INTEGER;
ALTER TABLE "InterclubGuest" ADD COLUMN "snLicence" TEXT;
ALTER TABLE "InterclubGuest" ADD COLUMN "snClub" TEXT;
ALTER TABLE "InterclubGuest" ADD COLUMN "snMonth" TEXT;
-- Verdict de la dernière tentative de rapprochement : « matched » | « moved » | « unknown ».
-- NULL = jamais tenté (toutes les lignes existantes, jusqu'au prochain passage du cron).
ALTER TABLE "InterclubGuest" ADD COLUMN "snStatus" TEXT;
ALTER TABLE "InterclubGuest" ADD COLUMN "snCheckedAt" TIMESTAMP(3);
