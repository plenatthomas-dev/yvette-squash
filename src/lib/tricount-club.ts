import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { HttpError } from "@/lib/http-tx";
import { nameKey } from "@/lib/squashnet/roster";

// LES JOUEURS DU CLUB SANS COMPTE, DANS LE PARTAGE DE FRAIS.
//
// Un joueur d'équipe interclub qui n'a pas l'appli (`InterclubGuest`) est proposé dans
// « Pour qui ? », NON COCHÉ par défaut. Les membres, eux, le sont : on décoche les absents.
// Faire de même ici donnerait, au premier oubli, une dette à quelqu'un qui ne la voit pas et ne
// peut pas la contester — il n'a pas de compte.
//
// Sur un tricount, il est porté par `TricountGuest`, la table des invités hors asso, dont il
// partage toutes les règles : il porte une part, n'est jamais payeur d'une vraie dépense, et
// c'est son CRÉANCIER qui confirme son remboursement (« J'ai reçu de… »). Le lien
// `interclubGuestId` dit seulement qui il est : son vrai nom s'affiche sans « (ext) », la même
// personne est reconnue d'une date à l'autre, et la fusion admin fait passer ses dettes sur le
// compte qu'il finit par créer (`transfererAuMembre`).

/** Ce que l'écran propose : l'identifiant du JOUEUR (`InterclubGuest.id`) et son nom. */
export interface JoueurSansCompte {
  id: string;
  name: string;
}

/**
 * Les joueurs sans compte à proposer, une fois chacun, et jamais en double d'un membre.
 *
 * ⚠️ LE DOUBLON MEMBRE / INVITÉ EST LE CYCLE NORMAL (cf. `doublonsAppli`) : un joueur inscrit
 * sans compte ouvre un jour l'appli, et reste invité tant qu'un admin n'a pas fusionné les deux.
 * Le proposer deux fois — coché comme membre, décoché comme joueur sans compte — ferait choisir
 * entre deux lignes pour la même personne. Le membre l'emporte : c'est lui qui peut valider.
 * Même clé de nom que la composition (`nameKey`) ; un joueur inscrit dans deux équipes ne
 * compte qu'une fois.
 */
export async function joueursSansCompte(nomsDesMembres: readonly string[]): Promise<JoueurSansCompte[]> {
  const pris = new Set(nomsDesMembres.map(nameKey).filter(Boolean));
  const joueurs = await prisma.interclubGuest.findMany({
    select: { id: true, name: true },
    orderBy: [{ name: "asc" }, { createdAt: "asc" }],
  });
  const out: JoueurSansCompte[] = [];
  for (const j of joueurs) {
    const cle = nameKey(j.name);
    if (cle && pris.has(cle)) continue;
    if (cle) pris.add(cle);
    out.push({ id: j.id, name: j.name });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "fr", { sensitivity: "base" }));
}

/** `clubGuestIds` du corps de requête : absent → aucun ; sinon un tableau de chaînes, dédoublonné. */
export function lireIdsJoueurs(raw: unknown): string[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || !raw.every((x) => typeof x === "string")) return null;
  return [...new Set(raw as string[])];
}

/**
 * Le `TricountGuest` de chaque joueur sur CE tricount, créé au besoin. Rend
 * `InterclubGuest.id → TricountGuest.id`, dans l'ordre demandé.
 *
 * Créé ici, au moment d'enregistrer la dépense, et non quand on coche la case : la date du
 * formulaire peut encore changer après coup, et un identifiant d'invité ne vaut que pour un jour.
 *
 * ⚠️ UN INVITÉ « (ext) » DU MÊME NOM, SUR LE MÊME TRICOUNT, EST ADOPTÉ plutôt que doublé. C'est la
 * même soirée et le même nom : avant que les joueurs sans compte soient proposés, c'est ainsi
 * qu'on les saisissait. En créer un second buterait de toute façon sur `(tricountId, name)`.
 */
