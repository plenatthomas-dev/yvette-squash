-- SCORE ANNONCÉ EN FIN DE RENCONTRE (audit 2026-10, point 19).
--
-- `doneNotifiedAt` ne se réarme jamais : un faux « 3-1 » notifié sur une erreur de marquage
-- n'était jamais rectifié. On garde le score annoncé ; une correction qui le change renvoie
-- une notification rectificative.
--
-- Rejouable : la base de recette est partagée par toutes les previews (cf. README.md).

ALTER TABLE "Interclub" ADD COLUMN IF NOT EXISTS "doneNotifiedScore" TEXT;
