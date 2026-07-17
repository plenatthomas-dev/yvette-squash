-- Connexion biométrique (amélioration B) : mémorise l'état de sauvegarde du passkey renvoyé
-- par WebAuthn à l'enrôlement, pour distinguer un passkey SYNCHRONISÉ (iCloud/Google, qui suit
-- l'utilisateur sur ses autres appareils) d'un passkey LIÉ À L'APPAREIL (perdu avec l'appareil).
-- Sert à avertir un membre qui n'aurait que des passkeys device-bound (risque de blocage en cas
-- de perte). Nullable : les passkeys enrôlés avant cette migration restent « inconnus ».
-- Écrit en « IF NOT EXISTS » pour rester idempotent (cohérent avec les migrations précédentes).

-- AlterTable
ALTER TABLE "Passkey" ADD COLUMN IF NOT EXISTS "backedUp" BOOLEAN;
ALTER TABLE "Passkey" ADD COLUMN IF NOT EXISTS "deviceType" TEXT;
