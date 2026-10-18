"use client";

// Détection centralisée d'une indisponibilité de la base (Neon en veille / au-delà du quota
// compute du plan Free, coupure réseau côté serveur…).
//
// Symptôme typique : une route serveur qui touche Prisma jette AVANT d'avoir pu répondre en
// JSON → réponse 500 au corps VIDE → côté client `await res.json()` lève « Unexpected end of
// JSON input », message technique illisible pour l'utilisateur. On transforme ce symptôme en un
// signal clair : on interroge /api/health (un simple `SELECT 1`, public, cf. api/health) et, si
// la base ne répond pas, on lève une MaintenanceError « lisible » ET on déclenche la bannière
// « Appli en maintenance » (cf. components/MaintenanceBanner).

export const MAINTENANCE_EVENT = "app-maintenance";

/** Erreur signalant que l'appli est (probablement) indisponible car la base ne répond pas.
 *  Son message EST le texte affiché à l'utilisateur : self-contained, sans jargon. */
export class MaintenanceError extends Error {
  constructor(
    message = "Appli momentanément en maintenance : la base de données ne répond pas. Réessaie dans quelques minutes.",
  ) {
    super(message);
    this.name = "MaintenanceError";
  }
}

/**
 * Déclenche la bannière de maintenance (best-effort, no-op côté serveur).
 * `confirmedDown` : `true` quand l'appelant a DÉJÀ confirmé via /api/health que la base est à
 * terre → la bannière s'affiche sans re-sonder. Sinon (simple soupçon, ex. un 5xx au démarrage)
 * elle confirmera elle-même avant d'apparaître, pour ne pas crier « maintenance » sur un
 * incident applicatif ponctuel sans rapport avec la base.
 */
export function reportMaintenance(confirmedDown?: boolean): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(MAINTENANCE_EVENT, { detail: { confirmed: confirmedDown === true } }),
  );
}

/**
 * Vérifie la disponibilité de la base via /api/health (`SELECT 1`). `true` = base injoignable.
 * Best-effort : au moindre doute (health elle-même KO, réseau coupé) on renvoie `true`, puisqu'on
 * n'appelle cette fonction qu'après un échec déjà suspect.
 */
export async function isDbDown(): Promise<boolean> {
  try {
    const r = await fetch("/api/health", { cache: "no-store" });
    // 404 = la route /api/health N'EXISTE PLUS (supprimée). On ne peut alors RIEN conclure sur la
    // base → on renvoie `false` pour NE PAS crier « maintenance » à tort sur chaque incident. La
    // détection via health se désactive proprement ; le reste (message lisible au login via
    // readJson, drapeau `maintenance` renvoyé par le serveur) continue de fonctionner sans elle.
    if (r.status === 404) return false;
    if (!r.ok) return true; // 503 = le SELECT 1 a échoué (base en veille/quota), ou autre non-ok
    const d = (await r.json().catch(() => null)) as { ok?: boolean } | null;
    return d?.ok === false;
  } catch {
    return true; // /api/health injoignable (réseau) → on suppose l'indisponibilité
  }
}

/**
 * Lit le corps JSON d'une réponse en distinguant une VRAIE panne de base d'une erreur applicative
 * ordinaire. À utiliser à la place de `await res.json()` là où l'on préfère afficher la bannière
 * de maintenance plutôt qu'un message technique.
 *
 * - serveur qui signale EXPLICITEMENT la panne (`503 { maintenance: true }`, cf. lib/db-error) →
 *   déclenche la bannière et lève MaintenanceError, SANS sonder /api/health : le login reste
 *   couvert même si /api/health est un jour supprimée ;
 * - corps JSON valide par ailleurs (que `res.ok` soit vrai ou non) → renvoie l'objet ; l'appelant
 *   gère `res.ok` exactement comme avant (`if (!res.ok) throw new Error(data.error …)`) ;
 * - corps illisible / vide (500 sans JSON d'une route qui a jeté avant de répondre — filet pour
 *   celles qui ne renvoient pas encore le 503 ci-dessus) → sonde /api/health : si la base est à
 *   terre, bannière + MaintenanceError ; sinon lève une erreur générique lisible.
 */
export async function readJson<T = unknown>(res: Response): Promise<T> {
  let data: T;
  try {
    data = (await res.json()) as T;
  } catch {
    if (await isDbDown()) {
      reportMaintenance(true);
      throw new MaintenanceError();
    }
    throw new Error(`Réponse inattendue du serveur (${res.status}).`);
  }
  // Le serveur a explicitement dit « base injoignable » : autoritaire, aucune sonde /api/health.
  if (res.status === 503 && (data as { maintenance?: boolean } | null)?.maintenance) {
    reportMaintenance(true);
    throw new MaintenanceError((data as { error?: string }).error);
  }
  return data;
}

/**
 * Comme `readJson`, mais LÈVE aussi sur un statut d'erreur.
 *
 * `readJson` rend le corps tel quel sur un 4xx — c'est voulu, certaines routes s'en servent —,
 * à charge pour l'appelant d'écrire `if (!res.ok) throw`. Oublier cette ligne fait passer un
 * refus du serveur pour un succès : un 409 « quelqu'un marque déjà » ouvre quand même l'écran,
 * un 403 affiche « supprimé ». Ce raccourci existe pour que l'oubli ne soit plus possible.
 */
export async function readOk<T = unknown>(res: Response): Promise<T> {
  const data = await readJson<T>(res);
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error;
    throw new Error(msg ?? `Erreur ${res.status}`);
  }
  return data;
}

