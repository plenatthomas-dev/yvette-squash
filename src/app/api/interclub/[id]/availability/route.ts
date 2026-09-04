import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireInterclubMember } from "@/lib/interclub-access";
import {
  isAvailabilityStatus,
  parseComment,
  tally,
  type AvailabilityEntry,
  type AvailabilityStatus,
  needsOverrideConfirm,
} from "@/lib/interclub-availability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ============================================================================
//  DISPONIBILITÉS D'UNE RENCONTRE.
//
//  QUI PEUT LIRE ET ÉCRIRE : les membres de L'ÉQUIPE qui dispute la rencontre.
//  Pas le club entier — une disponibilité est une donnée personnelle, et la
//  montrer à qui ne joue pas cette rencontre n'apporte rien. Pas le seul
//  capitaine non plus : voir « on n'est que trois » est ce qui fait répondre
//  les autres, et c'est tout l'intérêt par rapport à un fil de discussion.
//
//  ⚠️ ON PEUT RÉPONDRE POUR QUELQU'UN D'AUTRE. Une partie de l'équipe ne verra
//  jamais l'appel : les joueurs sans compte, et les membres qui n'ont pas
//  activé les notifications. Si seule la personne concernée pouvait répondre,
//  l'outil serait inutile pour la moitié du roster. La garantie n'est donc pas
//  une restriction mais une TRACE (`setById`, affichée) et une confirmation
//  explicite avant d'écraser ce que quelqu'un a dit lui-même.
// ============================================================================

/** La rencontre, son équipe, et le droit d'y toucher — ou la réponse à renvoyer. */
type Context =
  | { ok: false; response: NextResponse }
  | {
      ok: true;
      session: { userId: string; email: string | null };
      fixture: { id: string; teamId: string; matchCount: number; date: string };
    };

/**
 * Le contexte commun aux deux verbes.
 *
 * Union DISCRIMINÉE par `ok`, comme `InterclubAccess` : distinguer les deux cas par la
 * présence d'une clé (`"error" in ctx`) laisse TypeScript rendre `NextResponse | undefined`
 * aux appelants, qui doivent alors se garder d'un cas qui n'existe pas.
 */
async function loadContext(req: NextRequest, id: string): Promise<Context> {
  const access = await requireInterclubMember(req);
  if (!access.ok) return { ok: false, response: access.response };
  const { session } = access;

  const fixture = await prisma.interclub.findUnique({
    where: { id },
    select: { id: true, teamId: true, matchCount: true, date: true },
  });
  if (!fixture) {
    return { ok: false, response: NextResponse.json({ error: "Rencontre introuvable" }, { status: 404 }) };
  }

  const me = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { teamId: true },
  });
  // La règle tient en une ligne, et c'est voulu : on parle de la disponibilité de gens qui
  // jouent ensemble. Un membre d'une autre équipe n'a rien à y lire ni à y écrire.
  if (!me || me.teamId !== fixture.teamId) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Réservé aux joueurs de cette équipe" }, { status: 403 }),
    };
  }
  return { ok: true, session, fixture };
}

/**
 * L'état complet des réponses : tout le roster de l'équipe, répondants ET silencieux.
 *
 * On part du ROSTER et non des réponses enregistrées. C'est le seul moyen de faire apparaître
 * ceux qui n'ont rien dit — or ce sont eux qui intéressent le capitaine, et une liste qui ne
 * montrerait que les réponses donnerait l'illusion d'une équipe complète.
 */
async function readEntries(teamId: string, fixtureId: string): Promise<AvailabilityEntry[]> {
  const [members, guests, answers] = await Promise.all([
    prisma.user.findMany({
      where: { teamId, disabledAt: null },
      select: {
        id: true,
        displayName: true,
        nickname: true,
        // Un membre est ATTEIGNABLE s'il a au moins un appareil abonné aux notifications.
        // On ne compte pas les lignes : `take: 1` suffit à répondre oui/non, et cette requête
        // part à chaque ouverture de l'écran.
        pushSubs: { select: { id: true }, take: 1 },
      },
    }),
    prisma.interclubGuest.findMany({ where: { teamId }, select: { id: true, name: true } }),
    prisma.interclubAvailability.findMany({
      where: { interclubId: fixtureId },
      select: {
        userId: true,
        guestId: true,
        status: true,
        comment: true,
        setById: true,
        setBy: { select: { displayName: true, nickname: true } },
      },
    }),
  ]);

  const label = (u: { displayName: string; nickname: string | null }) => u.nickname ?? u.displayName;
  const byUser = new Map(answers.filter((a) => a.userId).map((a) => [a.userId as string, a]));
  const byGuest = new Map(answers.filter((a) => a.guestId).map((a) => [a.guestId as string, a]));

  const entries: AvailabilityEntry[] = members.map((m) => {
    const a = byUser.get(m.id);
    return {
      key: m.id,
      name: label(m),
      isMember: true,
      status: (a?.status as AvailabilityStatus | undefined) ?? null,
      comment: a?.comment ?? null,
      // Renseigné SEULEMENT si quelqu'un d'autre a saisi : sur une réponse de première main,
      // afficher « relayé par Alice » à Alice n'apprendrait rien et sèmerait le doute.
      relayedBy: a && a.setById !== m.id ? label(a.setBy) : null,
      reachable: m.pushSubs.length > 0,
    };
  });

  for (const g of guests) {
    const a = byGuest.get(g.id);
    entries.push({
      // Préfixé, comme dans l'annuaire : un identifiant d'invité et un identifiant de compte
      // ne doivent pas pouvoir se confondre dans une liste qui les mêle.
      key: `guest:${g.id}`,
      name: g.name,
      isMember: false,
      status: (a?.status as AvailabilityStatus | undefined) ?? null,
      comment: a?.comment ?? null,
      // Toujours relayée : un joueur sans compte ne répond jamais lui-même, par construction.
      relayedBy: a ? label(a.setBy) : null,
      // Jamais atteignable : pas de compte, donc pas de notification. Il sera dans la liste
      // d'appels du capitaine, ce qui est exactement le traitement qu'il lui faut.
      reachable: false,
    });
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name, "fr"));
}

