import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { NOTIFICATION_PAGE } from "@/lib/notify-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/notifications : mes dernières notifications, et combien sont non lues.
//
// Pas de flag de fonction : ce journal n'appartient à aucune fonctionnalité en particulier —
// il reçoit aussi bien les alertes « terrain libéré » que les annonces du club ou le suivi
// interclub. Le couper reviendrait à cacher des notifications déjà envoyées.
//
// Une SEULE requête sert la liste ET la pastille : compter séparément doublerait le coût d'un
// appel fait à chaque chargement de page — et la cloche se recharge aussi à chaque retour au
// premier plan. Sur Neon, c'est l'un des appels les plus fréquents de l'appli.
//
// REGROUPEMENT PAR `tag`, fait ici et pas en base. La colonne `tag` existait, était écrite à
// chaque notification… et n'était relue par personne : le schéma promettait qu'elle « regroupe
// une série (une rencontre, une alerte) », rien ne regroupait quoi que ce soit. Conséquence
// mesurable : au niveau « détaillé », une soirée à quatre matchs produit une vingtaine de
// lignes par abonné, de quoi remplir à elle seule toute la cloche et en chasser le reste.
//
// Regrouper à la LECTURE plutôt qu'à l'écriture est délibéré : collapser en base demanderait de
// lire avant d'écrire, donc trois requêtes par notification au lieu d'une, sur le chemin chaud
// d'une soirée. Ici le regroupement ne coûte rien — on lit simplement une fenêtre plus large
// (le poids d'une ligne est dérisoire, c'est la requête qui coûte) et on la replie.
const RAW_WINDOW = 120;

export async function GET(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const rows = await prisma.appNotification.findMany({
    where: { userId: session.userId },
    orderBy: { createdAt: "desc" },
    take: RAW_WINDOW,
    select: { id: true, title: true, body: true, url: true, tag: true, createdAt: true, readAt: true },
  });

  // Une série = un `tag`. On garde la ligne la PLUS RÉCENTE (les lignes arrivent déjà triées),
  // en comptant celles qu'elle représente. Une notification sans tag reste seule : c'est
  // exactement ce que « pas de tag » veut dire.
  const groups: {
    id: string;
    title: string;
    body: string;
    url: string | null;
    at: string;
    read: boolean;
    count: number;
  }[] = [];
  const byTag = new Map<string, number>(); // tag → index dans `groups`

  for (const n of rows) {
    const idx = n.tag ? byTag.get(n.tag) : undefined;
    if (idx !== undefined) {
      const g = groups[idx];
      g.count += 1;
      // Une série non lue reste non lue tant qu'il reste une ligne non lue dedans : sinon la
      // pastille retomberait à zéro alors que le membre n'a rien vu.
      g.read = g.read && n.readAt !== null;
      continue;
    }
    if (n.tag) byTag.set(n.tag, groups.length);
    groups.push({
      id: n.id,
      title: n.title,
      body: n.body,
      url: n.url,
      at: n.createdAt.toISOString(),
      read: n.readAt !== null,
      count: 1,
    });
  }

  return NextResponse.json({
    items: groups.slice(0, NOTIFICATION_PAGE),
    // Compté sur les SÉRIES, comme ce qui est affiché : une soirée de rencontre pèse « 1 » dans
    // la pastille, et non vingt. Le compte porte sur la fenêtre lue — au-delà de RAW_WINDOW
    // lignes brutes non lues, il sous-estime ; l'écran affiche « 9+ » bien avant d'en arriver là.
    unread: groups.filter((g) => !g.read).length,
  });
}

// POST /api/notifications : marque tout comme lu.
//
// Tout, et pas ligne par ligne : la cloche se consulte d'un coup d'œil, et demander à
// l'utilisateur d'acquitter chaque ligne serait une corvée pour une information déjà lue.
export async function POST(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const { count } = await prisma.appNotification.updateMany({
    where: { userId: session.userId, readAt: null },
    data: { readAt: new Date() },
  });
  return NextResponse.json({ ok: true, read: count });
}

// DELETE /api/notifications[?scope=read] : vider la cloche.
//
// Deux portées, parce qu'elles répondent à deux gestes différents : `read` fait le ménage de
// ce qu'on a déjà vu — l'usage courant, sans risque de perdre quelque chose —, tandis que la
// portée par défaut efface tout, y compris le non lu, pour repartir de zéro.
export async function DELETE(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  const onlyRead = req.nextUrl.searchParams.get("scope") === "read";
  const { count } = await prisma.appNotification.deleteMany({
    where: onlyRead
      ? { userId: session.userId, readAt: { not: null } }
      : { userId: session.userId },
  });
  return NextResponse.json({ ok: true, removed: count });
}