// ─── APPEL COMPLET, MESSAGE TOUJOURS LISIBLE ─────────────────────────────────────────────
//
// `readJson` / `readOk` ne couvrent que la LECTURE du corps. Reste ce qui se passe AVANT : le
// `fetch` lui-même peut lever, et ce qu'il lève est écrit pour un développeur — « Failed to
// fetch » sous Chrome, « Load failed » sous Safari, « NetworkError when attempting to fetch
// resource » sous Firefox. Les écrans de réservation affichaient ce texte tel quel derrière
// « Réservation impossible : », exactement au moment où le membre, dans le parking du complexe,
// a perdu le réseau. C'est la Règle 4 de PRODUCT.md (« une panne amont se présente en français
// clair, jamais en message technique ») prise en défaut sur le chemin le plus fréquenté.
//
// D'où trois messages, et pas un de plus : chacun dit au membre QUOI FAIRE, ce qui est la seule
// chose qui l'intéresse.

/** Le `fetch` n'a pas abouti : la requête n'est jamais arrivée au serveur. */
export const NETWORK_ERROR_MESSAGE = "Pas de réseau : vérifie ta connexion et réessaie.";
/** Le serveur a répondu 5xx sans rien dire d'utile (corps vide, page HTML, JSON sans `error`). */
export const SERVICE_DOWN_MESSAGE = "Le service ne répond pas, réessaie dans un instant.";

/**
 * Échec d'un appel d'API dont le `message` EST le texte à afficher.
 *
 * `status` est conservé pour que l'appelant puisse brancher AVANT d'afficher : 401 (session
 * expirée → écran de connexion), 504 (résultat inconnu → recharger), etc. Il vaut `null` quand
 * la requête n'a jamais atteint le serveur (réseau). `code` et `data` relaient le corps quand il
 * existe — la réservation distingue ainsi le conflit « même créneau » (`code: "overlap"`).
 */
export class ApiError extends Error {
  readonly status: number | null;
  readonly code?: string;
  readonly data?: unknown;
  constructor(message: string, status: number | null, data?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
    const code = (data as { code?: unknown } | null | undefined)?.code;
    if (typeof code === "string") this.code = code;
  }
}

/** Interruption VOULUE (AbortController) : ce n'est pas une panne, on la laisse passer intacte. */
function isAbort(e: unknown): boolean {
  return (e as { name?: unknown } | null)?.name === "AbortError";
}

/**
 * Lit une réponse déjà obtenue et rend son corps JSON si elle est `ok` ; sinon lève une
 * `ApiError` au message affichable. Pour les appelants qui ont besoin du `Response` avant la
 * lecture ; les autres passent par `callApi`, qui fait aussi le `fetch`.
 *
 * - corps illisible : `readJson` a déjà sondé la base (bannière + MaintenanceError si elle est à
 *   terre — son message est gardé, il est écrit pour être lu). Sinon, un 5xx devient
 *   SERVICE_DOWN_MESSAGE ; un autre statut garde le constat de `readJson`, déjà en français ;
 * - statut d'erreur avec JSON : le `error` du serveur, qui sait pourquoi il refuse. À défaut, un
 *   5xx retombe sur SERVICE_DOWN_MESSAGE.
 */
export async function readApi<T = unknown>(res: Response): Promise<T> {
  let data: T;
  try {
    data = await readJson<T>(res);
  } catch (e) {
    if (e instanceof MaintenanceError) throw new ApiError(e.message, res.status);
    throw new ApiError(
      res.status >= 500 ? SERVICE_DOWN_MESSAGE : (e as Error).message,
      res.status,
    );
  }
  if (!res.ok) {
    const err = (data as { error?: unknown } | null)?.error;
    const message =
      typeof err === "string" && err.trim()
        ? err
        : res.status >= 500
          ? SERVICE_DOWN_MESSAGE
          : `Demande refusée par le serveur (${res.status}).`;
    throw new ApiError(message, res.status, data);
  }
  return data;
}

/**
 * LE point d'entrée : `fetch` + lecture + traduction. Rend le corps JSON d'une réponse `ok`, lève
 * une `ApiError` lisible dans tous les autres cas — réseau coupé compris. Une interruption
 * volontaire (AbortError) est relancée telle quelle : ce n'est pas à l'utilisateur de la lire.
 *
 * Usage type :
 *   try { const d = await callApi<X>("/api/…", init); … }
 *   catch (e) { if (e instanceof ApiError && e.status === 401) …; toast("err", userMessage(e)); }
 */
export async function callApi<T = unknown>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(input, init);
  } catch (e) {
    if (isAbort(e)) throw e;
    // TypeError dans tous les navigateurs, mais on ne trie pas plus finement : une exception
    // levée par `fetch` lui-même veut toujours dire que la requête n'est pas partie ou n'est
    // pas revenue — jamais que le serveur a dit non.
    throw new ApiError(NETWORK_ERROR_MESSAGE, null);
  }
  return readApi<T>(res);
}

/**
 * Le texte à montrer pour une exception attrapée, quelle qu'elle soit. Remplace
 * `(e as Error).message`, qui laissait passer le jargon du navigateur et du parseur JSON.
 *
 * - ApiError / MaintenanceError : leur message est déjà écrit pour l'utilisateur ;
 * - TypeError : un `fetch` fait à la main, hors `callApi`, a échoué → réseau ;
 * - tout le reste (bogue, exception imprévue) : `fallback`, jamais le message brut.
 */
export function userMessage(e: unknown, fallback = SERVICE_DOWN_MESSAGE): string {
  if (e instanceof ApiError || e instanceof MaintenanceError) return e.message;
  if (e instanceof TypeError) return NETWORK_ERROR_MESSAGE;
  return fallback;
}
