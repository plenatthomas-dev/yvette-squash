import { NextRequest, NextResponse } from "next/server";
import { FEATURE_EMAIL_LOGIN } from "@/lib/features";
import { requireAdmin } from "@/lib/admin";
import {
  listPendingRequests,
  approveRequest,
  rejectRequest,
  authLinkFor,
} from "@/lib/email-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/requests
// File d'attente des demandes de compte / réinitialisation (inscription sur invitation).
export async function GET(req: NextRequest) {
  if (!FEATURE_EMAIL_LOGIN) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  if (!(await requireAdmin(req))) {
    return NextResponse.json({ error: "Accès réservé" }, { status: 403 });
  }
  const requests = await listPendingRequests();
  return NextResponse.json({ requests });
}

// POST /api/admin/requests  { id, action: "approve" | "reject" }
// approve → régénère un lien à transmettre à la personne (renvoyé une seule fois) ;
// reject  → supprime la demande.
export async function POST(req: NextRequest) {
  if (!FEATURE_EMAIL_LOGIN) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  if (!(await requireAdmin(req))) {
    return NextResponse.json({ error: "Accès réservé" }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as { id?: unknown; action?: unknown };
  if (typeof body.id !== "string" || !body.id) {
    return NextResponse.json({ error: "Demande invalide." }, { status: 400 });
  }

  if (body.action === "reject") {
    await rejectRequest(body.id);
    return NextResponse.json({ ok: true });
  }
  if (body.action === "approve") {
    const approved = await approveRequest(body.id);
    if (!approved) {
      return NextResponse.json({ error: "Demande introuvable ou déjà traitée." }, { status: 404 });
    }
    const link = authLinkFor(req.nextUrl.origin, approved.purpose, approved.token);
    return NextResponse.json({ ok: true, link, email: approved.email, purpose: approved.purpose });
  }
  return NextResponse.json({ error: "Action inconnue." }, { status: 400 });
}
