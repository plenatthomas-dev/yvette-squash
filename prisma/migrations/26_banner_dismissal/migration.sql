-- Masquage de l'annonce rattaché au COMPTE (et non au navigateur). On stocke la `version` de
-- l'annonce masquée / dont la modale a été vue : une NOUVELLE annonce (version différente)
-- repasse devant les yeux. NULL = jamais masquée.
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "bannerDismissedVersion" TEXT,
ADD COLUMN     "bannerModalSeenVersion" TEXT;
