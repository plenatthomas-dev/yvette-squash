import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import {
  splitWithCredits,
  splitByWeights,
  roundingCredit,
  userKey,
  guestKey,
  MAX_AMOUNT_CENTS,
  MAX_LABEL_LEN,
  MAX_PARTS,
} from "@/lib/tricount";
import { getFeatures } from "@/lib/features-server";
import { httpErrorResponse, readJsonBody, serializableTransaction } from "@/lib/http-tx";
import { blockEmailOnlyExpenseWrite, refuseSiSolde } from "@/lib/tricount-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/tricount/expenses -> ajoute une dépense au tricount du jour choisi.
// { date: "YYYY-MM-DD", label, amountCents, payerId, participantIds, guestIds?, weights? }
// guestIds référence des TricountGuest déjà créés sur CE tricount (invités hors
// asso, cf. POST /api/tricount/guests) : ils peuvent porter une part, jamais être
// payeur. Le tricount de cette date est créé s'il n'existe pas. Toute modification
// des dépenses remet à zéro les validations « OK pour rembourser » du tricount.
//
// ⚠️ CETTE ROUTE N'ÉCRIT PLUS `Tricount.title`, et le champ n'est plus accepté. Il était
// validé, borné et stocké — mais aucun écran ne l'envoyait, aucun ne l'affichait, et aucune
// autre route ne sait l'écrire : la colonne ne pouvait donc être que `NULL`. Rester à
// valider un champ mort donne à lire une fonctionnalité qui n'existe pas. La colonne, elle,
// survit : `/admin/tricounts` la lit, et la retirer coûterait une migration pour rien.
// Le jour où un titre servira, il faudra l'écrire ici ET l'afficher — les deux, ou aucun.
export async function POST(req: NextRequest) {
  if (!(await getFeatures()).tricount) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const blocked = blockEmailOnlyExpenseWrite(session);
  if (blocked) return blocked;

  const body = await readJsonBody(req);
  const { date, label, amountCents, payerId, participantIds, guestIds, weights } =
    body as {
      date?: unknown;
      label?: unknown;
      amountCents?: unknown;
      payerId?: unknown;
      participantIds?: unknown;
      guestIds?: unknown;
      weights?: unknown;
    };

  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "Date invalide" }, { status: 400 });
  }
  const cleanLabel = typeof label === "string" ? label.trim() : "";
  if (cleanLabel.length === 0 || cleanLabel.length > MAX_LABEL_LEN) {
    return NextResponse.json({ error: "Libellé invalide (1 à 80 caractères)" }, { status: 400 });
  }
  if (
    typeof amountCents !== "number" ||
    !Number.isInteger(amountCents) ||
    amountCents <= 0 ||
    amountCents > MAX_AMOUNT_CENTS
  ) {
    return NextResponse.json({ error: "Montant invalide" }, { status: 400 });
  }
  const participantsRaw = participantIds === undefined ? [] : participantIds;
  const guestsRaw = guestIds === undefined ? [] : guestIds;
  if (
    !Array.isArray(participantsRaw) ||
    !participantsRaw.every((p) => typeof p === "string") ||
    !Array.isArray(guestsRaw) ||
    !guestsRaw.every((g) => typeof g === "string")
  ) {
    return NextResponse.json({ error: "Participants invalides" }, { status: 400 });
  }
  const uniqueIds = [...new Set(participantsRaw as string[])];
  // Invités hors asso (TricountGuest.id) : jamais payeur, seulement une part (cf. guestIds).
  const uniqueGuestIds = [...new Set(guestsRaw as string[])];
  if (uniqueIds.length + uniqueGuestIds.length === 0) {
    return NextResponse.json({ error: "Participants invalides" }, { status: 400 });
  }
  if (typeof payerId !== "string" || payerId.length === 0) {
    return NextResponse.json({ error: "Payeur invalide" }, { status: 400 });
  }

  // Ordre commun membres puis invités, chacun préfixé (u:/g:) pour ne jamais les
  // confondre dans la répartition/la mémoire des arrondis (toutes deux génériques
  // sur des clés string).
  const rawIdsInOrder = [...uniqueIds, ...uniqueGuestIds];
  const allKeys = [...uniqueIds.map(userKey), ...uniqueGuestIds.map(guestKey)];

  // Parts optionnelles (mode « par parts ») : un poids entier ≥ 1 par participant
  // (membre ou invité, keyé par son id brut côté payload). Absent → partage égal
  // (comportement historique). Présent → chaque participant doit avoir un poids
  // valide, sinon on refuse (pas de partage silencieusement faux).
  let weightArr: number[] | null = null;
  if (weights !== undefined && weights !== null) {
    if (typeof weights !== "object" || Array.isArray(weights)) {
      return NextResponse.json({ error: "Parts invalides" }, { status: 400 });
    }
    const w = weights as Record<string, unknown>;
    weightArr = rawIdsInOrder.map((id) => (typeof w[id] === "number" ? (w[id] as number) : NaN));
    if (
      weightArr.some(
        (n) => !Number.isInteger(n) || n < 1 || n > MAX_PARTS,
      )
    ) {
      return NextResponse.json(
        { error: `Parts invalides (entier de 1 à ${MAX_PARTS} par participant)` },
        { status: 400 },
      );
    }
  }

  // Payeur + participants doivent être des membres connus (l'IHM liste les mêmes).
  //
  // ⚠️ LE PAYEUR, LUI, DOIT AUSSI ÊTRE ACTIF, et cette moitié-là n'existait que dans le
  // sélecteur. Un compte désactivé ne peut plus se connecter, donc plus jamais valider — et
  // `isReady` exige la validation de TOUS les payeurs. L'aligner comme payeur créait un
  // tricount que personne ne pouvait plus ouvrir. Les PARTICIPANTS, eux, restent acceptés
  // désactivés : porter une part n'engage aucune action de leur part, et refuser bloquerait
  // la correction d'une dépense ancienne dont un participant a quitté le club depuis.
  const known = await prisma.user.findMany({
    where: { id: { in: [payerId, ...uniqueIds] } },
    select: { id: true, disabledAt: true },
  });
  const knownIds = new Set(known.map((u) => u.id));
  if (!knownIds.has(payerId) || uniqueIds.some((p) => !knownIds.has(p))) {
    return NextResponse.json({ error: "Membre inconnu" }, { status: 400 });
  }
  if (known.find((u) => u.id === payerId)?.disabledAt) {
    return NextResponse.json(
      { error: "Ce compte est désactivé : il ne peut pas être le payeur d'une dépense." },
      { status: 400 },
    );
  }
  // Les invités doivent déjà exister sur LE TRICOUNT de cette date (créés via
  // POST /api/tricount/guests) — un invité n'est jamais deviné à la volée ici.
  if (uniqueGuestIds.length > 0) {
    const knownGuests = await prisma.tricountGuest.findMany({
      where: { id: { in: uniqueGuestIds }, tricount: { date } },
      select: { id: true },
    });
    const knownGuestIds = new Set(knownGuests.map((g) => g.id));
    if (uniqueGuestIds.some((g) => !knownGuestIds.has(g))) {
      return NextResponse.json({ error: "Invité inconnu" }, { status: 400 });
    }
  }

  // Un tricount SOLDÉ ne se rouvre pas par la porte de derrière. Sans ce contrôle, la règle
  // appliquée à l'édition et à la suppression se contournait en trois clics : ajouter une
  // dépense à un tricount clos remet toutes les validations à zéro, donc le rouvre.
  const clos = await refuseSiSolde({ date });
  if (clos) return clos;

  const tricount = await prisma.tricount.upsert({
    where: { date },
    update: {},
    create: { date },
  });
  // Mémoire des arrondis du tricount : qui a déjà « surpayé » d'un centime ? La règle vit
  // dans `roundingCredit` (elle était recopiée ici et dans la route sœur `PATCH`, et les deux
  // copies faussaient le crédit dès qu'une dépense pondérée traînait dans l'historique).
  const existing = await prisma.expense.findMany({
    where: { tricountId: tricount.id, isRefund: false },
    select: {
      amountCents: true,
      shares: { select: { userId: true, guestId: true, amountCents: true } },
    },
  });
  const credit = roundingCredit(existing);
  // Mode « parts » → répartition pondérée ; sinon partage égal avec mémoire des arrondis.
  const parts = weightArr
    ? splitByWeights(amountCents, allKeys, weightArr)
    : splitWithCredits(amountCents, allKeys, credit);
  // ⚠️ SERIALIZABLE, comme `approve` et `refunds` — et pas par symétrie de style.
  //
  // Cette écriture faisait un `$transaction([…])` ordinaire, donc en Read Committed. Or SSI ne
  // garantit la sérialisabilité qu'ENTRE transactions sérialisables : une validation concurrente
  // (`approve`, elle sérialisable) pouvait s'insérer pendant que ce `deleteMany` effaçait les
  // validations, et survivre à la remise à zéro. Le tricount redevenait alors « prêt » avec un
  // payeur qui n'avait jamais vu les nouveaux montants. Aligner les niveaux d'isolation ferme la
  // question au lieu de la mesurer.
  //
  // Le corps est rejouable tel quel : il n'écrit qu'en base, et un rejeu part d'une transaction
  // annulée — aucune dépense en double.
  let expense: { id: string };
  try {
    expense = await serializableTransaction(async (tx) => {
      const cree = await tx.expense.create({
        data: {
          tricountId: tricount.id,
          payerId,
          creatorId: session.userId,
          label: cleanLabel,
          amountCents,
          spentAt: new Date(`${date}T12:00:00`),
          shares: {
            create: rawIdsInOrder.map((id, i) =>
              i < uniqueIds.length
                ? { userId: id, amountCents: parts[i] }
                : { guestId: id, amountCents: parts[i] },
            ),
          },
        },
      });
      // Les montants ont changé : chaque payeur devra re-valider avant remboursements.
      await tx.tricountApproval.deleteMany({ where: { tricountId: tricount.id } });
      return cree;
    }, "Écriture concurrente sur ce tricount, réessaie");
  } catch (e) {
    const res = httpErrorResponse(e);
    if (res) return res;
    throw e;
  }
  return NextResponse.json({ id: expense.id, tricountId: tricount.id }, { status: 201 });
}
