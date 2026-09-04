import { prisma } from "@/lib/db";
import { getLatestMonth, searchRanking } from "./client";
import { classifyRanking, searchQuery, type MemberIdentity } from "./match";
import type { RankingRow } from "./client";

// ============================================================================
//  Rafraîchissement du classement fédéral (squashnet.fr). Cœur PARTAGÉ entre le
//  cron mensuel (warm-rankings) et le bouton admin « Rafraîchir les classements ».
//
//  Pour chaque joueur : recherche par nom, verdict SÛR (classifyRanking) ;
//  écriture si trouvé, effacement SEULEMENT sur signal positif de départ, jamais
//  sur un simple « pas trouvé ». Séquentiel (doux pour squashnet), idempotent.
//
//  DEUX POPULATIONS, UNE SEULE PASSE.
//   * les MEMBRES — compte sur l'appli — dont le classement nourrit l'annuaire ET
//     l'ordre des simples interclub. Balayés s'ils sont OPT-IN de l'annuaire
//     (`listed`) OU rattachés à une équipe interclub : un membre qui s'est retiré
//     du trombinoscope n'a pas pour autant quitté son équipe, et sans classement
//     rapproché il devient inalignable (cf. `interclub-roster.ts`) ;
//   * les JOUEURS SANS COMPTE (`InterclubGuest`) — « sans compte » ne veut pas
//     dire « sans licence » : ils disputent le même championnat, donc squashnet
//     les connaît. Leur classement était saisi à la main faute d'être cherché ;
//     il se périmait dès le mois suivant, en silence.
//
//  L'ADMIN GARDE LE DERNIER MOT DES DEUX CÔTÉS. Cette passe n'écrit QUE les
//  colonnes de rapprochement (`SquashnetRanking` pour un membre, `sn*` pour un
//  invité) et ne touche JAMAIS aux corrections manuelles (`interclubCltOverride`,
//  `InterclubGuest.cltOverride`…), qui restent prioritaires à la lecture. C'est ce
//  qui rend le rafraîchissement inoffensif pour un joueur que squashnet ne sait
//  pas retrouver : sa correction survit à tous les runs.
// ============================================================================

// Disjoncteur « suppression en masse ». Le verdict `moved` (nom retrouvé uniquement hors du
// club) supprime le classement. Si BEAUCOUP de membres deviennent `moved` d'un coup, c'est
// presque sûrement un problème SYSTÉMIQUE — squashnet a renommé/re-rendu le libellé du club et
// `classifyRanking` ne reconnaît plus AUCUNE ligne « dans le club » — et non des départs réels.
// Dans ce cas on n'effectue AUCUNE suppression ce run (fail-safe : mieux vaut des classements
// périmés qu'un effacement total). Départs individuels normaux (0-2/mois) : bien en-dessous.
const BULK_MOVE_MIN = 4; // en-dessous de ce nombre absolu, on fait confiance
const BULK_MOVE_RATIO = 0.34; // ET au-delà d'~1/3 des membres balayés → anomalie

export interface RefreshResult {
  /** Période de classement ciblée, ex. "2026-07-07". Null si squashnet n'en renvoie aucune. */
  month: string | null;
  /** Nombre de joueurs passés en revue — membres balayés ET joueurs sans compte. */
  members: number;
  /** Dont joueurs SANS COMPTE (`InterclubGuest`), déjà comptés dans `members`. */
  guests: number;
  /** Classements rapprochés puis écrits. */
  matched: number;
  /** Classements obsolètes retirés (sur signal positif de départ du club). */
  cleared: number;
  /** Joueurs laissés en l'état, faute de signal fiable (erreur/silence squashnet, ambiguïté,
   *  ou effacement neutralisé par le disjoncteur anti-effacement-massif). */
  skipped: number;
  /** Joueurs dont l'ÉCRITURE base a échoué (imputé à la base, jamais à squashnet). */
  failed: number;
  /** Vrai si le disjoncteur a neutralisé un lot d'effacements (anomalie systémique probable). */
  bulkMoveBlocked: boolean;
}

/**
 * Un joueur à rapprocher, quelle que soit sa population. Le rapprochement ne dépend que du NOM :
 * c'est ce qui permet aux deux populations de partager la même boucle, le même verdict et le
 * même disjoncteur — trois choses qu'on ne veut surtout pas voir diverger.
 *
 * `query` (le terme envoyé à squashnet) et `identity` (ce que le rapprochement doit retrouver
 * dans la ligne) sont calculés UNE FOIS, à la construction, et jamais redérivés dans la boucle :
 * c'est là que se loge la correction admin d'un nom, et l'y appliquer à deux endroits reviendrait
 * à pouvoir en oublier un.
 */
