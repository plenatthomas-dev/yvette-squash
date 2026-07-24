-- lastSeenAt : dernière ACTIVITÉ réelle du membre, rafraîchie (avec throttle) à chaque
-- chargement de page tant que sa session vit — donc à jour même sans nouvelle authentification.
-- Distinct de lastLoginAt (dernière AUTHENTIFICATION), qui ne bouge pas quand un membre revient
-- avec un cookie de session encore valide (fenêtre 30 j).
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "lastSeenAt" TIMESTAMP(3);
