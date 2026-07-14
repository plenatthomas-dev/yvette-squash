-- Inscription sur invitation : une demande de compte/réinitialisation reste « en attente »
-- tant qu'un admin ne l'a pas approuvée. `approvedAt` NULL = en attente (jeton inexploitable).
-- AlterTable
ALTER TABLE "EmailToken" ADD COLUMN     "approvedAt" TIMESTAMP(3);
