// Le ROSTER des équipes adverses, côté base : ce qu'on en a gardé, et quand aller le rechercher.
//
// Le pendant IMPUR de `squashnet/roster.ts` (le parsing) et d'`interclub-opponents.ts` (la
// fusion). La même séparation que partout ailleurs dans ce dépôt — `interclub-order.ts` (pur) et
// `interclub-roster.ts` (base) — et pour la même raison : l'écran importe la règle, jamais la
// lecture.

import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { estRoster, fetchTeamRoster, RosterUnreadableError, type TeamRoster } from "./squashnet/roster";

/**
 * Client minimal — les DEUX SEULES méthodes qu'on emploie, et pas la délégation entière.
 *
 * C'est ce qui rend la dépendance lisible dans la signature : cette couche lit et écrit une
 * table de cache, elle ne supprime ni ne compte rien. Un appelant qui voudrait lui passer autre
 * chose (une transaction, un double de test) sait exactement ce qu'il doit fournir.
 */
type Db = {
  squashnetTeamRoster: Pick<
    Prisma.TransactionClient["squashnetTeamRoster"],
    "findMany" | "upsert"
  >;
};

/**
 * Au-delà de combien de jours un roster est-il considéré comme à rafraîchir ?
 *
 * SEPT JOURS, et le choix vient de ce que la donnée fait : un club inscrit son effectif en début
 * de saison, puis n'y touche qu'au coup par coup (une mutation, un renfort — le fixture de
 * référence en montre un, inscrit deux semaines après les autres). Une semaine suffit donc
 * largement à suivre le mouvement, et borne le trafic à une requête par équipe et par semaine.
 *
 * ⚠️ CE N'EST PAS UNE PÉREMPTION. Un roster plus vieux que ce délai reste SERVI : il est
 * infiniment plus utile qu'un champ vide, et son âge est publié (`fetchedAt`) pour qui veut en
 * juger. Le seuil ne décide que d'une chose — faut-il redemander, si l'occasion se présente.
 */
export const ROSTER_FRAIS_JOURS = 7;

/** Espacement entre deux requêtes fédérales, en millisecondes (cf. `backfill.ts`, `DELAI_MS`). */
export const DELAI_MS = 800;

/** Le roster relu depuis sa colonne texte, ou null si elle ne porte rien d'exploitable. */
function lireRoster(json: string | null): TeamRoster | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    // La garde de FORME, et non le seul `JSON.parse` : un roster d'un format antérieur passe
    // l'analyse syntaxique, puis lève au rendu — où il n'y a pas d'error boundary. C'est la
    // doctrine de `lireRapport` et d'`estLigneClassement`, appliquée à la même sorte de colonne.
    if (!estRoster(v)) return null;
    // `ties` COMBLÉ PAR UNE LISTE VIDE, jamais laissé absent. Les rosters rangés avant que le
    // champ n'existe n'en portent pas : le type promet un tableau, le JSON rend `undefined`, et
    // le premier `.map` lèverait au rendu — là où il n'y a pas d'error boundary. La liste vide
    // dit la vérité : on n'a pas ces rencontres. Un rafraîchissement les apportera.
    return v.ties ? v : { ...v, ties: [] };
  } catch {
    return null;
  }
}

/**
 * Les rosters qu'on a en base pour ces équipes, indexés par `snTeamId`.
 *
 * NE TÉLÉCHARGE RIEN, et c'est délibéré : cette fonction sert les menus et la garde de
 * composition, c'est-à-dire des chemins où quelqu'un attend devant son écran. Une requête
 * fédérale y coûterait une seconde à chaque frappe. Le rafraîchissement est un geste à part
 * (`refreshRosters`), lent et explicite.
 *
 * Les équipes sans ligne sont simplement absentes de la carte : la fusion retombe alors sur nos
 * propres feuilles de match, ce qu'elle savait déjà faire.
 */
export async function loadRosters(
  snTeamIds: readonly string[],
  db: Db = prisma,
): Promise<Map<string, TeamRoster>> {
  const ids = [...new Set(snTeamIds.filter(Boolean))];
  if (ids.length === 0) return new Map();

  const rows = await db.squashnetTeamRoster.findMany({
    where: { snTeamId: { in: ids } },
    select: { snTeamId: true, rosterJson: true },
  });

  const parId = new Map<string, TeamRoster>();
  for (const r of rows) {
    const roster = lireRoster(r.rosterJson);
    if (roster) parId.set(r.snTeamId, roster);
  }
  return parId;
}

