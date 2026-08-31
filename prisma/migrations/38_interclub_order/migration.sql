-- Classement des joueurs, pour ordonner les simples d'une rencontre interclub.
--
-- La compétition impose que le mieux classé des joueurs présents joue le simple n° 1, puis dans
-- l'ordre décroissant de classement (cf. lib/interclub-order.ts). Deux sources :
--   * `InterclubGuest.clt` — saisie À LA MAIN par l'admin : un joueur sans compte n'a rien à
--     rapprocher sur squashnet ;
--   * `User.interclubCltOverride` — correction À LA MAIN d'un membre dont le rapprochement
--     squashnet (`SquashnetRanking.clt`) a échoué ou s'est trompé (nom mal orthographié côté
--     ResaMania, licence pas encore rapprochée…). Prioritaire sur `SquashnetRanking.clt` quand
--     renseigné.
-- NULL des deux côtés = pas de correction / pas encore saisi.
ALTER TABLE "InterclubGuest" ADD COLUMN "clt" TEXT;
ALTER TABLE "User" ADD COLUMN "interclubCltOverride" TEXT;
