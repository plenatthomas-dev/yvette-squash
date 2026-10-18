-- UNE DÉLÉGATION ACTIVE PAR COUPLE (audit 2026-10, point 22).
--
-- La route révoque l'ancienne délégation puis crée la nouvelle, dans une transaction en
-- READ COMMITTED : deux envois simultanés (double appui, deux onglets) pouvaient chacun ne rien
-- trouver à révoquer et laisser DEUX délégations vivantes vers le même membre. L'index unique
-- partiel le rend impossible. « Active » = non révoquée : l'échéance ne peut pas figurer dans
-- un index (now() n'est pas immuable), donc la route révoque désormais aussi les délégations
-- échues avant d'en créer une nouvelle.
--
-- Rejouable : la base de recette est partagée par toutes les previews (cf. README.md).

-- 1. Les échues jamais révoquées : marquées révoquées à leur échéance, sans notification.
UPDATE "Delegation"
SET "revokedAt" = "expiresAt", "endNotifiedAt" = COALESCE("endNotifiedAt", "expiresAt")
WHERE "revokedAt" IS NULL AND "expiresAt" <= CURRENT_TIMESTAMP;

-- 2. Doublons vivants d'un même couple : on garde la plus récente.
UPDATE "Delegation" d
SET "revokedAt" = CURRENT_TIMESTAMP, "endNotifiedAt" = COALESCE(d."endNotifiedAt", CURRENT_TIMESTAMP)
WHERE d."revokedAt" IS NULL
  AND EXISTS (
    SELECT 1 FROM "Delegation" e
    WHERE e."delegatorId" = d."delegatorId" AND e."delegateId" = d."delegateId"
      AND e."revokedAt" IS NULL
      AND (e."createdAt" > d."createdAt" OR (e."createdAt" = d."createdAt" AND e."id" > d."id"))
  );

CREATE UNIQUE INDEX IF NOT EXISTS "Delegation_active_couple_key"
    ON "Delegation"("delegatorId", "delegateId") WHERE "revokedAt" IS NULL;