/** Ce qu'un rafraîchissement a fait d'une équipe — de quoi le dire sans le deviner. */
export interface RosterOutcome {
  snTeamId: string;
  /**
   * `fetched`    — relu chez la ligue et rangé ;
   * `fresh`      — déjà en base et assez récent, aucune requête ;
   * `unreadable` — la ligue a répondu autre chose que ce qu'on sait lire ;
   * `failed`     — elle n'a pas répondu (réseau, délai de garde, 5xx).
   *
   * `unreadable` et `failed` ne se confondent pas : le premier appelle une recapture de
   * fixture, le second d'attendre. Les afficher pareil enverrait chercher un bug qui n'existe
   * pas — la panne muette que tout ce module cherche à éviter.
   */
  status: "fetched" | "fresh" | "unreadable" | "failed";
  /** Nombre de joueurs inscrits, quand on a pu lire. */
  players?: number;
}

/**
 * Va chercher chez la fédération les rosters manquants ou périmés, et les range.
 *
 * LENT PAR CONSTRUCTION : une requête par équipe, espacées de `DELAI_MS`. Cinq équipes de poule
 * coûtent donc quatre secondes — à comparer aux huit recherches de dix secondes que la
 * vérification d'UNE rencontre demandait pour le même résultat, en moins sûr.
 *
 * `force` refait tout, sans regarder l'âge : c'est le bouton qu'on presse quand un club vient
 * d'inscrire quelqu'un et qu'on ne veut pas attendre une semaine.
 *
 * NE JETTE JAMAIS sur l'échec d'une équipe. Une poule où un club répond mal ne doit pas priver
 * de roster les quatre autres — et l'appelant a besoin de savoir LAQUELLE a échoué, ce qu'une
 * exception ne dit pas.
 */
export async function refreshRosters(
  snTeamIds: readonly string[],
  opts: { force?: boolean; now?: Date; db?: Db; delaiMs?: number } = {},
): Promise<RosterOutcome[]> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? new Date();
  const delai = opts.delaiMs ?? DELAI_MS;
  const ids = [...new Set(snTeamIds.filter(Boolean))];
  if (ids.length === 0) return [];

  const connus = await db.squashnetTeamRoster.findMany({
    where: { snTeamId: { in: ids } },
    select: { snTeamId: true, fetchedAt: true, rosterJson: true },
  });
  const parId = new Map(connus.map((r) => [r.snTeamId, r]));
  const seuil = now.getTime() - ROSTER_FRAIS_JOURS * 86_400_000;

  const outcomes: RosterOutcome[] = [];
  let premier = true;

  for (const snTeamId of ids) {
    const connu = parId.get(snTeamId);
    // Assez récent ET exploitable : une ligne dont le JSON ne se relit pas doit être refaite,
    // si récente soit-elle — sinon un format devenu illisible se fige pour une semaine.
    if (!opts.force && connu && connu.fetchedAt.getTime() >= seuil && lireRoster(connu.rosterJson)) {
      outcomes.push({ snTeamId, status: "fresh" });
      continue;
    }

    // L'espacement précède l'appel, jamais après le dernier : squashnet est un site associatif
    // qui ne nous doit rien, et une pause qui ne sert plus à rien fait attendre l'appelant.
    if (!premier && delai > 0) await new Promise((r) => setTimeout(r, delai));
    premier = false;

    try {
      const roster = await fetchTeamRoster(snTeamId);
      const data = {
        name: roster.teamName,
        club: roster.club,
        code: roster.code,
        rosterJson: JSON.stringify(roster),
        fetchedAt: now,
      };
      await db.squashnetTeamRoster.upsert({
        where: { snTeamId },
        create: { snTeamId, ...data },
        update: data,
      });
      outcomes.push({ snTeamId, status: "fetched", players: roster.players.length });
    } catch (e) {
      // ON NE TOUCHE PAS À LA LIGNE EXISTANTE SUR UN ÉCHEC. Un roster capté la semaine dernière
      // vaut infiniment mieux que rien, et l'écraser par un silence du site ferait disparaître
      // d'un menu des joueurs parfaitement réels — sans qu'aucune erreur ne l'explique.
      outcomes.push({
        snTeamId,
        status: e instanceof RosterUnreadableError ? "unreadable" : "failed",
      });
    }
  }

  return outcomes;
}
