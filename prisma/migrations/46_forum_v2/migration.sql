-- LE FIL DEVIENT UNE CONVERSATION : citation, réactions, sondages.
--
-- Trois choix de conception sont inscrits dans ce fichier et méritent d'être relus avant
-- toute modification ultérieure :
--
--  1. La CITATION est dénormalisée (`replyToAuthor`, `replyToExcerpt`) en plus de la clé
--     `replyToId`. L'instantané permet d'afficher une citation sans jointure — y compris sur
--     un message reçu par le courtier — et de survivre à la purge des 12 mois, qui efface la
--     cible bien avant la réponse. La clé étrangère est en `ON DELETE SET NULL` et surtout
--     PAS en cascade : effacer une question ne doit pas effacer la discussion qu'elle a
--     ouverte. La contrepartie (blanchir l'instantané quand la cible est supprimée) est faite
--     par la route, pas par la base.
--
--  2. La RÉACTION porte un index unique (message, membre, emoji). C'est lui qui rend la
--     bascule idempotente : deux clics qui se croisent ne peuvent pas créer deux lignes.
--
--  3. Le SONDAGE est un message (`messageId` UNIQUE, en cascade). Il prend donc sa place
--     chronologique dans le fil et hérite gratuitement de la suppression, de la purge à
--     12 mois et de la notification. La question est le `body` du message porteur.
--     L'unicité d'un vote porte sur (option, membre) et NON sur (sondage, membre) : le vote
--     est à choix MULTIPLE, cocher deux cases fait bien deux lignes.

-- AlterTable : la citation, sur le message lui-même.
ALTER TABLE "ForumMessage" ADD COLUMN     "replyToId" TEXT,
ADD COLUMN     "replyToAuthor" TEXT,
ADD COLUMN     "replyToExcerpt" TEXT;

-- CreateIndex : sert l'effacement des instantanés à la suppression d'un message.
CREATE INDEX "ForumMessage_replyToId_idx" ON "ForumMessage"("replyToId");

-- AddForeignKey : SET NULL, jamais CASCADE (cf. point 1 ci-dessus).
ALTER TABLE "ForumMessage" ADD CONSTRAINT "ForumMessage_replyToId_fkey" FOREIGN KEY ("replyToId") REFERENCES "ForumMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "ForumReaction" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ForumReaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ForumReaction_messageId_idx" ON "ForumReaction"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "ForumReaction_messageId_userId_emoji_key" ON "ForumReaction"("messageId", "userId", "emoji");

-- AddForeignKey
ALTER TABLE "ForumReaction" ADD CONSTRAINT "ForumReaction_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ForumMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForumReaction" ADD CONSTRAINT "ForumReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "ForumPoll" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ForumPoll_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ForumPoll_messageId_key" ON "ForumPoll"("messageId");

-- AddForeignKey
ALTER TABLE "ForumPoll" ADD CONSTRAINT "ForumPoll_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ForumMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "ForumPollOption" (
    "id" TEXT NOT NULL,
    "pollId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "ForumPollOption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ForumPollOption_pollId_idx" ON "ForumPollOption"("pollId");

-- AddForeignKey
ALTER TABLE "ForumPollOption" ADD CONSTRAINT "ForumPollOption_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "ForumPoll"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "ForumPollVote" (
    "id" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ForumPollVote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ForumPollVote_optionId_idx" ON "ForumPollVote"("optionId");

-- CreateIndex
CREATE UNIQUE INDEX "ForumPollVote_optionId_userId_key" ON "ForumPollVote"("optionId", "userId");

-- AddForeignKey
ALTER TABLE "ForumPollVote" ADD CONSTRAINT "ForumPollVote_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "ForumPollOption"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForumPollVote" ADD CONSTRAINT "ForumPollVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
