import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { getFeatures } from "@/lib/features-server";
import { pushToUser } from "@/lib/push";

export const runtime = "nodejs";

// DELETE /api/delegations/{id} -> met fin à une délégation qui me concerne.
// Les DEUX camps peuvent y mettre fin : le délégant retire les droits qu'il a donnés ; le
// délégataire rend ceux qu'il a reçus (une délégation non sollicitée ne doit pas être subie —
// il n'a rien demandé, et personne ne devrait garder de force le pouvoir d'agir au nom d'un
// autre). Dans les deux cas c'est une RESTRICTION de droits : aucun risque à l'ouvrir.
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!(await getFeatures()).delegation) {
    return NextResponse.json({ error: "Délégation désactivée" }, { status: 404 });
  }
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const { id } = await params;
  // Borné aux délégations où JE suis l'une des deux parties : pas moyen de toucher à celle de
  // deux autres membres. On lit d'abord (pour savoir qui prévenir), puis on révoque en marquant
  // endNotifiedAt → le cron d'expiration ne la re-notifiera pas.
  const deleg = await prisma.delegation.findFirst({
    where: {
      id,
      revokedAt: null,
      OR: [{ delegatorId: session.userId }, { delegateId: session.userId }],
    },
    select: { id: true, delegatorId: true, delegateId: true },
  });
  if (deleg) {
    await prisma.delegation.update({
      where: { id: deleg.id },
      data: { revokedAt: new Date(), endNotifiedAt: new Date() },
    });
    // On prévient l'AUTRE partie (best-effort) : celui qui agit sait déjà ce qu'il a fait.
    const iAmDelegator = deleg.delegatorId === session.userId;
    const otherId = iAmDelegator ? deleg.delegateId : deleg.delegatorId;
    const me = await prisma.user.findUnique({
      where: { id: session.userId },
      select: { displayName: true, nickname: true },
    });
    const name = me?.nickname ?? me?.displayName ?? "Un membre";
    await pushToUser(otherId, {
      title: "Délégation terminée",
      body: iAmDelegator
        ? `${name} a mis fin à la délégation — tu ne peux plus agir en son nom.`
        : `${name} a rendu la délégation que tu lui avais accordée.`,
      url: "/",
      tag: `delegation-end-${deleg.id}`,
    }).catch(() => {});
  }
  return NextResponse.json({ ok: true });
}