export async function lierJoueurs(tricountId: string, ids: readonly string[]): Promise<Map<string, string>> {
  const lien = new Map<string, string>();
  if (ids.length === 0) return lien;

  const joueurs = await prisma.interclubGuest.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, name: true },
  });
  if (joueurs.length !== ids.length) throw new HttpError(400, "Joueur inconnu");

  const relire = async () => {
    const lies = await prisma.tricountGuest.findMany({
      where: { tricountId, interclubGuestId: { in: [...ids] } },
      select: { id: true, interclubGuestId: true },
    });
    for (const g of lies) lien.set(g.interclubGuestId as string, g.id);
  };
  await relire();

  const manquants = joueurs.filter((j) => !lien.has(j.id));
  if (manquants.length > 0) {
    for (const j of manquants) {
      await prisma.tricountGuest.updateMany({
        where: { tricountId, name: j.name, interclubGuestId: null },
        data: { interclubGuestId: j.id },
      });
    }
    // `skipDuplicates` : deux enregistrements simultanés créent la même ligne une seule fois,
    // et la relecture ci-dessous rend la ligne gagnante aux deux.
    await prisma.tricountGuest.createMany({
      data: manquants.map((j) => ({ tricountId, name: j.name, interclubGuestId: j.id })),
      skipDuplicates: true,
    });
    await relire();
  }

  // Encore absent : son nom est déjà porté sur ce tricount par un AUTRE joueur sans compte — deux
  // homonymes dans deux équipes. On ne devine pas lequel paie.
  const orphelin = joueurs.find((j) => !lien.has(j.id));
  if (orphelin) {
    throw new HttpError(409, `« ${orphelin.name} » figure déjà sous ce nom sur ce tricount.`);
  }
  return new Map(ids.map((id) => [id, lien.get(id) as string]));
}

/**
 * La fusion admin d'un joueur dans le membre qu'il est devenu, côté argent : ses parts et ses
 * remboursements passent sur le membre, qui peut désormais voir sa dette et la déclarer
 * lui-même. Rend le nombre de lignes déplacées.
 *
 * Une part du membre sur la MÊME dépense (il y figurait déjà, sous son compte) reçoit le montant
 * de l'invité au lieu d'en doubler la ligne : `(expenseId, userId)` est unique, et la somme des
 * parts doit rester celle de la dépense.
 *
 * ⚠️ LES LIGNES `TricountGuest` VIDÉES SONT SUPPRIMÉES, MAIS SEULEMENT SI ELLES SONT VIDES. Leur
 * suppression emporte en cascade les parts et les remboursements qui y pendent encore : une
 * dépense enregistrée au même instant, sur le même invité, disparaîtrait sinon en silence.
 */
export async function transfererAuMembre(
  tx: Prisma.TransactionClient,
  interclubGuestId: string,
  userId: string,
): Promise<number> {
  const invites = await tx.tricountGuest.findMany({ where: { interclubGuestId }, select: { id: true } });
  const ids = invites.map((g) => g.id);
  if (ids.length === 0) return 0;

  const parts = await tx.expenseShare.findMany({
    where: { guestId: { in: ids } },
    select: { id: true, expenseId: true, amountCents: true },
  });
  const dejaLa = new Map(
    (
      await tx.expenseShare.findMany({
        where: { userId, expenseId: { in: parts.map((p) => p.expenseId) } },
        select: { id: true, expenseId: true },
      })
    ).map((s) => [s.expenseId, s.id]),
  );
  for (const p of parts) {
    const sienne = dejaLa.get(p.expenseId);
    if (sienne) {
      await tx.expenseShare.update({
        where: { id: sienne },
        data: { amountCents: { increment: p.amountCents } },
      });
      await tx.expenseShare.delete({ where: { id: p.id } });
    } else {
      await tx.expenseShare.update({ where: { id: p.id }, data: { guestId: null, userId } });
    }
  }
  const { count: rembourses } = await tx.expense.updateMany({
    where: { payerGuestId: { in: ids } },
    data: { payerGuestId: null, payerId: userId },
  });
  await tx.tricountGuest.deleteMany({
    where: { id: { in: ids }, shares: { none: {} }, refundsPaid: { none: {} } },
  });
  return parts.length + rembourses;
}
