-- Marqueur « fin de délégation notifiée » : le push envoyé au délégataire à la fin
-- (révocation manuelle OU expiration naturelle) n'est émis qu'une seule fois.
ALTER TABLE "Delegation" ADD COLUMN "endNotifiedAt" TIMESTAMP(3);

-- Pas de notification rétroactive : toute délégation déjà terminée (expirée ou révoquée)
-- au moment de la migration est marquée comme déjà notifiée, pour que le cron ne réveille
-- pas d'anciennes fins de délégation.
UPDATE "Delegation" SET "endNotifiedAt" = now()
WHERE "expiresAt" < now() OR "revokedAt" IS NOT NULL;
