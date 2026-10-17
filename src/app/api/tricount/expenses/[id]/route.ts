import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { isAdminEmail } from "@/lib/admin";
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
import { HttpError, httpErrorResponse, readJsonBody, serializableTransaction } from "@/lib/http-tx";
import { blockEmailOnlyExpenseWrite, refuseSiSolde } from "@/lib/tricount-guard";
import { lierJoueurs, lireIdsJoueurs } from "@/lib/tricount-club";

export const runtime = "nodejs";


// DELETE /api/tricount/expenses/{id} -> supprime une dépense (ou un remboursement).
// Autorisé seulement à celui qui l'a saisie, au payeur ou à un admin — et, pour un
// REMBOURSEMENT, aussi à son bénéficiaire (cf. plus bas). Supprimer une vraie dépense remet à
// zéro les validations du tricount ; supprimer la dernière vraie dépense supprime le tricount
// lui-même (plus de coquille vide dans l'historique), sauf s'il porte des remboursements.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await getFeatures()).tricount) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const { id } = await params;
  const expense = await prisma.expense.findUnique({
    where: { id },
    select: {
      tricountId: true,
      isRefund: true,
      creatorId: true,
      payerId: true,
      shares: { select: { userId: true } },
    },
  });
  // LE BÉNÉFICIAIRE D'UN REMBOURSEMENT PEUT LE RETIRER. Un remboursement est déclaré par celui
  // qui paie : créateur = payeur = débiteur (ou un membre pour le compte d'un invité payeur).
  // Le bénéficiaire, lui, n'en porte que l'UNIQUE part. Sans cette clause, un « j'ai remboursé »
  // jamais suivi d'un virement ne pouvait être retiré que par son auteur — celui-là même qui
  // s'est trompé, ou qui ment — et le bénéficiaire voyait sa créance effacée sans recours
  // qu'un admin. Même règle que le `canDelete` du GET (api/tricount/route.ts) : les deux
  // doivent dire la même chose, sans quoi l'écran proposerait un bouton qui rend 404.
  if (
    !expense ||
    (expense.creatorId !== session.userId &&
      expense.payerId !== session.userId &&
      !isAdminEmail(session.email) &&
      !(
        expense.isRefund &&
        expense.shares.length === 1 &&
        expense.shares[0].userId === session.userId
      ))
  ) {
    return NextResponse.json({ error: "Dépense introuvable ou non autorisée" }, { status: 404 });
  }
  // Le garde « email seul » ne vaut que pour les vraies DÉPENSES. Un remboursement, ces comptes
  // ont le droit de le déclarer (cf. tricount-guard + route refunds) : leur interdire de le
  // supprimer les enfermait dans leur erreur, d'autant que PATCH renvoie « un remboursement ne se
  // modifie pas, supprime-le et refais-le » — une consigne qu'ils ne pouvaient pas suivre.
  // L'ownership est déjà vérifié ci-dessus : on ne peut défaire que SON propre remboursement,
  // celui dont on est bénéficiaire (ou n'importe lequel pour un admin).
  //
  // ⚠️ `refuseSiSolde` lit HORS de la transaction ci-dessous (comme en création et en
  // édition) : il relit via le client global de `lib/tricount-guard.ts`, qui n'accepte pas de
  // client de transaction. Fenêtre étroite — un remboursement qui solde le tricount entre ce
  // contrôle et l'écriture — mais réelle ; la fermer demande de faire accepter `tx` au garde.
  if (!expense.isRefund) {
    const blocked = blockEmailOnlyExpenseWrite(session);
    if (blocked) return blocked;
    const clos = await refuseSiSolde({ id: expense.tricountId });
    if (clos) return clos;
  }

  // ⚠️ SERIALIZABLE, comme la création et l'édition, et pour la même raison : supprimer une
  // vraie dépense remet les validations à zéro, et SSI ne protège qu'ENTRE transactions
  // sérialisables. En Read Committed, une validation concurrente (`approve`, elle sérialisable)
  // pouvait survivre au `deleteMany` : le tricount redevenait « prêt » avec un payeur qui
  // n'avait pas vu disparaître la dépense. Le corps est rejouable tel quel — il n'écrit qu'en
  // base, et un rejeu repart d'une transaction annulée.
  try {
    await serializableTransaction(async (tx) => {
      await tx.expense.delete({ where: { id } });
      if (!expense.isRefund) {
        await tx.tricountApproval.deleteMany({ where: { tricountId: expense.tricountId, user: { disabledAt: null } } });
      }
      // ⚠️ ON NE COMPTE QUE LES VRAIES DÉPENSES, jamais les remboursements.
      //
      // Compter toutes les lignes laissait survivre un tricount qui n'en portait plus que des
      // remboursements — et un tel tricount est un piège sans issue. Il n'a plus aucun payeur,
      // donc `ready` est faux à jamais : `approve` répond 403 (« seuls les payeurs valident »,
      // la liste est vide) et `refunds` 409 (« tous les payeurs doivent d'abord valider »).
      // Pire, les soldes s'INVERSENT : la seule ligne restante est un remboursement, celui qui
      // l'a versé apparaît créancier et son bénéficiaire débiteur. A voyait « tu dois 15,00 € »
      // pour de l'argent qu'il avait déjà reçu, sans aucun moyen d'en sortir.
      //
      // Sans vraie dépense, le tricount n'a plus d'objet : il tombe.
      const remaining = await tx.expense.count({
        where: { tricountId: expense.tricountId, isRefund: false },
      });
      if (remaining === 0) {
        // … MAIS PAS EN EMPORTANT DES REMBOURSEMENTS. Ce sont des mouvements d'argent RÉELS :
        // les laisser partir en cascade (`onDelete: Cascade`) effaçait sans un mot la trace
        // d'un virement fait. On refuse, et l'`HttpError` annule la suppression ci-dessus avec
        // le reste de la transaction : rien n'a bougé.
        const remboursements = await tx.expense.count({
          where: { tricountId: expense.tricountId, isRefund: true },
        });
        if (remboursements > 0) {
          throw new HttpError(
            409,
            "Ce tricount porte des remboursements : modifie la dépense plutôt que de la supprimer, ou retire d'abord les remboursements.",
          );
        }
        await tx.tricount.delete({ where: { id: expense.tricountId } });
      }
    }, "Écriture concurrente sur ce tricount, réessaie");
  } catch (e) {
    const res = httpErrorResponse(e);
    if (res) return res;
    throw e;
  }
  return NextResponse.json({ ok: true });
}

