-- Déduplication défensive : si la base contient déjà plusieurs lignes Booking pour
-- le même (userId, classEventId) (bug corrigé par cette migration), on ne garde que
-- la plus récente. Sans ce nettoyage, la création de l'index unique échouerait.
DELETE FROM "Booking" a
USING "Booking" b
WHERE a."userId" = b."userId"
  AND a."classEventId" = b."classEventId"
  AND (a."createdAt" < b."createdAt"
       OR (a."createdAt" = b."createdAt" AND a."id" < b."id"));

-- CreateIndex
CREATE UNIQUE INDEX "Booking_userId_classEventId_key" ON "Booking"("userId", "classEventId");
