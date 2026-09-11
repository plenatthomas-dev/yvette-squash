import { NextRequest, NextResponse } from "next/server";
import { requireCaptain, requireCaptainOf } from "@/lib/captain-access";
import { prisma } from "@/lib/db";
import { loadRosters, refreshRosters } from "@/lib/interclub-roster-db";
import { getLatestMonth, searchRanking, type RankingRow } from "@/lib/squashnet/client";
import { YVETTE_CLUB } from "@/lib/squashnet/match";
import {
  checkAwayOrder,
  checkPlayer,
  clubOfTeam,
  checkScore,
  checkTie,
  lireRapport,
  playerFromRoster,
  queryTerms,
  type CheckReport,
  type MatchInput,
  type PlayerCheck,
} from "@/lib/captain-check";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// GET  /api/captain/check/{id} — relit le dernier rapport, sans toucher à squashnet.
// POST /api/captain/check/{id} — REFAIT la vérification, et la range.
//
// DEUX VERBES, ET LA DIFFÉRENCE EST LE COÛT. Relire est gratuit et instantané ; vérifier appelle
// la fédération jusqu'à huit fois. Servir les deux sous un GET ferait payer ce prix à chaque
// ouverture d'écran, et à quelqu'un qui ne fait que relire son rapport de la veille.
//
// LE DÉBIT, ET POURQUOI IL EST MÉNAGÉ. Une rencontre = quatre simples × deux joueurs. On
// mémoïse par TERME DE RECHERCHE (le nom de famille) — deux joueurs homonymes partagent la
// réponse — et on espace les appels, exactement comme le remplissage de l'historique
// (`squashnet/backfill.ts`). squashnet est un site associatif qui ne nous doit rien : rester
// invisible chez eux est la condition pour que tout ceci continue d'exister.

/**
 * Délai entre deux appels. Plus court que celui du script de remplissage (1,1 s) : ici le
 * capitaine attend devant son écran et il y a huit appels au plus, pas neuf cents.
 */
const DELAI_MS = 600;

const dodo = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Le club attendu pour ce joueur : le nôtre, ou celui d'en face.
 *
 * `Interclub.opponent` porte un nom d'ÉQUIPE (« Chaville 4 »), le classement range sous le CLUB
 * (« Chaville ») : d'où `clubOfTeam`, sans quoi aucun adversaire d'une équipe numérotée n'est
 * jamais trouvé.
 *
 * `clubRoster` l'emporte quand on l'a : la fiche d'équipe fédérale PUBLIE le nom du club
 * (« Squash club verrieres le buisson »), là où `clubOfTeam` ne peut que le déduire en retirant
 * un numéro à un nom d'équipe. La déduction marche sur « Chaville 4 » → « Chaville » ; elle ne
 * peut rien contre un libellé d'équipe qui n'est pas le début du nom de club, et rien ne nous
 * avertirait — le joueur serait simplement déclaré « autre club ».
 */
