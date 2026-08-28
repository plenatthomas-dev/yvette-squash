-- Joueur d'équipe interclub SANS compte sur l'appli.
--
-- POURQUOI CETTE TABLE
-- La règle du club — « seuls les membres de l'équipe qui dispute la rencontre peuvent être
-- alignés » — supposait que toute l'équipe soit inscrite sur l'appli. C'est faux : il y a
-- toujours quelqu'un qui joue le championnat sans l'avoir jamais ouverte. La seule échappatoire
-- était alors un nom libre accepté par l'API, qui rouvrait la composition à n'importe qui et
-- vidait la règle de son sens.
--
-- Un invité est un ROSTER, pas un compte : ni email, ni connexion, ni notification. Même forme
-- que TricountGuest (33_) — un seul champ `name`, unique dans son périmètre.
--
-- ⚠️ ON DELETE SET NULL sur InterclubMatch, et NON Cascade comme pour TricountGuest : une part
-- de dépense n'a aucun sens sans son invité, alors qu'un match joué en garde le nom FIGÉ dans
-- `homeDisplayName`. Retirer quelqu'un du roster ne doit pas effacer les rencontres passées.

-- CreateTable
CREATE TABLE "InterclubGuest" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InterclubGuest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InterclubGuest_teamId_idx" ON "InterclubGuest"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "InterclubGuest_teamId_name_key" ON "InterclubGuest"("teamId", "name");

-- AddForeignKey
ALTER TABLE "InterclubGuest" ADD CONSTRAINT "InterclubGuest_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "InterclubTeam"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "InterclubMatch" ADD COLUMN "homeGuestId" TEXT;

-- AddForeignKey
-- Pas d'index sur "homeGuestId" : ni "homeUserId" ni "scorerId" n'en ont (34_), et rien
-- n'interroge les matchs PAR joueur. Le seul chemin qui en profiterait est la suppression
-- d'un invité, rarissime et sur une table de la taille d'un club.
ALTER TABLE "InterclubMatch" ADD CONSTRAINT "InterclubMatch_homeGuestId_fkey" FOREIGN KEY ("homeGuestId") REFERENCES "InterclubGuest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddCheckConstraint (pas de représentation native côté schema.prisma)
-- Un simple porte un membre OU un invité, jamais les deux. Ce n'est PAS un XOR comme sur
-- Expense : les deux colonnes nulles est l'état normal d'une ligne « à désigner ».
ALTER TABLE "InterclubMatch" ADD CONSTRAINT "InterclubMatch_user_or_guest" CHECK (NOT ("homeUserId" IS NOT NULL AND "homeGuestId" IS NOT NULL));
