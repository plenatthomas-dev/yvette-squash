import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { listBlocks, addBlock, removeBlock } from "@/lib/moderation";
import { EMAIL_RE } from "@/lib/email-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/blocklist — e-mails bloqués (empêche la réinscription).
export async function GET(req: NextRequest) {
  if (!(await requireAdmin(req))) {
    return NextResponse.json({ error: "Accès réservé" }, { status: 403 });
  }
  return NextResponse.json({ blocks: await listBlocks() });
}

// POST /api/admin/blocklist  { action: "add" | "remove", email, reason? }
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) {
    return NextResponse.json({ error: "Accès réservé" }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    action?: unknown;
    email?: unknown;
    reason?: unknown;
  };
  if (typeof body.email !== "string" || !EMAIL_RE.test(body.email.trim())) {
    return NextResponse.json({ error: "E-mail invalide." }, { status: 400 });
  }
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 200) || null : null;

  if (body.action === "add") {
    await addBlock(body.email, reason, admin.userId);
    return NextResponse.json({ ok: true });
  }
  if (body.action === "remove") {
    await removeBlock(body.email);
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "Action inconnue." }, { status: 400 });
}
