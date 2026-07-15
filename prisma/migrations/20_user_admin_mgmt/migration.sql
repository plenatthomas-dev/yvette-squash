-- Gestion des membres (espace admin, étape 1).
-- lastLoginAt : dernière connexion réussie (repère les comptes inactifs).
-- disabledAt  : compte désactivé par un admin (connexion refusée), alternative non destructive
--               à la suppression pour les membres ResaMania / porteurs d'historique financier.
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "lastLoginAt" TIMESTAMP(3),
ADD COLUMN     "disabledAt" TIMESTAMP(3);
