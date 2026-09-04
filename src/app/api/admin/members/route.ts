import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin, isAdminEmail } from "@/lib/admin";
import { listMembers, deleteBlockersFor } from "@/lib/members";
import { getFeatures } from "@/lib/features-server";
import { interclubDisabledResponse } from "@/lib/interclub-access";
import { parseClassementInput, parseRangMInput } from "@/lib/interclub-order";
import { refreshMemberRanking } from "@/lib/squashnet/refresh";
import { createEmailToken, authLinkFor, clientIp } from "@/lib/email-auth";
import { alertsChanged } from "@/lib/alerts-gate";
import { approveAsDisabledPayer } from "@/lib/tricount-summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/members — liste de tous les comptes (gestion des membres, étape 1).
export async function GET(req: NextRequest) {
  if (!(await requireAdmin(req))) {
    return NextResponse.json({ error: "Accès réservé" }, { status: 403 });
  }
  // `externalDetection` accompagne la liste : sans le flag, les compteurs « sur ResaMania »
  // valent 0 par construction et l'UI doit le dire au lieu de laisser lire « aucune ».
  const [members, features] = await Promise.all([listMembers(), getFeatures()]);
  // Les équipes accompagnent la liste pour que chaque carte propose son sélecteur. Requête
  // faite seulement si l'interclub est actif : inutile de réveiller la table sinon.
  const teams = features.interclub
    ? await prisma.interclubTeam.findMany({
        orderBy: { order: "asc" },
        select: { id: true, name: true },
      })
    : [];
  return NextResponse.json({
    members,
    teams,
    externalDetection: features.externalBookings,
  });
}

/** Longueur maximale d'un nom de recherche squashnet. Borne de saisie, pas une règle métier. */
const MAX_SQUASHNET_NAME_LEN = 60;

