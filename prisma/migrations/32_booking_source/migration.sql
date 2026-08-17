-- Trace si une ligne Booking vient d'une réservation faite via l'appli ("app", valeur
-- historique de toutes les lignes existantes) ou détectée directement sur le planning
-- ResaMania ("resamania" — le membre a réservé ailleurs que dans l'appli). Posée par la
-- réconciliation planning ↔ base (cf. src/lib/booking-reconcile.ts), derrière le flag
-- `externalBookings`. Nullable non nécessaire : NOT NULL DEFAULT 'app' classe correctement
-- tout l'historique existant sans backfill.

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'app';