type Subject = {
  kind: "member" | "guest";
  id: string;
  /** Nom affiché, pour les journaux et les messages — jamais utilisé pour rapprocher. */
  name: string;
  /** Terme de recherche envoyé à squashnet (idéalement le nom de FAMILLE, le plus discriminant). */
  query: string;
  /** Identité que `classifyRanking` doit retrouver dans une ligne du club. */
  identity: MemberIdentity;
};

/**
 * Identité de recherche par DÉFAUT, à partir du seul nom affiché — le comportement historique,
 * et celui de tout joueur sans correction.
 *
 * Deux approximations assumées, et c'est précisément ce que la correction admin répare :
 *   * le nom de famille est supposé être le DERNIER MOT. Faux dès que ResaMania a enregistré
 *     « Nom Prénom » : on interroge alors la fédération sur un prénom, la réponse déborde, et le
 *     verdict est « introuvable » tous les mois sans que rien ne le signale ;
 *   * le nom entier est passé en `familyName`, `givenName` restant vide. `nameMatches` exigeant
 *     que TOUS les jetons du nom se retrouvent dans la ligne, cela revient à comparer l'identité
 *     complète — donc ni plus ni moins strict que de les séparer.
 */
function defaultIdentity(name: string): { query: string; identity: MemberIdentity } {
  const tokens = name.split(/\s+/);
  return { query: tokens[tokens.length - 1], identity: { givenName: "", familyName: name } };
}

/** Les joueurs à balayer, dans l'ordre : membres d'abord, joueurs sans compte ensuite. */
async function subjectsToRefresh(): Promise<Subject[]> {
  const [users, guests] = await Promise.all([
    // `listed` OU rattaché à une équipe : cf. l'en-tête du module. Un membre retiré de
    // l'annuaire mais aligné en championnat a besoin de son classement — pas pour être affiché,
    // mais pour pouvoir être composé.
    prisma.user.findMany({
      where: { OR: [{ listed: true }, { teamId: { not: null } }] },
      select: { id: true, displayName: true, squashnetGivenName: true, squashnetFamilyName: true },
    }),
    prisma.interclubGuest.findMany({ select: { id: true, name: true } }),
  ]);

  // On matche sur le VRAI nom (`displayName`), jamais le pseudo (`nickname`). On écarte tout de
  // suite les noms vides : ils ne sont pas évaluables et fausseraient le compteur `members`, le
  // ratio du disjoncteur et le critère « tous ignorés » du heartbeat.
  //
  // Un joueur SANS COMPTE n'a pas de correction de nom, et n'en a pas besoin : son nom est saisi
  // par l'admin, qui peut simplement le corriger là où il l'a écrit.
  return [
    ...users.map((u) => ({ kind: "member" as const, id: u.id, name: u.displayName.trim(), ...memberIdentity(u) })),
    ...guests.map((g) => ({ kind: "guest" as const, id: g.id, name: g.name.trim(), ...defaultIdentity(g.name.trim()) })),
  ].filter((s) => s.name !== "");
}

/**
 * Sous quel nom chercher CE membre : la correction admin si elle est posée, sinon le nom
 * affiché. La correction n'est prise en compte que si ses DEUX moitiés sont là — une identité
 * amputée rendrait la recherche plus permissive que le défaut, donc plus exposée aux homonymes,
 * ce qui serait l'inverse du but. L'écriture le contrôle déjà (`set_squashnet_name`) ; on le
 * revérifie ici, pour qu'une ligne à moitié remplie par un autre chemin ne dégrade rien.
 */
function memberIdentity(u: {
  displayName: string;
  squashnetGivenName: string | null;
  squashnetFamilyName: string | null;
}): { query: string; identity: MemberIdentity } {
  const given = u.squashnetGivenName?.trim();
  const family = u.squashnetFamilyName?.trim();
  if (given && family) {
    const identity: MemberIdentity = { givenName: given, familyName: family };
    return { query: searchQuery(identity), identity };
  }
  return defaultIdentity(u.displayName.trim());
}

/** Écrit un rapprochement RÉUSSI, là où cette population le range. */
async function writeMatch(
  subject: Subject,
  hit: { clt: string; rang: number | null; rangM: number | null; licence: string; cat: string; club: string },
  month: string,
): Promise<void> {
  if (subject.kind === "member") {
    const data = {
      clt: hit.clt,
      rang: hit.rang,
      rangM: hit.rangM,
      licence: hit.licence,
      cat: hit.cat,
      club: hit.club,
      month,
    };
    await prisma.squashnetRanking.upsert({
      where: { userId: subject.id },
      update: data,
      create: { userId: subject.id, ...data },
    });
    return;
  }
  // Un invité n'a pas de `User` : son rapprochement vit à plat sur sa propre ligne. `rang` (le
  // rang DANS SON GENRE) n'y est pas repris — il ne sert qu'aux têtes de série du tournoi, où
  // un joueur sans compte n'apparaît jamais.
  await prisma.interclubGuest.update({
    where: { id: subject.id },
    data: {
      snClt: hit.clt,
      snRangM: hit.rangM,
      snLicence: hit.licence,
      snClub: hit.club,
      snMonth: month,
      snStatus: "matched",
      snCheckedAt: new Date(),
    },
  });
}