// POST /api/admin/members  { id, action }
//   link            → régénère un lien d'accès à transmettre (activation si sans mot de passe,
//                     sinon réinitialisation) ; mène à /reinitialiser où la personne choisit son mdp ;
//   disable         → désactive le compte (connexion refusée) + révoque ses sessions ;
//   enable          → réactive le compte ;
//   revoke_passkey  → retire UN passkey précis du membre (body.passkeyId ; ex. un appareil perdu
//                     parmi plusieurs). Recouvrable → non « sensible ».
//   revoke_passkeys → retire TOUS les passkeys du membre d'un coup ; il pourra en ré-enrôler
//                     depuis ses Réglages. Recouvrable → non « sensible ».
//   delete          → suppression définitive, refusée si le membre porte un historique bloquant.
//   set_team        → rattache le membre à une équipe interclub (body.teamId, null = aucune).
//                     Décision d'ADMIN et non réglage personnel : l'appartenance à une équipe
//                     décide qui peut être aligné dans une rencontre.
//   set_clt_override → force le classement fédéral ET le rang mixte de ce membre pour l'ordre
//                     des simples interclub (body.clt, ex. "5B" ; body.rangM, ex. 2339 ; vides =
//                     retire la correction). Sert quand le rapprochement squashnet a échoué ou
//                     s'est trompé — nom mal orthographié côté ResaMania, licence pas encore
//                     rapprochée… Les DEUX ensemble : l'ordre des simples départage les ex æquo
//                     de classement par le rang, donc forcer l'un sans l'autre laisserait le
//                     membre inalignable (cf. lib/interclub-order.ts). Un NC fait exception, la
//                     fédération ne les ordonnant pas entre eux — `rangM` y reste facultatif.
//   set_squashnet_name → corrige le NOM sous lequel chercher ce membre sur squashnet
//                     (body.givenName + body.familyName ; les deux vides = retire la correction),
//                     puis retente le rapprochement tout de suite. Ne renomme PAS le membre.
//   rematch_squashnet → retente le rapprochement squashnet de ce membre, sans rien modifier.
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) {
    return NextResponse.json({ error: "Accès réservé" }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    id?: unknown;
    action?: unknown;
    passkeyId?: unknown;
    teamId?: unknown;
    clt?: unknown;
    rangM?: unknown;
    givenName?: unknown;
    familyName?: unknown;
  };
  if (typeof body.id !== "string" || !body.id) {
    return NextResponse.json({ error: "Membre invalide." }, { status: 400 });
  }
  const action = body.action;
  const target = await prisma.user.findUnique({ where: { id: body.id } });
  if (!target) {
    return NextResponse.json({ error: "Membre introuvable." }, { status: 404 });
  }

  // Garde-fous communs aux actions sensibles : ne jamais agir sur soi-même (anti-auto-blocage)
  // ni sur un autre administrateur (l'équipe d'admin se protège mutuellement).
  const isSensitive = action === "disable" || action === "delete";
  if (isSensitive) {
    if (target.id === admin.userId) {
      return NextResponse.json({ error: "Tu ne peux pas agir sur ton propre compte." }, { status: 400 });
    }
    if (isAdminEmail(target.email)) {
      return NextResponse.json({ error: "Ce compte est administrateur." }, { status: 400 });
    }
  }

  if (action === "link") {
    // Le lien mène à /reinitialiser, servi par le parcours « email seul » (désactivé → 404).
    if (!(await getFeatures()).emailLogin) {
      return NextResponse.json({ error: "Connexion par e-mail désactivée." }, { status: 400 });
    }
    if (!target.email) {
      return NextResponse.json({ error: "Ce compte n'a pas d'adresse e-mail." }, { status: 400 });
    }
    // Sans mot de passe = activation (signup, porte le nom) ; sinon réinitialisation (reset).
    const purpose = target.passwordHash ? "reset" : "signup";
    const token = await createEmailToken({
      email: target.email,
      purpose,
      ip: clientIp(req),
      displayName: purpose === "signup" ? target.displayName : null,
      approved: true,
    });
    const link = authLinkFor(req.nextUrl.origin, purpose, token);
    return NextResponse.json({ ok: true, link, purpose });
  }

  if (action === "disable") {
    // Les trois écritures vont ensemble : désactiver sans révoquer laisserait un cookie
    // valable, et désactiver sans valider d'office bloquerait à vie les tricounts dont ce
    // membre est payeur (il ne pourra plus se connecter, donc plus jamais valider — cf.
    // `approveAsDisabledPayer`, qui explique l'état mort que cela produisait).
    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: target.id }, data: { disabledAt: new Date() } });
      // Révoque immédiatement les sessions en cours : sans ça, un cookie déjà émis resterait
      // valable jusqu'à sa péremption (le refus ne joue qu'à la prochaine connexion).
      await tx.session.deleteMany({ where: { userId: target.id } });
      await approveAsDisabledPayer(target.id, tx as unknown as typeof prisma);
    });
    return NextResponse.json({ ok: true });
  }

  if (action === "enable") {
    await prisma.user.update({ where: { id: target.id }, data: { disabledAt: null } });
    return NextResponse.json({ ok: true });
  }

  if (action === "revoke_passkey") {
    // Retire UN passkey précis (un appareil). Borné à target.id : impossible de viser le passkey
    // d'un autre membre via un id forgé. 404 si l'id ne correspond à aucun passkey de ce membre.
    if (typeof body.passkeyId !== "string" || !body.passkeyId) {
      return NextResponse.json({ error: "Passkey invalide." }, { status: 400 });
    }
    const r = await prisma.passkey.deleteMany({ where: { id: body.passkeyId, userId: target.id } });
    if (r.count === 0) {
      return NextResponse.json({ error: "Passkey introuvable." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  }

  if (action === "revoke_passkeys") {
    // Retire TOUS les passkeys du membre (ex. téléphone perdu). Aucune session ni donnée touchée :
    // le membre pourra en réactiver un depuis ses Réglages. `removed` alimente le retour UI.
    const r = await prisma.passkey.deleteMany({ where: { userId: target.id } });
    return NextResponse.json({ ok: true, removed: r.count });
  }

  if (action === "set_team") {
    const off = await interclubDisabledResponse();
    if (off) return off;
    // `null` retire de toute équipe. On refuse un id inconnu plutôt que de l'ignorer, pour
    // qu'un écran resté ouvert après la suppression d'une équipe le sache.
    let teamId: string | null = null;
    if (body.teamId !== null && body.teamId !== undefined && body.teamId !== "") {
      if (typeof body.teamId !== "string") {
        return NextResponse.json({ error: "Équipe invalide." }, { status: 400 });
      }
      const team = await prisma.interclubTeam.findUnique({
        where: { id: body.teamId },
        select: { id: true },
      });
      if (!team) {
        return NextResponse.json({ error: "Équipe inconnue." }, { status: 400 });
      }
      teamId = team.id;
    }
    // Les rencontres passées ne bougent pas : `homeDisplayName` y est figé et `homeUserId`
    // garde le lien. Changer d'équipe n'engage que les compositions À VENIR.
    await prisma.user.update({ where: { id: target.id }, data: { teamId } });
    return NextResponse.json({ ok: true, teamId });
  }

  if (action === "set_clt_override") {
    const off = await interclubDisabledResponse();
    if (off) return off;
    const parsed = parseClassementInput(body.clt);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const rangM = parseRangMInput(body.rangM);
    if (!rangM.ok) return NextResponse.json({ error: rangM.error }, { status: 400 });
    await prisma.user.update({
      where: { id: target.id },
      // Deux colonnes d'OVERRIDE, jamais `squashnetRanking` : une correction manuelle ne doit
      // pas se faire passer pour un rapprochement, sans quoi le run mensuel l'écraserait.
      data: { interclubCltOverride: parsed.value, interclubRangMOverride: rangM.value },
    });
    return NextResponse.json({ ok: true, clt: parsed.value, rangM: rangM.value });
  }

  //   set_squashnet_name → corrige le NOM sous lequel chercher ce membre sur squashnet
  //                     (body.givenName / body.familyName ; les deux vides = retire la
  //                     correction), puis retente le rapprochement sur-le-champ.
  //
  // POURQUOI CE N'EST PAS UN RENOMMAGE. `displayName` vient de ResaMania et y est RÉÉCRIT à
  // chaque connexion : le corriger localement ne tiendrait pas jusqu'à la prochaine ouverture
  // de l'appli. Ces deux champs ne servent QU'À la recherche fédérale.
  //
  // POURQUOI IL FAUT LES DEUX. Le nom de FAMILLE devient le terme envoyé à squashnet — c'est
  // le plus discriminant, et c'est ce que l'approximation par défaut (« le dernier mot du nom
  // affiché ») rate quand ResaMania a enregistré « Nom Prénom ». Le PRÉNOM, lui, sert à
  // départager les lignes rendues. N'en donner qu'un rendrait le rapprochement PLUS permissif
  // que le comportement par défaut : l'inverse du but.
  if (action === "set_squashnet_name") {
    if (!(await getFeatures()).ranking) {
      return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
    }
    const given = typeof body.givenName === "string" ? body.givenName.trim().replace(/\s+/g, " ") : "";
    const family = typeof body.familyName === "string" ? body.familyName.trim().replace(/\s+/g, " ") : "";
    if (!!given !== !!family) {
      return NextResponse.json(
        { error: "Donne le prénom ET le nom, ou laisse les deux vides." },
        { status: 400 },
      );
    }
    if (given.length > MAX_SQUASHNET_NAME_LEN || family.length > MAX_SQUASHNET_NAME_LEN) {
      return NextResponse.json({ error: "Nom trop long." }, { status: 400 });
    }
    await prisma.user.update({
      where: { id: target.id },
      data: { squashnetGivenName: given || null, squashnetFamilyName: family || null },
    });
    // Rapprochement IMMÉDIAT : sans lui, l'admin saisirait un nom sans savoir s'il est le bon
    // et devrait attendre le passage mensuel du cron pour l'apprendre. Best-effort — l'échec
    // réseau ne remet pas en cause l'enregistrement du nom, qui est ce qu'on veut garder, et
    // se signale alors par un statut `error` distinct d'un « introuvable ».
    const status = await refreshMemberRanking(target.id);
    return NextResponse.json({ ok: true, givenName: given || null, familyName: family || null, status });
  }

  //   rematch_squashnet → retente le rapprochement de ce membre, sans rien changer d'autre.
  //
  // Le pendant exact de `rematch_guest` côté joueurs sans compte, et il existe pour la même
  // raison : `set_squashnet_name` ne rapproche QUE lorsque le nom change. Or un rapprochement
  // peut échouer pour une cause qui n'a rien à voir avec le nom — squashnet indisponible ce
  // jour-là, licence pas encore publiée, mois pas encore paru. Sans ce bouton, la seule façon
  // de réessayer serait de modifier le nom pour le remettre ensuite : un geste absurde.
  if (action === "rematch_squashnet") {
    if (!(await getFeatures()).ranking) {
      return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
    }
    const status = await refreshMemberRanking(target.id);
    return NextResponse.json({ ok: true, status });
  }

  if (action === "delete") {
    const blockers = await deleteBlockersFor(target.id);
    if (blockers.total > 0) {
      return NextResponse.json(
        {
          error:
            "Suppression impossible : ce membre a un historique (dépenses/tournois). Désactive-le plutôt.",
          blockers,
        },
        { status: 409 },
      );
    }
    // Les relations restantes sont en Cascade/SetNull : la suppression est propre.
    await prisma.user.delete({ where: { id: target.id } });
    // La cascade emporte aussi ses `SlotAlert` sans passer par la route des alertes : c'est le
    // seul chemin de disparition d'alertes qui contourne l'invalidation. Sans cet appel, le
    // cron continuerait de croire qu'il a du travail et réveillerait Neon toutes les 4 minutes
    // jusqu'au TTL (cf. lib/alerts-gate.ts).
    alertsChanged();
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Action inconnue." }, { status: 400 });
}
