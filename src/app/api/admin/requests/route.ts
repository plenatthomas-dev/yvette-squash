import { NextRequest, NextResponse } from "next/server";
import { getFeatures } from "@/lib/features-server";
import { requireAdmin } from "@/lib/admin";
import { addBlock } from "@/lib/moderation";
import { emailConfigured } from "@/lib/email";
import {
  listPendingRequests,
  approveRequest,
  rejectRequest,
  authLinkFor,
  pendingRequestPurpose,
  revertApproval,
  sendResetEmail,
  sendSignupApprovedEmail,
} from "@/lib/email-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/requests
// File d'attente des demandes de compte / réinitialisation (inscription sur invitation).
export async function GET(req: NextRequest) {
  if (!(await getFeatures()).emailLogin) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  if (!(await requireAdmin(req))) {
    return NextResponse.json({ error: "Accès réservé" }, { status: 403 });
  }
  const requests = await listPendingRequests();
  return NextResponse.json({ requests });
}

// POST /api/admin/requests  { id, action: "approve" | "reject" | "reject-block" }
// approve      → régénère un lien et l'ENVOIE PAR E-MAIL à l'adresse de la demande : c'est le
//                seul canal qui prouve que le demandeur possède l'adresse. Sans e-mail configuré,
//                une inscription rend encore le lien à l'admin (invitation) ; une
//                réinitialisation est refusée — transmise par WhatsApp/SMS à « quelqu'un qui dit
//                être X », elle livrait le compte de X, admin compris (audit 2026-10, point 3) ;
// reject       → supprime la demande (journalisée dans l'historique) ;
// reject-block → rejette ET bloque l'e-mail (réinscription abusive).
export async function POST(req: NextRequest) {
  if (!(await getFeatures()).emailLogin) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const admin = await requireAdmin(req);
  if (!admin) {
    return NextResponse.json({ error: "Accès réservé" }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as { id?: unknown; action?: unknown };
  if (typeof body.id !== "string" || !body.id) {
    return NextResponse.json({ error: "Demande invalide." }, { status: 400 });
  }

  if (body.action === "reject" || body.action === "reject-block") {
    const email = await rejectRequest(body.id, admin.userId);
    if (body.action === "reject-block" && email) {
      await addBlock(email, "Demande rejetée depuis la file d'attente", admin.userId);
    }
    return NextResponse.json({ ok: true });
  }
  if (body.action === "approve") {
    const mail = emailConfigured();
    if (!mail && (await pendingRequestPurpose(body.id)) === "reset") {
      return NextResponse.json(
        {
          error:
            "Réinitialisation impossible sans envoi d'e-mail configuré : le lien doit partir vers l'adresse du compte, pas être transmis à la main.",
        },
        { status: 409 },
      );
    }
    const approved = await approveRequest(body.id, admin.userId);
    if (!approved) {
      return NextResponse.json({ error: "Demande introuvable ou déjà traitée." }, { status: 404 });
    }
    const link = authLinkFor(req.nextUrl.origin, approved.purpose, approved.token);
    if (!mail) {
      return NextResponse.json({ ok: true, link, email: approved.email, purpose: approved.purpose });
    }
    try {
      if (approved.purpose === "reset") {
        await sendResetEmail(approved.email, req.nextUrl.origin, approved.token);
      } else {
        await sendSignupApprovedEmail(approved.email, link);
      }
    } catch (e) {
      console.error("[admin/requests] envoi du lien impossible:", (e as Error).message);
      await revertApproval(body.id);
      return NextResponse.json(
        { error: "L'e-mail n'a pas pu partir : la demande reste en attente, réessaie plus tard." },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true, sent: true, email: approved.email, purpose: approved.purpose });
  }
  return NextResponse.json({ error: "Action inconnue." }, { status: 400 });
}
