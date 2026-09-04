-- LA SIGNATURE D'UNE DISPONIBILITÉ NE DOIT PAS EMPÊCHER DE SUPPRIMER UN COMPTE.
--
-- La migration 41 posait `setById` en NOT NULL / ON DELETE RESTRICT, avec cette justification :
-- « on ne supprime pas un compte en laissant des réponses signées par un fantôme ». L'intention
-- était juste, la conséquence ne l'était pas.
--
-- CE QUE ÇA CASSAIT. `setById` est écrit sur TOUTE réponse, y compris celle qu'on donne pour
-- soi-même. Dès qu'un membre avait répondu une seule fois, `prisma.user.delete` heurtait la
-- contrainte — et sous PostgreSQL, RESTRICT est vérifié AVANT les autres actions référentielles,
-- donc le ON DELETE CASCADE de `userId`, qui aurait effacé cette même ligne, ne s'exécutait
-- jamais. Pire, `deleteBlockersFor` ne comptait pas ces lignes : le garde-fou en 409 ne se
-- déclenchait pas, et l'admin recevait un 500 nu. La note de confidentialité, elle, promet que
-- « tes données disparaissent avec ton compte » — le droit à l'effacement butait là-dessus.
--
-- POURQUOI SET NULL NE PERD RIEN. Une ligne où `setById` égalait `userId` est emportée par le
-- CASCADE de `userId` : elle disparaît avec son auteur, il n'y a rien à mettre à NULL. Les
-- seules lignes qui survivent avec `setById` NULL sont donc celles qu'un TIERS avait saisies —
-- autrement dit, `setById IS NULL` se lit sans ambiguïté « relais, par quelqu'un qui n'est plus
-- là ». L'information « ce n'est pas l'intéressé qui a répondu » est conservée ; seul le nom du
-- relayeur s'en va, ce qui est précisément ce que la suppression du compte doit obtenir.
--
-- La colonne reste NOT NULL À L'ÉCRITURE côté applicatif : on ne crée jamais une réponse sans
-- signataire. NULL n'est atteignable que par la suppression d'un compte.
ALTER TABLE "InterclubAvailability" DROP CONSTRAINT "InterclubAvailability_setById_fkey";
ALTER TABLE "InterclubAvailability" ALTER COLUMN "setById" DROP NOT NULL;
ALTER TABLE "InterclubAvailability"
  ADD CONSTRAINT "InterclubAvailability_setById_fkey"
  FOREIGN KEY ("setById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
