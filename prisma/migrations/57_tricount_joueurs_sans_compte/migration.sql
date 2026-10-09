-- LES JOUEURS DU CLUB SANS COMPTE, DANS LE PARTAGE DE FRAIS.
--
-- Un joueur d'équipe interclub qui n'a pas l'appli (`InterclubGuest`) est proposé dans
-- « Pour qui ? ». Sur un tricount, il est porté par `TricountGuest` — la table des invités,
-- dont il partage toutes les règles : il porte une part, n'est jamais payeur d'une vraie
-- dépense, et c'est son créancier qui confirme son remboursement. Le lien dit seulement QUI il
-- est : son vrai nom s'affiche sans « (ext) », la même personne est reconnue d'une date à
-- l'autre, et la fusion admin peut faire passer ses dettes sur le compte qu'il finit par créer.
--
-- SET NULL et non CASCADE : retirer un joueur d'une équipe ne doit JAMAIS effacer une part, donc
-- rééquilibrer l'historique d'argent en silence. Il redevient un invité ordinaire.
--
-- Rejouable : la base de recette est partagée par toutes les previews (cf. README.md).

ALTER TABLE "TricountGuest" ADD COLUMN IF NOT EXISTS "interclubGuestId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "TricountGuest_tricountId_interclubGuestId_key"
    ON "TricountGuest"("tricountId", "interclubGuestId");

CREATE INDEX IF NOT EXISTS "TricountGuest_interclubGuestId_idx"
    ON "TricountGuest"("interclubGuestId");

ALTER TABLE "TricountGuest" DROP CONSTRAINT IF EXISTS "TricountGuest_interclubGuestId_fkey";
ALTER TABLE "TricountGuest" ADD CONSTRAINT "TricountGuest_interclubGuestId_fkey"
    FOREIGN KEY ("interclubGuestId") REFERENCES "InterclubGuest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