// PATCH /api/tricount/expenses/{id} -> modifie une VRAIE dépense (jamais un
// remboursement). { label, amountCents, payerId, participantIds, guestIds?, clubGuestIds?, weights?, preserveSplit? }.
// clubGuestIds : joueurs du club sans compte, comme à la création (cf. `lib/tricount-club.ts`).
// Même droit que la suppression (celui qui a saisi la ligne, le payeur ou un admin). La date
// (donc le tricount) ne change pas ici. Les parts sont recalculées et les
// validations « OK pour rembourser » remises à zéro (les montants ont bougé).
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const features = await getFeatures();
  if (!features.tricount) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const blocked = blockEmailOnlyExpenseWrite(session);
  if (blocked) return blocked;
  const { id } = await params;

  const existingExpense = await prisma.expense.findUnique({
    where: { id },
    select: { tricountId: true, isRefund: true, creatorId: true, payerId: true },
  });
  if (
    !existingExpense ||
    (existingExpense.creatorId !== session.userId &&
      existingExpense.payerId !== session.userId &&
      !isAdminEmail(session.email))
  ) {
    return NextResponse.json({ error: "Dépense introuvable ou non autorisée" }, { status: 404 });
  }
  if (existingExpense.isRefund) {
    return NextResponse.json(
      { error: "Un remboursement ne se modifie pas (supprime-le et refais-le)" },
      { status: 400 },
    );
  }
  const clos = await refuseSiSolde({ id: existingExpense.tricountId });
  if (clos) return clos;

  const body = await readJsonBody(req);
  const { label, amountCents, payerId, participantIds, guestIds, clubGuestIds, weights } = body as {
    label?: unknown;
    amountCents?: unknown;
    payerId?: unknown;
    participantIds?: unknown;
    guestIds?: unknown;
    clubGuestIds?: unknown;
    weights?: unknown;
  };

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
  // Invités hors asso (TricountGuest.id) : jamais payeur, seulement une part.
  const uniqueGuestIds = [...new Set(guestsRaw as string[])];
  // Joueurs du club sans compte (InterclubGuest.id) : comme à la création.
  const uniqueClubIds = lireIdsJoueurs(clubGuestIds);
  if (uniqueClubIds === null) {
    return NextResponse.json({ error: "Participants invalides" }, { status: 400 });
  }
  if (uniqueIds.length + uniqueGuestIds.length + uniqueClubIds.length === 0) {
    return NextResponse.json({ error: "Participants invalides" }, { status: 400 });
  }
  if (uniqueClubIds.length > 0 && !features.interclub) {
    return NextResponse.json({ error: "Joueur inconnu" }, { status: 400 });
  }
  if (typeof payerId !== "string" || payerId.length === 0) {
    return NextResponse.json({ error: "Payeur invalide" }, { status: 400 });
  }

  // Ordre des parts (`weights`, keyées par l'id envoyé) — comme à la création.
  const rawIdsInOrder = [...uniqueIds, ...uniqueGuestIds, ...uniqueClubIds];

  // Parts optionnelles (mode « par parts ») : identique à la création.
  let weightArr: number[] | null = null;
  if (weights !== undefined && weights !== null) {
    if (typeof weights !== "object" || Array.isArray(weights)) {
      return NextResponse.json({ error: "Parts invalides" }, { status: 400 });
    }
    const w = weights as Record<string, unknown>;
    weightArr = rawIdsInOrder.map((uid) => (typeof w[uid] === "number" ? (w[uid] as number) : NaN));
    if (weightArr.some((n) => !Number.isInteger(n) || n < 1 || n > MAX_PARTS)) {
      return NextResponse.json(
        { error: `Parts invalides (entier de 1 à ${MAX_PARTS} par participant)` },
        { status: 400 },
      );
    }
  }

  // Payeur + participants doivent être des membres connus, et le PAYEUR doit être actif —
  // comme à la création, et pour la même raison : un compte désactivé ne validera jamais, et
  // `isReady` l'attendrait indéfiniment. Les participants désactivés restent acceptés, sans
  // quoi une dépense ancienne deviendrait incorrigible dès qu'un joueur quitte le club.
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
  // Les invités doivent appartenir à CE tricount (comme à la création).
  if (uniqueGuestIds.length > 0) {
    const knownGuests = await prisma.tricountGuest.findMany({
      where: { id: { in: uniqueGuestIds }, tricountId: existingExpense.tricountId },
      select: { id: true },
    });
    const knownGuestIds = new Set(knownGuests.map((g) => g.id));
    if (uniqueGuestIds.some((g) => !knownGuestIds.has(g))) {
      return NextResponse.json({ error: "Invité inconnu" }, { status: 400 });
    }
  }

  // Chaque joueur sans compte retrouve (ou reçoit) son invité sur CE tricount — le même qu'à la
  // création : `preserveSplit` compare les clés enregistrées à celles-ci.
  let lien: Map<string, string>;
  try {
    lien = await lierJoueurs(existingExpense.tricountId, uniqueClubIds);
  } catch (e) {
    const res = httpErrorResponse(e);
    if (res) return res;
    throw e;
  }
  const guestIdsFinal = [...uniqueGuestIds, ...uniqueClubIds.map((cid) => lien.get(cid) as string)];
  if (new Set(guestIdsFinal).size !== guestIdsFinal.length) {
    return NextResponse.json({ error: "Participants invalides" }, { status: 400 });
  }
  // Membres puis invités, chacun préfixé (u:/g:) — comme à la création.
  const shareIds = [...uniqueIds, ...guestIdsFinal];
  const allKeys = [...uniqueIds.map(userKey), ...guestIdsFinal.map(guestKey)];

  // Mémoire des arrondis : calculée sur les AUTRES vraies dépenses du tricount
  // (on exclut la ligne éditée pour ne pas se compenser avec son ancienne valeur).
  const others = await prisma.expense.findMany({
    where: { tricountId: existingExpense.tricountId, isRefund: false, id: { not: id } },
    select: {
      amountCents: true,
      shares: { select: { userId: true, guestId: true, amountCents: true } },
    },
  });
  const credit = roundingCredit(others);
  const parts = weightArr
    ? splitByWeights(amountCents, allKeys, weightArr)
    : splitWithCredits(amountCents, allKeys, credit);

  // ⚠️ SERIALIZABLE, pour la même raison que la route de création : SSI ne protège qu'entre
  // transactions sérialisables. En Read Committed, une validation concurrente pouvait survivre
  // au `deleteMany` qui remet les validations à zéro, et le tricount redevenait « prêt » avec
  // un payeur qui n'avait pas vu les nouveaux montants.
  try {
    await serializableTransaction(async (tx) => {
      // Retouche qui ne touche ni au montant ni aux participants : on REJOUE les centimes
      // enregistrés, arrondis compris, au lieu de rendre une répartition à parts égales que
      // personne n'a demandée.
      if (body.preserveSplit === true) {
        const current = await tx.expense.findUnique({
          where: { id }, select: { amountCents: true, shares: true },
        });
        const saved = new Map(current?.shares.map((share) => [
          share.userId ? userKey(share.userId) : guestKey(share.guestId!), share.amountCents,
        ]));
        if (!current || current.amountCents !== amountCents || saved.size !== allKeys.length ||
            allKeys.some((key) => !saved.has(key))) {
          throw new HttpError(409, "La répartition a changé : choisis une nouvelle répartition.");
        }
        allKeys.forEach((key, i) => { parts[i] = saved.get(key)!; });
      }
      // Remplace intégralement les parts (participants et montants peuvent changer).
      await tx.expenseShare.deleteMany({ where: { expenseId: id } });
      await tx.expense.update({
        where: { id },
        data: {
          label: cleanLabel,
          amountCents,
          payerId,
          shares: {
            create: shareIds.map((pid, i) =>
              i < uniqueIds.length
                ? { userId: pid, amountCents: parts[i] }
                : { guestId: pid, amountCents: parts[i] },
            ),
          },
        },
      });
      // Les payeurs actifs revalident ; la validation automatique des comptes désactivés reste acquise.
      await tx.tricountApproval.deleteMany({ where: { tricountId: existingExpense.tricountId, user: { disabledAt: null } } });
    }, "Écriture concurrente sur ce tricount, réessaie");
  } catch (e) {
    const res = httpErrorResponse(e);
    if (res) return res;
    throw e;
  }
  return NextResponse.json({ ok: true, tricountId: existingExpense.tricountId });
}
