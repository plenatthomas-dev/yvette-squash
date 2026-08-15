import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { alertsChanged } from "@/lib/alerts-gate";

export const runtime = "nodejs";

// DELETE /api/alerts/{id} -> supprime une de mes alertes.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const { id } = await params;
  // deleteMany borné à mon userId : pas d'accès aux alertes des autres.
  const { count } = await prisma.slotAlert.deleteMany({ where: { id, userId: session.userId } });
  // Referme la porte du cron si c'était la dernière alerte (cf. lib/alerts-gate.ts). On
  // n'invalide que si quelque chose a bien été supprimé : un id inconnu ne change rien.
  if (count > 0) alertsChanged();
  return NextResponse.json({ ok: true });
}