const clubAttendu = (side: "home" | "away", opponent: string, clubRoster: string | null) =>
  side === "home" ? YVETTE_CLUB : (clubRoster ?? clubOfTeam(opponent));

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // ⚠️ LA GARDE D'ABORD, LA BASE ENSUITE. On lisait la rencontre AVANT tout contrôle, pour en
  // tirer l'équipe dont `requireCaptainOf` a besoin. Deux conséquences, toutes deux réelles :
  //
  //  * une requête anonyme déclenchait une lecture Neon, fonction coupée ou non — `requireCaptain`
  //    documente pourtant qu'un flag coupé répond 404 « sans lire la base » ;
  //  * l'écart des réponses RÉVÉLAIT l'existence d'une rencontre : 401 si elle existe, 404 sinon.
  //    Un visiteur non connecté pouvait ainsi énumérer des identifiants.
  //
  // `requireCaptain` ne demande pas d'équipe : il applique flag → session → rôle. La portée
  // précise (CETTE équipe) reste vérifiée après lecture, par `requireCaptainOf`.
  const porte = await requireCaptain(req);
  if (!porte.ok) return porte.response;

  const fixture = await prisma.interclub.findUnique({
    where: { id },
    select: { teamId: true, official: { select: { checkJson: true } } },
  });
  // L'accès se contrôle sur l'ÉQUIPE de la rencontre, donc il faut d'abord la lire. Une
  // rencontre inconnue sort en 404 sans rien révéler de plus.
  if (!fixture) return NextResponse.json({ error: "Rencontre introuvable" }, { status: 404 });
  const access = await requireCaptainOf(req, fixture.teamId);
  if (!access.ok) return access.response;

  return NextResponse.json({ report: lireRapport(fixture.official?.checkJson ?? null) });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // ⚠️ LA GARDE D'ABORD, LA BASE ENSUITE. On lisait la rencontre AVANT tout contrôle, pour en
  // tirer l'équipe dont `requireCaptainOf` a besoin. Deux conséquences, toutes deux réelles :
  //
  //  * une requête anonyme déclenchait une lecture Neon, fonction coupée ou non — `requireCaptain`
  //    documente pourtant qu'un flag coupé répond 404 « sans lire la base » ;
  //  * l'écart des réponses RÉVÉLAIT l'existence d'une rencontre : 401 si elle existe, 404 sinon.
  //    Un visiteur non connecté pouvait ainsi énumérer des identifiants.
  //
  // `requireCaptain` ne demande pas d'équipe : il applique flag → session → rôle. La portée
  // précise (CETTE équipe) reste vérifiée après lecture, par `requireCaptainOf`.
  const porte = await requireCaptain(req);
  if (!porte.ok) return porte.response;

  const fixture = await prisma.interclub.findUnique({
    where: { id },
    select: {
      teamId: true,
      opponent: true,
      snOpponentTeamId: true,
      matchCount: true,
      bestOf: true,
      matches: {
        orderBy: { order: "asc" },
        select: {
          order: true,
          homeDisplayName: true,
          awayName: true,
          games: { orderBy: { number: "asc" }, select: { pointsHome: true, pointsAway: true } },
        },
      },
    },
  });
  if (!fixture) return NextResponse.json({ error: "Rencontre introuvable" }, { status: 404 });
  const access = await requireCaptainOf(req, fixture.teamId);
  if (!access.ok) return access.response;

  // --- Les scores : purs, immédiats, aucun réseau -------------------------
  const entrees: MatchInput[] = fixture.matches.map((m) => ({
    order: m.order,
    homeDisplayName: m.homeDisplayName,
    awayName: m.awayName,
    // `bestOf` vit sur la RENCONTRE, pas sur le simple : le format est celui de la division.
    bestOf: fixture.bestOf,
    games: m.games.map((g) => ({ home: g.pointsHome, away: g.pointsAway })),
  }));
  const scores = entrees.map(checkScore);
  const tie = checkTie(scores, fixture.matchCount);

  // --- Les noms : c'est là que le réseau entre en jeu ---------------------
  //
  // LA PÉRIODE EST LUE UNE SEULE FOIS. `searchRanking(nom)` sans mois va la chercher lui-même,
  // ce qui doublerait le nombre d'appels — seize au lieu de huit, pour une valeur identique
  // huit fois de suite.
  let month: string | null;
  try {
    month = await getLatestMonth();
  } catch {
    month = null;
  }
  if (!month) {
    return NextResponse.json(
      { error: "squashnet est injoignable : la vérification des noms est impossible pour l'instant." },
      { status: 502 },
    );
  }

  const memo = new Map<string, RankingRow[] | null>();
  let premier = true;
  /** Une recherche, mémoïsée par TERME — l'échec l'est aussi (cf. `backfill.rechercher`). */
  async function lignes(query: string): Promise<RankingRow[] | null> {
    const cached = memo.get(query);
    if (cached !== undefined) return cached;
    // L'attente PRÉCÈDE l'appel plutôt qu'elle ne le suit : le dernier joueur du lot ne fait pas
    // patienter une demi-seconde pour rien avant de rendre la main.
    if (!premier) await dodo(DELAI_MS);
    premier = false;
    let rows: RankingRow[] | null;
    try {
      rows = await searchRanking(query, { month: month as string });
    } catch {
      rows = null;
    }
    memo.set(query, rows);
    return rows;
  }

  // LE ROSTER DE L'ÉQUIPE ADVERSE, LU EN BASE — aucune requête fédérale, et il répond pour la
  // moitié des joueurs de la rencontre.
  //
  // ⚠️ IL PASSE AVANT LA RECHERCHE PAR NOM, ET C'EST UNE CORRECTION, pas une optimisation. Le
  // rapprochement interroge le classement NATIONAL et retient une ligne si une seule colle au
  // club attendu : sur un nom un peu porté il tombe sur un homonyme d'un autre club et rend
  // `other-club` — « rattaché à l'Association sportive du squash club de Valence : vérifie le
  // nom du club adverse ». Le nom du club était juste, le joueur bien là, et le capitaine
  // envoyé corriger ce qui n'avait rien.
  //
  // Le roster ne peut pas se tromper ainsi : il ne contient QUE les joueurs que ce club a
  // inscrits dans CETTE équipe. Pas de sélection à faire, donc pas de mauvaise sélection — et
  // la licence vient avec, qui est ce que le capitaine recopie.
  //
  // LA VÉRIFICATION GARANTIT SON PROPRE ROSTER au lieu d'espérer que quelqu'un l'ait chargé.
  // L'ouverture d'une rencontre dans Interclub le rafraîchit déjà, mais rien ne dit qu'elle ait
  // eu lieu : une rencontre composée avant que cette fonction n'existe n'a jamais déclenché ce
  // chemin, et le capitaine retomberait sur la recherche par nom — donc sur l'homonyme.
  //
  // Le coût est nul à l'échelle de ce que fait déjà ce verbe : `refreshRosters` ne sort que si
  // le roster manque ou date de plus d'une semaine, et quand il sort il ÉCONOMISE les quatre
  // recherches qu'il remplace. Une vérification est plus rapide avec lui que sans.
  if (fixture.snOpponentTeamId) {
    try {
      await refreshRosters([fixture.snOpponentTeamId]);
    } catch {
      // Best-effort : une vérification doit pouvoir aboutir sur ce qu'on a déjà. L'échec se
      // verra de toute façon, joueur par joueur, dans les verdicts du rapport.
    }
  }
  const rosters = fixture.snOpponentTeamId
    ? await loadRosters([fixture.snOpponentTeamId])
    : new Map();
  const rosterAdverse = fixture.snOpponentTeamId
    ? (rosters.get(fixture.snOpponentTeamId) ?? null)
    : null;

  const players: PlayerCheck[] = [];
  for (const m of entrees) {
    for (const side of ["home", "away"] as const) {
      const name = side === "home" ? m.homeDisplayName : m.awayName;

      // Inscrit dans l'équipe d'en face : la ligue l'a nommé elle-même, il n'y a rien à
      // chercher — et une requête de moins à leur coûter.
      if (side === "away") {
        const duRoster = playerFromRoster(m.order, name, rosterAdverse);
        if (duRoster) {
          players.push(duRoster);
          continue;
        }
      }

      const club = clubAttendu(side, fixture.opponent, rosterAdverse?.club ?? null);

      // DEUX TERMES POSSIBLES, ESSAYÉS DANS L'ORDRE (cf. `queryTerms`) : le nom de famille est
      // le seul terme que squashnet exploite, et il est tantôt le dernier mot (ordre français,
      // « Xavier Detry »), tantôt le premier (ordre fédéral, « DETRY XAVIER »). Rien dans la
      // chaîne ne dit lequel.
      //
      // ON S'ARRÊTE AU PREMIER QUI RAPPROCHE : sur un nom en ordre français — le cas courant,
      // et celui de tous nos joueurs — le second appel n'a jamais lieu. Il ne coûte donc que
      // dans le cas qui, sans lui, rendait « introuvable » un nom parfaitement juste.
      let issue: PlayerCheck | null = null;
      let muet = false;
      for (const terme of queryTerms(name)) {
        const rows = await lignes(terme);
        // squashnet muet sur CE terme : on retient le silence, mais on tente quand même l'autre
        // — une panne sur une recherche n'est pas une panne sur l'autre.
        if (rows === null) {
          muet = true;
          continue;
        }
        const essai = checkPlayer(m.order, side, name, rows, club);
        // Le premier verdict est gardé faute de mieux ; un verdict CONCLUANT arrête tout.
        issue = issue ?? essai;
        // ⚠️ `other-club` EST CONCLUANT, au même titre que `found` : le joueur a été identifié
        // par son nom, simplement ailleurs. Le rechercher sous l'autre terme ne peut rien
        // apprendre de plus et ferait payer à squashnet une requête pour une réponse acquise.
        // Seul `unknown` — personne de ce nom, ou homonymes ambigus — justifie le second essai.
        if (essai.verdict !== "unknown") {
          issue = essai;
          break;
        }
      }

      // Aucune réponse exploitable : on ne conclut rien plutôt que d'annoncer « introuvable »,
      // qui enverrait corriger une orthographe parfaitement juste.
      if (issue === null || (muet && issue.verdict !== "found")) {
        players.push({
          order: m.order,
          side,
          name,
          verdict: "unknown",
          fedName: null,
          clt: null,
          rangM: null,
          licence: null,
          club: null,
          hint: "squashnet n'a pas répondu pour ce nom. Relance la vérification dans un moment.",
        });
        continue;
      }
      players.push(issue);
    }
  }

  const report: CheckReport = {
    checkedAt: new Date().toISOString(),
    players,
    scores,
    tie,
    // L'ordre d'en face se déduit des joueurs qu'on vient de rapprocher — aucun appel de plus.
    awayOrder: checkAwayOrder(players),
  };

  // Une rencontre, un rapport : relancer CORRIGE au lieu d'empiler. L'écran n'a donc jamais à
  // choisir entre deux versions, et le rapport affiché est toujours le dernier connu.
  const data = { checkedAt: new Date(report.checkedAt), checkJson: JSON.stringify(report) };
  await prisma.interclubOfficial.upsert({
    where: { interclubId: id },
    update: data,
    create: { interclubId: id, ...data },
  });

  return NextResponse.json({ report });
}
