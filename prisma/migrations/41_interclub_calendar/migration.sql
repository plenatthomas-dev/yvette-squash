-- CALENDRIER DE CHAMPIONNAT, CAPITAINES ET DISPONIBILITÉS.
--
-- Jusqu'ici une rencontre n'avait qu'une date « YYYY-MM-DD » : ni heure, ni lieu, ni journée de
-- championnat, et rien nulle part ne recueillait une disponibilité. Le calendrier se lisait sur
-- le site de la ligue et les présences se comptaient sur WhatsApp, chaque semaine, à la main.

-- === La rencontre : quand, où, quelle journée ================================================
-- `time` est une CHAÎNE « HH:MM », comme `date` est une chaîne : tout le module raisonne en
-- heure locale du club, et introduire ici un instant absolu ne produirait que des soirées
-- décalées d'une heure deux fois par an.
ALTER TABLE "Interclub" ADD COLUMN "time" TEXT;
ALTER TABLE "Interclub" ADD COLUMN "venue" TEXT;
ALTER TABLE "Interclub" ADD COLUMN "venueAddress" TEXT;

-- La JOURNÉE (« J1 »). Clé stable d'un import à l'autre : la date est précisément ce qui bouge,
-- donc rapprocher deux calendriers par la date créerait une rencontre de plus à chaque report
-- au lieu de corriger l'existante.
ALTER TABLE "Interclub" ADD COLUMN "round" TEXT;

-- La date est-elle FERME ? Pas une précaution théorique : la fédération publie les journées non
-- encore planifiées avec une DATE BOUCHON commune (sur l'événement d'essai, J11 à J14 tombent
-- toutes le même jour). Convoquer l'équipe quatre fois le même soir sur cette base serait pire
-- que ne rien afficher — d'où la règle tenue par le cron : aucune notification, aucune relance
-- sur une rencontre non confirmée.
-- DEFAULT true : tout ce qui existe déjà a été saisi à la main, donc à une date voulue.
ALTER TABLE "Interclub" ADD COLUMN "dateConfirmed" BOOLEAN NOT NULL DEFAULT true;

-- « <eventid>:<round> ». Non NULL = rencontre créée par l'IMPORT, donc modifiable par lui ;
-- NULL = saisie à la main, et l'import n'y touche jamais. Même doctrine que les corrections de
-- classement (migrations 38, 39, 40) : l'automatique et l'humain ne partagent aucune colonne.
ALTER TABLE "Interclub" ADD COLUMN "snMatchKey" TEXT;

-- Marqueurs d'idempotence, jumeaux de `startNotifiedAt` / `doneNotifiedAt` : ils distinguent
-- « personne n'a encore été prévenu » de « tout le monde l'a été ». Sans eux, un cron quotidien
-- redemanderait chaque matin à la même équipe si elle est disponible.
ALTER TABLE "Interclub" ADD COLUMN "availabilityOpenedAt" TIMESTAMP(3);
ALTER TABLE "Interclub" ADD COLUMN "availabilityRemindedAt" TIMESTAMP(3);

-- Une journée fédérale ne peut exister qu'une fois par équipe : c'est ce qui permet de
-- ré-importer le calendrier autant de fois qu'on veut sans jamais dupliquer une rencontre.
-- (En PostgreSQL, un index UNIQUE n'empêche pas plusieurs lignes à NULL : les rencontres
-- saisies à la main, toutes à `snMatchKey` NULL, cohabitent donc sans contrainte.)
CREATE UNIQUE INDEX "Interclub_teamId_snMatchKey_key" ON "Interclub"("teamId", "snMatchKey");

