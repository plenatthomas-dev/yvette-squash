-- LE CRÉATEUR D'UNE RENCONTRE NE BLOQUE PLUS LA SUPPRESSION D'UN MEMBRE (audit 2026-10, point 16).
--
-- `Interclub.createdById` était en RESTRICT : un membre qui avait saisi une seule rencontre (ou
-- un admin qui avait importé le calendrier) devenait indélébile. La rencontre appartient à
-- l'équipe, pas à celui qui l'a tapée : à sa suppression, le champ passe à NULL et la rencontre
-- reste, modifiable par les admins.
--
-- Rejouable : la base de recette est partagée par toutes les previews (cf. README.md).

ALTER TABLE "Interclub" ALTER COLUMN "createdById" DROP NOT NULL;

ALTER TABLE "Interclub" DROP CONSTRAINT IF EXISTS "Interclub_createdById_fkey";
ALTER TABLE "Interclub" ADD CONSTRAINT "Interclub_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
