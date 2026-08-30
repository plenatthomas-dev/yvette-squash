// Logique du partage de frais (type Tricount). Tout est en CENTIMES (entiers) :
// les euros n'existent qu'à l'affichage, aucune arithmétique flottante ici.

/** Bornes de saisie : 1 centime à 100 000 € — largement assez pour une asso. */
export const MAX_AMOUNT_CENTS = 10_000_000;
export const MAX_LABEL_LEN = 80;
// Titre d'un tricount. ⚠️ VESTIGE : la colonne `Tricount.title` existe et `/admin/tricounts`
// l'affiche, mais AUCUNE route ne l'écrit et aucun écran membre ne la rend — elle ne peut donc
// valoir que `NULL`. Le commentaire d'origine annonçait « affiché dans l'en-tête de la carte,
// à côté de la date » : cet affichage n'a jamais existé. La borne est conservée pour le jour
// où un titre servira vraiment ; elle n'est plus appliquée nulle part.
export const MAX_TITLE_LEN = 40;
// Commentaire (idée 5a) : un message de fil de discussion attaché à un tricount.
export const MAX_COMMENT_LEN = 500;
// Mode « par parts » : nombre de parts max qu'un participant peut prendre sur une dépense.
export const MAX_PARTS = 99;
// Nom d'un invité hors asso (TricountGuest.name) : même borne que le titre, largement assez
// pour un prénom. Le suffixe "(ext)" n'est JAMAIS stocké : ajouté à l'affichage seulement.
export const MAX_GUEST_NAME_LEN = 40;

/**
 * Un membre et un invité hors asso peuvent tous deux porter une part ou (pour un
 * remboursement) être « payeur ». `computeBalances`/`payersOf`/`settle` restent
 * génériques sur des chaînes : ces deux helpers préfixent l'id réel (User ou
 * TricountGuest) pour obtenir une clé unique dans le même Map, sans jamais les
 * confondre. `toKeyedExpense` fait la conversion une fois pour toutes à partir
 * d'une ligne Prisma (payerId/payerGuestId, shares avec userId/guestId).
 */
export const userKey = (id: string): string => `u:${id}`;
export const guestKey = (id: string): string => `g:${id}`;

export function parseKey(key: string): { kind: "user" | "guest"; id: string } {
  return key.startsWith("g:")
    ? { kind: "guest", id: key.slice(2) }
    : { kind: "user", id: key.slice(2) };
}

export interface ExpenseRowForBalance {
  payerId: string | null;
  payerGuestId: string | null;
  isRefund?: boolean;
  shares: { userId: string | null; guestId: string | null; amountCents: number }[];
}

/** Convertit une ligne Prisma (Expense + shares) en clés unifiées membre/invité. */
export function toKeyedExpense(e: ExpenseRowForBalance): ExpenseForBalance {
  return {
    payerId: e.payerId ? userKey(e.payerId) : guestKey(e.payerGuestId as string),
    isRefund: e.isRefund,
    shares: e.shares.map((s) => ({
      userId: s.userId ? userKey(s.userId) : guestKey(s.guestId as string),
      amountCents: s.amountCents,
    })),
  };
}

/**
 * Répartition égale de `amountCents` entre `n` participants, ajustée au centime :
 * les `amountCents % n` premiers reçoivent un centime de plus, la somme des parts
 * vaut EXACTEMENT le montant (jamais un centime perdu ou inventé).
 */
