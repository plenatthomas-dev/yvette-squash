import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin, isAdminEmail } from "@/lib/admin";
import { listMembers, deleteBlockersFor } from "@/lib/members";
import { getFeatures } from "@/lib/features-server";
import { createEmailToken, authLinkFor, clientIp } from "@/lib/email-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/members — liste de tous les comptes (gestion des membres, étape 1).
export async function GET(req: NextRequest) {
  if (!(await requireAdmin(req))) {
    return NextResponse.json({ error: "Accès réservé" }, { status: 403 });
  }
  return NextResponse.json({ members: await listMembers() });
}

// POST /api/admin/members  { id, action }
//   link            → régénère un lien d'accès à transmettre (activation si sans mot de passe,
//                     sinon réinitialisation) ; mène à /reinitialiser où la personne choisit son mdp ;
//   disable         → désactive le compte (connexion refusée) + révoque ses sessions ;
//   enable          → réactive le compte ;
//   revoke_passkeys → retire TOUS les passkeys du membre (appareil perdu signalé) ; il pourra
//                     en ré-enrôler depuis ses Réglages. Recouvrable → non « sensible ».
//   delete          → suppression définitive, refusée si le membre porte un historique bloquant.
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) {
    return NextResponse.json({ error: "Accès réservé" }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as { id?: unknown; action?: unknown };
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
    await prisma.user.update({ where: { id: target.id }, data: { disabledAt: new Date() } });
    // Révoque immédiatement les sessions en cours : sans ça, un cookie déjà émis resterait
    // valable jusqu'à sa péremption (le refus ne joue qu'à la prochaine connexion).
    await prisma.session.deleteMany({ where: { userId: target.id } });
    return NextResponse.json({ ok: true });
  }

  if (action === "enable") {
    await prisma.user.update({ where: { id: target.id }, data: { disabledAt: null } });
    return NextResponse.json({ ok: true });
  }

  if (action === "revoke_passkeys") {
    // Retire les passkeys du membre (ex. téléphone perdu). Aucune session ni donnée touchée :
    // le membre pourra en réactiver un depuis ses Réglages. `removed` alimente le retour UI.
    const r = await prisma.passkey.deleteMany({ where: { userId: target.id } });
    return NextResponse.json({ ok: true, removed: r.count });
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
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Action inconnue." }, { status: 400 });
}
