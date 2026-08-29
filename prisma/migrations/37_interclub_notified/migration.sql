-- Marqueurs d'annonce d'une rencontre interclub.
--
-- POURQUOI CES DEUX COLONNES
-- Les notifications « la rencontre commence » et « résultat final » ne doivent partir qu'UNE
-- fois. Elles étaient gardées par une comparaison entre le statut stocké de la rencontre, lu en
-- début de transaction, et le statut déduit après écriture — ce qui suppose que le statut ne
-- redescend jamais. Il redescend : `PATCH …/matches/{mid}` avec `games: []` remet un simple à
-- `pending`, donc la rencontre de `done` à `live`. Or c'est le geste NORMAL pour corriger un
-- score avec ce formulaire, qui n'offre qu'un « ✕ » par ligne.
--
-- Conséquence observée : corriger un simple en deux temps (vider, puis ressaisir) annonçait
-- « La rencontre commence » à tous les abonnés d'une rencontre jouée deux heures plus tôt, puis
-- leur renvoyait le résultat final une seconde fois.
--
-- Un marqueur persistant ne peut pas se réarmer, quoi que fasse le statut. Il dispense au
-- passage les notifications de dépendre de la colonne `status`, que le GET du détail recale
-- hors transaction.
--
-- NULL = pas encore annoncé. Les rencontres existantes repartent donc de zéro : sur une base où
-- des rencontres sont déjà terminées, la prochaine écriture sur l'une d'elles enverra son
-- résultat une fois. Retenu tel quel — la fonctionnalité n'est ouverte qu'en Recette, et un
-- backfill devinerait ce qui a été annoncé ou non.

-- AlterTable
ALTER TABLE "Interclub" ADD COLUMN "startNotifiedAt" TIMESTAMP(3);
ALTER TABLE "Interclub" ADD COLUMN "doneNotifiedAt" TIMESTAMP(3);