-- === L'équipe : son capitaine et son ancrage fédéral =========================================
-- Le capitaine est une DÉSIGNATION, pas un droit : il ne peut rien que les autres ne puissent
-- (composer reste ouvert à tout membre — verrouiller créerait un point de blocage le soir où le
-- capitaine n'est pas là). Ce qu'il apporte est ailleurs : l'équipe sait à qui parler, et lui
-- seul reçoit le récapitulatif des disponibilités et les alertes de calendrier.
-- SET NULL : perdre son compte ne doit pas emporter l'équipe.
ALTER TABLE "InterclubTeam" ADD COLUMN "captainId" TEXT;
ALTER TABLE "InterclubTeam"
  ADD CONSTRAINT "InterclubTeam_captainId_fkey"
  FOREIGN KEY ("captainId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "InterclubTeam_captainId_idx" ON "InterclubTeam"("captainId");

-- De quel ÉVÉNEMENT fédéral cette équipe joue le calendrier, et sous quel identifiant elle y
-- figure. Les DEUX sont nécessaires : l'événement dit quoi télécharger, `snTeamId` dit lesquelles
-- des ~56 rencontres rendues sont les nôtres — le paramètre `teamid` de squashnet ne filtre RIEN,
-- il rend tout l'événement. NULL = pas d'import possible pour cette équipe.
ALTER TABLE "InterclubTeam" ADD COLUMN "snEventId" TEXT;
ALTER TABLE "InterclubTeam" ADD COLUMN "snTeamId" TEXT;

-- Empreinte du dernier calendrier téléchargé, et date du dernier contrôle. L'empreinte est ce
-- qui rend le contrôle hebdomadaire supportable : sans elle, un report détecté une fois serait
-- re-signalé tous les lundis jusqu'à ce qu'un admin l'applique, et l'alerte deviendrait un bruit
-- qu'on n'ouvre plus. `snCheckedAt` répond à l'autre question, celle que le silence ne tranche
-- pas : « rien n'a bougé », ou « on n'a pas regardé » ?
ALTER TABLE "InterclubTeam" ADD COLUMN "snCalendarHash" TEXT;
ALTER TABLE "InterclubTeam" ADD COLUMN "snCheckedAt" TIMESTAMP(3);

-- === La disponibilité ========================================================================
-- Trois états et non deux : « maybe » évite les faux « oui » et se relance tout seul, sans
-- compter comme un présent pour le capitaine.
--
-- DEUX POPULATIONS, comme partout dans ce module : un MEMBRE (`userId`) ou un joueur SANS COMPTE
-- (`guestId`), jamais les deux. L'exclusivité est tenue par le code, comme pour
-- `InterclubMatch.homeUserId` / `homeGuestId`.
--
-- `setById` porte QUI a saisi. Égal à `userId` ⇒ réponse de PREMIÈRE MAIN ; différent (ou
-- réponse d'un joueur sans compte) ⇒ réponse RELAYÉE. Une partie de l'équipe ne verra jamais
-- l'appel — pas de compte, ou notifications désactivées —, donc n'importe quel coéquipier peut
-- consigner la réponse d'un autre ; c'est la trace, et non la restriction, qui rend le relais
-- sûr. Pas de booléen `relayed` en plus : il serait déductible, donc capable de mentir.
-- RESTRICT sur `setById` : on ne supprime pas un compte en laissant des réponses signées par un
-- fantôme.
CREATE TABLE "InterclubAvailability" (
    "id" TEXT NOT NULL,
    "interclubId" TEXT NOT NULL,
    "userId" TEXT,
    "guestId" TEXT,
    "status" TEXT NOT NULL,
    "comment" TEXT,
    "setById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InterclubAvailability_pkey" PRIMARY KEY ("id")
);

-- Une seule réponse par personne et par rencontre — la dernière remplace la précédente.
CREATE UNIQUE INDEX "InterclubAvailability_interclubId_userId_key"
  ON "InterclubAvailability"("interclubId", "userId");
CREATE UNIQUE INDEX "InterclubAvailability_interclubId_guestId_key"
  ON "InterclubAvailability"("interclubId", "guestId");
CREATE INDEX "InterclubAvailability_interclubId_status_idx"
  ON "InterclubAvailability"("interclubId", "status");

ALTER TABLE "InterclubAvailability"
  ADD CONSTRAINT "InterclubAvailability_interclubId_fkey"
  FOREIGN KEY ("interclubId") REFERENCES "Interclub"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InterclubAvailability"
  ADD CONSTRAINT "InterclubAvailability_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InterclubAvailability"
  ADD CONSTRAINT "InterclubAvailability_guestId_fkey"
  FOREIGN KEY ("guestId") REFERENCES "InterclubGuest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InterclubAvailability"
  ADD CONSTRAINT "InterclubAvailability_setById_fkey"
  FOREIGN KEY ("setById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
