-- LE CLASSEMENT DE LA POULE : une DIVISION de plus à connaître, et un cache pour l'afficher.
--
-- 1) `snDrawId` — LA DIVISION (« Hommes 4 » = 47760).
--
-- On croyait tenir l'ancrage avec l'épreuve, la poule et l'équipe. C'est vrai du calendrier,
-- c'est FAUX du classement : sur `ic_a=394242`, le `roundid` est IGNORÉ tant qu'on ne dit pas
-- de quelle division la poule fait partie, et la fédération rend alors la division 1.
--
-- Mesuré en demandant la poule IVD (Hommes 4, où joue l'Yvette) : la réponse était le
-- classement de Squash Pyramides, Montigny, Vincennes… Un tableau parfaitement bien formé, huit
-- équipes, dix-huit colonnes, aucune erreur — et pas une ligne qui nous concerne. Pire que la
-- panne muette de la poule sur le calendrier, parce qu'ici le résultat A L'AIR juste : on
-- l'aurait affiché tel quel.
--
-- Les QUATRE identifiants vont donc ensemble ou pas du tout, garde tenue par la route d'admin.
--
-- 2) `snStandingsJson` / `snStandingsAt` — le cache.
--
-- Le classement ne bouge qu'après une journée de championnat, soit une fois par semaine au
-- plus. L'aller chercher à chaque ouverture de l'écran ferait dépendre l'appli de la
-- disponibilité de squashnet pour afficher une page qu'on consulte tous les jours. Il est donc
-- rafraîchi par la passe hebdomadaire qui contrôle déjà le calendrier de chaque équipe — pas
-- de nouveau cron — et servi depuis la base.
--
-- `snStandingsAt` n'est pas décoratif : sans lui, un classement figé depuis trois semaines
-- ressemble à un classement à jour. La date se lit à l'écran.
ALTER TABLE "InterclubTeam" ADD COLUMN "snDrawId" TEXT;
ALTER TABLE "InterclubTeam" ADD COLUMN "snStandingsJson" TEXT;
ALTER TABLE "InterclubTeam" ADD COLUMN "snStandingsAt" TIMESTAMP(3);
