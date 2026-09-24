// Ce que la base sait des joueurs à apparier avec la fiche fédérale. Le pendant IMPUR
// d'`interclub-federal.ts` : la règle d'appariement est là-bas, pure et testable sans base ;
// ici on ne fait qu'aller chercher ce qu'elle attend.
//
// La séparation est celle d'`interclub-opponents.ts` / `interclub-opponents-db.ts`, et elle a
// la même raison d'être : deux appelants (la route de rapprochement et le rattachement d'un
// membre à une équipe) doivent poser la MÊME question à la base. Deux requêtes écrites
// séparément finiraient par diverger — l'une filtrant les comptes désactivés, l'autre pas — et
// le doublon signalé d'un côté serait invisible de l'autre.

import { prisma } from "./db";
import { normalize, YVETTE_CLUB } from "./squashnet/match";
import type { TeamRoster } from "./squashnet/roster";
import type { JoueurAppli } from "./interclub-federal";

/**
 * Les joueurs de l'appli qui composent cette équipe, membres et invités confondus.
 *
 * Les comptes DÉSACTIVÉS sont exclus, comme partout ailleurs (`teamRoster`) : un membre qu'un
 * admin a désactivé ne joue plus, et l'apparier à une ligne fédérale ne ferait que l'y ramener.
 *
 * ⚠️ LE VRAI NOM, JAMAIS LE PSEUDO. `nickname` est un choix d'affichage dans l'appli ; la
 * fédération ne connaît que `displayName`. Apparier sur le pseudo ne rapprocherait rien, et
 * l'admin chercherait longtemps pourquoi « Titi » n'est sur aucune fiche.
 */
export async function joueursDeLEquipe(teamId: string): Promise<JoueurAppli[]> {
  const [membres, invites] = await Promise.all([
    prisma.user.findMany({
      where: { teamId, disabledAt: null },
      select: { id: true, displayName: true, snLicence: true },
    }),
    prisma.interclubGuest.findMany({
      where: { teamId },
      select: { id: true, name: true, snLicence: true },
    }),
  ]);
  return [
    ...membres.map((u) => ({
      kind: "member" as const,
      id: u.id,
      name: u.displayName,
      licence: u.snLicence,
    })),
    ...invites.map((g) => ({
      kind: "guest" as const,
      id: g.id,
      name: g.name,
      licence: g.snLicence,
    })),
  ];
}

/**
 * La fiche reçue, SI elle est bien celle de notre club — sinon `null`.
 *
 * ⚠️ C'EST LA GARDE QUI EMPÊCHE D'IMPORTER LE CLUB D'À CÔTÉ. Les fiches adverses vivent dans la
 * MÊME table (`SquashnetTeamRoster`) : c'est elle qui sert le menu « en face ». Une erreur d'un
 * chiffre dans l'ancrage d'une de nos équipes suffirait, sans ce contrôle, à créer huit invités
 * de Verrières dans notre effectif — et ils y resteraient, alignables, personne ne s'attendant à
 * devoir vérifier ça.
 *
 * On compare le CLUB et non le nom d'équipe : « Squash de l'Yvette 1 » et « … 2 » sont deux
 * équipes du même club, et c'est le club sous lequel la fédération range nos joueurs.
 */
export function notreFiche(roster: TeamRoster | undefined): TeamRoster | null {
  if (!roster) return null;
  return normalize(roster.club ?? "") === normalize(YVETTE_CLUB) ? roster : null;
}