// GET /api/interclub/{id}/availability — l'état des réponses de l'équipe.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await loadContext(req, id);
  if (!ctx.ok) return ctx.response;

  const entries = await readEntries(ctx.fixture.teamId, id);
  return NextResponse.json({
    entries,
    counts: tally(entries),
    matchCount: ctx.fixture.matchCount,
    me: ctx.session.userId,
  });
}

// PUT /api/interclub/{id}/availability — poser une réponse, la sienne ou celle d'un autre.
//   { status, comment?, userId? | guestId?, confirmOverride? }
// Sans `userId` ni `guestId` : c'est la sienne.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await loadContext(req, id);
  if (!ctx.ok) return ctx.response;
  const { session, fixture } = ctx;

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (!isAvailabilityStatus(body.status)) {
    return NextResponse.json({ error: "Réponse invalide" }, { status: 400 });
  }
  const comment = parseComment(body.comment);

  const guestId = typeof body.guestId === "string" ? body.guestId : null;
  const subjectUserId = guestId ? null : typeof body.userId === "string" ? body.userId : session.userId;
  if (guestId && typeof body.userId === "string") {
    return NextResponse.json({ error: "Un membre OU un joueur sans compte, pas les deux." }, { status: 400 });
  }

  // Le sujet appartient-il bien à cette équipe ? Sans ce contrôle, on pourrait consigner la
  // disponibilité de n'importe qui pour n'importe quelle rencontre.
  if (guestId) {
    const g = await prisma.interclubGuest.findUnique({ where: { id: guestId }, select: { teamId: true } });
    if (!g || g.teamId !== fixture.teamId) {
      return NextResponse.json({ error: "Joueur hors de cette équipe" }, { status: 400 });
    }
  } else {
    const u = await prisma.user.findUnique({ where: { id: subjectUserId! }, select: { teamId: true } });
    if (!u || u.teamId !== fixture.teamId) {
      return NextResponse.json({ error: "Joueur hors de cette équipe" }, { status: 400 });
    }
  }

  const existing = await prisma.interclubAvailability.findFirst({
    where: guestId ? { interclubId: id, guestId } : { interclubId: id, userId: subjectUserId! },
    select: { id: true, userId: true, setById: true, status: true, updatedAt: true },
  });

  // ÉCRASER UNE RÉPONSE DE PREMIÈRE MAIN SE CONFIRME. Ce n'est pas un verrou — le capitaine
  // qui a eu la personne au téléphone confirme et passe — mais personne ne doit faire
  // disparaître un « non » assumé sans l'avoir vu. On renvoie ce qu'elle disait et quand,
  // pour que l'écran puisse le montrer plutôt que d'annoncer un refus sec.
  if (
    body.confirmOverride !== true &&
    needsOverrideConfirm(existing, subjectUserId, session.userId)
  ) {
    return NextResponse.json(
      {
        error: "confirm_override",
        existing: { status: existing!.status, updatedAt: existing!.updatedAt.toISOString() },
      },
      { status: 409 },
    );
  }

  const data = { status: body.status, comment, setById: session.userId };
  if (existing) {
    await prisma.interclubAvailability.update({ where: { id: existing.id }, data });
  } else {
    await prisma.interclubAvailability.create({
      data: { interclubId: id, userId: subjectUserId, guestId, ...data },
    });
  }

  const entries = await readEntries(fixture.teamId, id);
  return NextResponse.json({ entries, counts: tally(entries), matchCount: fixture.matchCount });
}