export function splitEqually(amountCents: number, n: number): number[] {
  const base = Math.floor(amountCents / n);
  const extra = amountCents % n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

/**
 * Répartition égale avec mémoire des arrondis du tricount : les centimes en trop
 * vont d'abord à ceux qui ont le moins « surpayé » jusqu'ici (`credit` = somme de
 * (part attribuée − part exacte) sur les dépenses précédentes). Ainsi les erreurs
 * d'arrondi se compensent d'une dépense à l'autre : 200 € puis 100 € entre 3
 * donnent bien 100 € chacun, et non 100,01 / 100,00 / 99,99.
 * Renvoie les parts dans l'ordre de `ids`.
 */
export function splitWithCredits(
  amountCents: number,
  ids: string[],
  credit: Map<string, number>,
): number[] {
  const n = ids.length;
  const base = Math.floor(amountCents / n);
  let extra = amountCents % n;
  const order = ids
    .map((id, i) => ({ i, id, c: credit.get(id) ?? 0 }))
    .sort((a, b) => a.c - b.c || (a.id < b.id ? -1 : 1));
  const out: number[] = Array(n).fill(base);
  for (const o of order) {
    if (extra <= 0) break;
    out[o.i] = base + 1;
    extra--;
  }
  return out;
}

/** Une dépense telle qu'on la relit pour reconstituer la mémoire des arrondis. */
export interface ExpenseForCredit {
  amountCents: number;
  shares: { userId: string | null; guestId: string | null; amountCents: number }[];
}

/**
 * Construit la mémoire des arrondis d'un tricount : pour chaque participant, la somme de
 * (part attribuée − part exacte) sur les dépenses passées. C'est l'entrée de
 * `splitWithCredits`, qui donne le centime en trop à ceux qui ont le moins surpayé.
 *
 * ⚠️ LES DÉPENSES PONDÉRÉES SONT EXCLUES, et c'est le correctif principal de cette fonction.
 * Le calcul vivait en double dans les deux routes d'écriture, et les deux copies posaient
 * `exact = amountCents / shares.length` — c'est-à-dire qu'elles supposaient TOUTE dépense
 * passée répartie à parts égales. Pour une dépense « par parts », cet écart n'est plus une
 * erreur d'arrondi (moins d'un centime) mais l'écart de PONDÉRATION, qui se chiffre en euros
 * et domine ensuite le tri : 40 € en [2,1,1] produisait un crédit de ±3,33 €, et le centime
 * de la dépense suivante partait chez celui qui avait le plus PETIT poids, au lieu d'aller à
 * celui qui avait le moins surpayé. La conservation des sommes tenait ; la compensation
 * annoncée, non.
 *
 * Une dépense pondérée n'a donc aucune erreur d'arrondi à léguer : elle est ignorée.
 *
 * Comment on la reconnaît : un partage égal ne peut écarter deux parts que d'UN centime (base
 * ou base+1). Au-delà, les poids diffèrent. Le seul cas ambigu est une dépense de quelques
 * centimes, où deux poids distincts tiennent dans un centime d'écart — la méprise y porte
 * alors sur moins d'un centime. La solution exacte serait de STOCKER les poids ; elle coûte
 * une migration et une colonne pour un gain qui s'arrête au centime.
 */
export function roundingCredit(expenses: ExpenseForCredit[]): Map<string, number> {
  const credit = new Map<string, number>();
  for (const e of expenses) {
    if (e.shares.length === 0) continue;
    const parts = e.shares.map((s) => s.amountCents);
    if (Math.max(...parts) - Math.min(...parts) > 1) continue; // pondérée : rien à mémoriser
    const exact = e.amountCents / e.shares.length;
    for (const s of e.shares) {
      const key = s.userId ? userKey(s.userId) : guestKey(s.guestId as string);
      credit.set(key, (credit.get(key) ?? 0) + (s.amountCents - exact));
    }
  }
  return credit;
}

/**
 * Répartition PONDÉRÉE de `amountCents` selon un nombre de parts (poids entier ≥ 1) par
 * participant, `weights` aligné sur `ids`. Méthode du plus grand reste : chacun reçoit
 * floor(montant × poids / total), puis les centimes restants vont aux plus grands restes
 * fractionnaires (départage par index croissant → déterministe). La somme des parts vaut
 * EXACTEMENT le montant. Ex. 40 € avec parts [1, 2, 1] → [10, 20, 10] €.
 * Filet de sécurité : si le total des poids est nul, on retombe sur un partage égal.
 */
export function splitByWeights(
  amountCents: number,
  ids: string[],
  weights: number[],
): number[] {
  const n = ids.length;
  const totalW = weights.reduce((s, w) => s + w, 0);
  if (totalW <= 0) return splitEqually(amountCents, n);
  const exact = weights.map((w) => (amountCents * w) / totalW);
  const out = exact.map((x) => Math.floor(x));
  let remaining = amountCents - out.reduce((s, x) => s + x, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const o of order) {
    if (remaining <= 0) break;
    out[o.i] += 1;
    remaining--;
  }
  return out;
}

export interface ExpenseForBalance {
  payerId: string;
  isRefund?: boolean;
  shares: { userId: string; amountCents: number }[];
}

/**
 * Payeurs d'un tricount = ceux qui ont réglé au moins une VRAIE dépense (pas un
 * remboursement). Ce sont eux qui doivent tous valider avant les remboursements.
 */
export function payersOf(expenses: ExpenseForBalance[]): string[] {
  return [...new Set(expenses.filter((e) => !e.isRefund).map((e) => e.payerId))];
}

/**
 * Solde net par joueur : + ce qu'il a avancé, − ce qu'il doit.
 * Positif = le groupe lui doit de l'argent ; négatif = il doit au groupe.
 * La somme de tous les soldes vaut toujours 0.
 */
export function computeBalances(expenses: ExpenseForBalance[]): Map<string, number> {
  const bal = new Map<string, number>();
  const add = (userId: string, cents: number) =>
    bal.set(userId, (bal.get(userId) ?? 0) + cents);
  for (const e of expenses) {
    for (const s of e.shares) {
      add(e.payerId, s.amountCents);
      add(s.userId, -s.amountCents);
    }
  }
  return bal;
}

export interface Transfer {
  fromId: string;
  toId: string;
  amountCents: number;
}

/**
 * Les remboursements sont-ils OUVERTS ? Vrai quand tous les payeurs ont donné leur « OK ».
 *
 * ⚠️ `payers.length > 0` n'est pas une précaution de style : sans payeur, « tous les payeurs
 * ont validé » serait vrai par vacuité, et les remboursements s'ouvriraient sur un tricount
 * qui n'a rien à rembourser.
 */
export function isReady(payerIds: string[], approvedUserIds: Iterable<string>): boolean {
  const approved = new Set(approvedUserIds);
  return payerIds.length > 0 && payerIds.every((p) => approved.has(p));
}

/**
 * Le tricount est-il SOLDÉ ? Remboursements ouverts, et plus aucun virement à faire.
 *
 * Cette règle vivait uniquement dans la route de liste, donc uniquement dans l'AFFICHAGE :
 * l'écran masquait « Modifier » et « Suppr. » sur un tricount soldé, mais ni `PATCH` ni
 * `DELETE` ne consultaient cet état. Un appel direct rouvrait donc un tricount clos —
 * recalcul des parts, validations effacées — un état que l'interface présentait comme
 * impossible. Une règle que seul le client applique n'est pas une règle.
 */
export function isSettled(
  expenses: ExpenseRowForBalance[],
  approvedUserIds: Iterable<string>,
): boolean {
  const keyed = expenses.map(toKeyedExpense);
  const payers = payersOf(keyed).map((k) => parseKey(k).id);
  if (!isReady(payers, approvedUserIds)) return false;
  return settle(computeBalances(keyed)).length === 0;
}

/**
 * Suggestion de remboursements « qui rend combien à qui » : glouton, le plus gros
 * débiteur paie le plus gros créancier jusqu'à épuisement. Au plus n−1 virements.
 * Tri secondaire par id pour un résultat déterministe entre deux appels.
 */
export function settle(balances: Map<string, number>): Transfer[] {
  const creditors = [...balances].filter(([, c]) => c > 0);
  const debtors = [...balances].filter(([, c]) => c < 0);
  const byAmount = (a: [string, number], b: [string, number]) =>
    Math.abs(b[1]) - Math.abs(a[1]) || (a[0] < b[0] ? -1 : 1);
  creditors.sort(byAmount);
  debtors.sort(byAmount);

  const out: Transfer[] = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const owe = -debtors[i][1];
    const due = creditors[j][1];
    const pay = Math.min(owe, due);
    out.push({ fromId: debtors[i][0], toId: creditors[j][0], amountCents: pay });
    debtors[i][1] += pay;
    creditors[j][1] -= pay;
    if (debtors[i][1] === 0) i++;
    if (creditors[j][1] === 0) j++;
  }
  return out;
}
