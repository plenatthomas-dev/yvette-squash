-- LES DEUX PURGES QUI BALAYAIENT TOUTE LEUR TABLE.
--
-- Deux tables sont nettoyées « en passant », sur le chemin critique de la connexion :
--
--   • `Session`      — `createSession` supprime d'abord les sessions expirées. Sans elles,
--                      chaque session morte garderait son refresh token chiffré indéfiniment,
--                      puisqu'une session n'est relue que si son propre cookie revient.
--   • `LoginAttempt` — chaque tentative purge les lignes sorties de la fenêtre de 15 min.
--
-- Aucune des deux n'avait d'index utilisable pour son filtre. Le nettoyage lisait donc la
-- table entière à chaque connexion. C'est sans effet mesurable aujourd'hui — quelques dizaines
-- de lignes pour un club de quarante membres — et ça le reste tant que personne ne regarde :
-- un balayage complet ne devient visible qu'au moment où la table a grossi, c'est-à-dire trop
-- tard, et sur le chemin le plus sensible de l'appli.
--
-- ⚠️ `LoginAttempt` A DÉJÀ DEUX INDEX, ET ILS NE SERVENT PAS À ÇA. `(ip, createdAt)` et
-- `(identifier, createdAt)` portent la requête CHAUDE — compter les échecs récents d'une IP ou
-- d'un compte, à chaque tentative de connexion. La purge, elle, ne filtre QUE sur l'ancienneté,
-- et un index dont `createdAt` n'est pas la première colonne ne sait pas la servir. Le nouvel
-- index s'AJOUTE aux deux autres : en retirer un dégraderait l'anti-force-brute.
--
-- Migration purement additive : deux index, aucune donnée touchée, aucun verrou long sur des
-- tables de cette taille. `IF NOT EXISTS` parce qu'un index peut avoir été posé à la main sur
-- une base avant que la migration n'y passe.

CREATE INDEX IF NOT EXISTS "Session_expiresAt_idx" ON "Session"("expiresAt");

CREATE INDEX IF NOT EXISTS "LoginAttempt_createdAt_idx" ON "LoginAttempt"("createdAt");
