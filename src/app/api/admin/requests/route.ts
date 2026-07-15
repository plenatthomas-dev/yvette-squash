import { NextRequest, NextResponse } from "next/server";
import { getFeatures } from "@/lib/features-server";
import { requireAdmin } from "@/lib/admin";
import { addBlock } from "@/lib/moderation";
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
// approve      → régénère un lien à transmettre à la personne (renvoyé une seule fois) ;
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
    const approved = await approveRequest(body.id, admin.userId);
    if (!approved) {
      return NextResponse.json({ error: "Demande introuvable ou déjà traitée." }, { status: 404 });
    }
    const link = authLinkFor(req.nextUrl.origin, approved.purpose, approved.token);
    return NextResponse.json({ ok: true, link, email: approved.email, purpose: approved.purpose });
  }
  return NextResponse.json({ error: "Action inconnue." }, { status: 400 });
}
