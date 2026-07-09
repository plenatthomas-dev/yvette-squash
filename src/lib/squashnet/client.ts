// ============================================================================
//  ADAPTATEUR SQUASHNET — classement fédéral (FFSquash), source PUBLIQUE.
//  Rétro-ingénierie : le classement public est servi par un POST « AJAX » sur
//  index.php (ic_a=131079) qui renvoie un FRAGMENT HTML rendu serveur — pas
//  d'authentification, pas de cookie. On le parse sans dépendance (les classes
//  `div-rank-*` sont stables). Le parsing est isolé + testé sur fixture réelle.
// ============================================================================

const RANKING_URL = "https://www.squashnet.fr/index.php";
const RANKING_ACTION = "131079";
const UA = "Mozilla/5.0 (compatible; YvetteSquash/1.0; +https://squash-yvette.vercel.app)";
const TIMEOUT_MS = 10_000;

// Une ligne de classement telle que squashnet l'affiche. `name` est au format « NOM PRÉNOM ».
export interface RankingRow {
  name: string; // "COURTAUT JEROME"
  clt: string; // classement, ex. "5A", "NC"
  club: string; // association, ex. "Squash de l yvette"
  licence: string; // n° de licence FFSquash, ex. "0124215"
  ligue: string; // "IDF"
  cat: string; // catégorie d'âge, ex. "+55", "Senior"
  gender: string; // "male" | "female" (issu de l'icône)
  rang: string; // rang général
  rangM: string; // rang par genre
  mean: string; // moyenne de points, ex. "3 832.17"
}

// --- Parsing (PUR, exporté pour les tests) ---------------------------------

/** Retire les balises et normalise les espaces. */
function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Texte d'un champ `div-rank-<cls>` dans le HTML d'une ligne. Un div de champ ne contient
 * que des `<span>` (jamais de div imbriqué) → on capture jusqu'au premier `</div>`.
 * Le nom de classe est suivi de `'>` : « rang » ne matche donc pas « rangM ».
 */
function fieldText(rowHtml: string, cls: string): string {
  const m = rowHtml.match(new RegExp(`div-rank-${cls}'>([\\s\\S]*?)</div>`));
  return m ? stripTags(m[1]) : "";
}

/**
 * Parse le fragment HTML du classement en lignes structurées. Les lignes de données ont la
 * classe `row ranking` (l'en-tête est `ranking ranking-head`, non capturé). Robuste à 0..N
 * lignes (homonymes).
 */
export function parseRankingFragment(html: string): RankingRow[] {
  const resultsAt = html.indexOf("id='results'");
  const scope = resultsAt >= 0 ? html.slice(resultsAt) : html;
  // Découpe aux ouvertures de lignes de données ; le 1er segment (avant la 1re ligne) est ignoré.
  const segments = scope.split("<div class='row ranking'>").slice(1);
  const rows: RankingRow[] = [];
  for (const seg of segments) {
    // Coupe le segment à la pagination (queue de la dernière ligne) le cas échéant.
    const cut = seg.indexOf("<div class='div-pages'>");
    const rowHtml = cut >= 0 ? seg.slice(0, cut) : seg;
    const name = fieldText(rowHtml, "name");
    if (!name) continue;
    rows.push({
      name,
      clt: fieldText(rowHtml, "clt"),
      club: fieldText(rowHtml, "asso"),
      licence: fieldText(rowHtml, "lic"),
      ligue: fieldText(rowHtml, "ligue"),
      cat: fieldText(rowHtml, "cat"),
      gender: fieldText(rowHtml, "gender"),
      rang: fieldText(rowHtml, "rang"),
      rangM: fieldText(rowHtml, "rangM"),
      mean: fieldText(rowHtml, "mean"),
    });
  }
  return rows;
}

/**
 * Période de classement la plus récente (1re `<option>` du select `#month`), ex. "2026-07-07".
 * Le select est présent dans toute réponse, même sans résultat. Null si introuvable.
 */
export function parseLatestMonth(html: string): string | null {
  const m = html.match(/id='month'[\s\S]*?<option value='(\d{4}-\d{2}-\d{2})'/);
  return m ? m[1] : null;
}

// --- Réseau ----------------------------------------------------------------

function body(name: string, month: string | null): string {
  const params = new URLSearchParams({
    ic_a: RANKING_ACTION,
    mustache: "1",
    name,
    ligue: "0",
    category: "0",
    class: "0",
    gender: "6", // 6 = tous (on filtre ensuite par club/nom)
    assimilated: "0",
    integrated: "0",
    ic_ajax: "1",
  });
  if (month) params.set("month", month);
  return params.toString();
}

async function post(name: string, month: string | null): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(RANKING_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
        accept: "text/html, */*; q=0.01",
        "user-agent": UA,
      },
      body: body(name, month),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`squashnet POST -> ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Période de classement courante (une requête légère, sans résultat). */
export async function getLatestMonth(): Promise<string | null> {
  return parseLatestMonth(await post("", null));
}

/**
 * Recherche le classement par nom (recherche libre, format « nom prénom » toléré). `month`
 * cible une période (défaut : la plus récente). Renvoie 0..N lignes — le filtrage par club et
 * le rapprochement d'identité sont faits par la couche « matching » (ticket 2).
 */
export async function searchRanking(
  name: string,
  opts: { month?: string } = {},
): Promise<RankingRow[]> {
  const month = opts.month ?? (await getLatestMonth());
  return parseRankingFragment(await post(name, month));
}