/** Efface un rapprochement DEVENU FAUX (le joueur a quitté le club), la correction admin intacte. */
async function clearMatch(subject: Subject): Promise<number> {
  if (subject.kind === "member") {
    const del = await prisma.squashnetRanking.deleteMany({ where: { userId: subject.id } });
    return del.count;
  }
  const upd = await prisma.interclubGuest.updateMany({
    where: { id: subject.id },
    data: {
      snClt: null,
      snRangM: null,
      snLicence: null,
      snClub: null,
      snMonth: null,
      snStatus: "moved",
      snCheckedAt: new Date(),
    },
  });
  return upd.count;
}

/**
 * Note qu'on a CHERCHÉ sans conclure. Un membre ne garde aucune trace de ce non-résultat ; un
 * invité, si — c'est ce qui permet à l'écran d'admin de dire « pas trouvable sur squashnet »,
 * donc de savoir quand la saisie manuelle est nécessaire, au lieu de laisser une ligne muette
 * qu'on ne découvre bloquante que le soir d'une rencontre.
 *
 * Best-effort, l'échec avalé : rater cette note ne compromet aucun classement, et la faire
 * compter comme `failed` mêlerait une panne cosmétique à des pertes de données réelles.
 */
async function noteAttempt(subject: Subject, status: "unknown" | "moved"): Promise<void> {
  if (subject.kind !== "guest") return;
  await prisma.interclubGuest
    .updateMany({ where: { id: subject.id }, data: { snStatus: status, snCheckedAt: new Date() } })
    .catch(() => {});
}

/**
 * Rafraîchit le classement de tous les joueurs balayés. Best-effort et NON atomique : chaque
 * joueur est indépendant. Une erreur squashnet (timeout, 5xx) → joueur `skipped` ; une erreur
 * d'écriture base → joueur `failed` (comptée à part, jamais confondue avec un souci squashnet),
 * sans interrompre le reste du lot. Renvoie `month: null` sans rien toucher si la période de
 * classement est introuvable.
 */
export async function refreshRankings(): Promise<RefreshResult> {
  const month = await getLatestMonth();
  if (!month) {
    return {
      month: null,
      members: 0,
      guests: 0,
      matched: 0,
      cleared: 0,
      skipped: 0,
      failed: 0,
      bulkMoveBlocked: false,
    };
  }

  const subjects = await subjectsToRefresh();
  const guests = subjects.filter((s) => s.kind === "guest").length;

  let matched = 0;
  let cleared = 0;
  let skipped = 0;
  let failed = 0;
  // Les effacements (`moved`) sont DIFFÉRÉS : on décide en fin de passe si le lot est crédible
  // (cf. disjoncteur ci-dessus) avant d'effacer quoi que ce soit.
  const moved: Subject[] = [];

  for (const subject of subjects) {
    // 1) Appel réseau squashnet SEUL sous try : un hoquet (timeout, 5xx) → joueur `skipped`.
    let rows: RankingRow[];
    try {
      rows = await searchRanking(subject.query, { month });
    } catch {
      skipped++;
      continue;
    }

    // 2) Verdict. On n'EFFACE que sur un signal POSITIF (« moved » : nom retrouvé uniquement
    //    hors du club) ; « pas trouvé » (page 2, ambiguïté, réponse vide) est « unknown » → rien.
    const verdict = classifyRanking(subject.identity, rows);
    if (verdict.status === "matched") {
      try {
        await writeMatch(subject, verdict.match, month);
        matched++;
      } catch {
        failed++; // panne base : imputée à la base, on continue le lot.
      }
    } else if (verdict.status === "moved") {
      moved.push(subject);
    } else {
      await noteAttempt(subject, "unknown");
      skipped++;
    }
  }

  // 3) Disjoncteur : un lot de `moved` anormalement gros trahit un souci systémique (club
  //    renommé côté squashnet), pas des départs réels → on n'efface rien ce run.
  const bulkMoveBlocked = moved.length >= BULK_MOVE_MIN && moved.length > subjects.length * BULK_MOVE_RATIO;
  if (bulkMoveBlocked) {
    skipped += moved.length; // effacements neutralisés → considérés « non concluants ».
  } else {
    for (const subject of moved) {
      try {
        cleared += await clearMatch(subject);
      } catch {
        failed++;
      }
    }
  }

  return { month, members: subjects.length, guests, matched, cleared, skipped, failed, bulkMoveBlocked };
}

/**
 * Rapproche UN joueur sans compte, tout de suite — à son inscription au roster, ou sur demande
 * de l'admin (« Re-rapprocher »). Même verdict et mêmes écritures que la passe complète : ce
 * qu'un run mensuel conclurait, ce bouton le conclut aussi.
 *
 * NE LÈVE JAMAIS. Un hoquet squashnet ne doit pas faire échouer l'inscription de l'invité :
 * l'admin le verra « pas trouvable » et saisira le classement à la main, ce qui est exactement
 * le repli prévu. Renvoie le verdict pour que l'écran le dise.
 */
export async function matchGuestRanking(guest: {
  id: string;
  name: string;
}): Promise<"matched" | "moved" | "unknown"> {
  const name = guest.name.trim();
  if (!name) return "unknown";
  const subject: Subject = { kind: "guest", id: guest.id, name, ...defaultIdentity(name) };
  try {
    const month = await getLatestMonth();
    if (!month) return "unknown";
    const rows = await searchRanking(subject.query, { month });
    const verdict = classifyRanking(subject.identity, rows);
    if (verdict.status === "matched") {
      await writeMatch(subject, verdict.match, month);
      return "matched";
    }
    // Pas de disjoncteur ici : il protège d'un EFFACEMENT EN MASSE, et il n'y a qu'un joueur.
    if (verdict.status === "moved") {
      await clearMatch(subject);
      return "moved";
    }
    await noteAttempt(subject, "unknown");
    return "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Rapproche UN membre, tout de suite — juste après qu'un admin a corrigé son nom de recherche.
 *
 * C'est le pendant de `matchGuestRanking`, et il existe pour la même raison : le mois qui
 * sépare deux passages du cron est le mois pendant lequel l'admin ne sait pas si sa correction
 * a marché. Rapprocher sur-le-champ transforme une saisie en aveugle en une réponse.
 *
 * NE LÈVE JAMAIS : un hoquet squashnet ne doit pas faire échouer l'enregistrement du nom, qui
 * est la partie qu'on veut garder. Renvoie le verdict pour que l'écran le dise.
 *
 * QUATRE ISSUES, PAS TROIS. « Introuvable » est une affirmation sur la FÉDÉRATION ; une panne
 * (squashnet muet, écriture base refusée) n'en est pas une. Les confondre fait accuser la
 * fédération d'un défaut qui est chez nous, et envoie l'admin corriger une orthographe déjà
 * juste — c'est arrivé, et ça a coûté une heure de recherche du mauvais côté.
 */
export async function refreshMemberRanking(
  userId: string,
): Promise<"matched" | "moved" | "unknown" | "error"> {
  try {
    const u = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, displayName: true, squashnetGivenName: true, squashnetFamilyName: true },
    });
    if (!u || !u.displayName.trim()) return "unknown";
    const subject: Subject = { kind: "member", id: u.id, name: u.displayName.trim(), ...memberIdentity(u) };

    const month = await getLatestMonth();
    if (!month) return "unknown";
    const rows = await searchRanking(subject.query, { month });
    const verdict = classifyRanking(subject.identity, rows);
    if (verdict.status === "matched") {
      await writeMatch(subject, verdict.match, month);
      return "matched";
    }
    // Pas de disjoncteur ici : il protège d'un EFFACEMENT EN MASSE, et il n'y a qu'un membre.
    if (verdict.status === "moved") {
      await clearMatch(subject);
      return "moved";
    }
    return "unknown";
  } catch {
    return "error";
  }
}

/**
 * Résume un run pour le heartbeat du tableau de bord. `ok` est FAUX si quelque chose cloche
 * vraiment : une écriture base a échoué, le disjoncteur a bloqué des suppressions, ou TOUS les
 * joueurs ont été ignorés (squashnet muet). Un run où rien n'a bougé mais où squashnet a
 * répondu (aucun changement de classement) reste `ok`.
 */
export function summarizeRefresh(r: RefreshResult): { ok: boolean; info: string } {
  const ok =
    r.failed === 0 && !r.bulkMoveBlocked && (r.members === 0 || r.skipped < r.members);
  const parts = [`${r.matched} rapproché(s)`, `${r.cleared} retiré(s)`, `${r.skipped} ignoré(s)`];
  // Les joueurs sans compte sont dits à part : ils sont une nouveauté de ce balayage, et c'est
  // la seule ligne qui dise à l'admin que leurs classements ont bien été cherchés.
  if (r.guests) parts.push(`dont ${r.guests} hors appli`);
  if (r.failed) parts.push(`${r.failed} échec(s) base`);
  if (r.bulkMoveBlocked) parts.push("suppression en masse BLOQUÉE");
  return { ok, info: parts.join(", ") };
}
