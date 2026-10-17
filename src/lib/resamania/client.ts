import type {
  BookResult,
  Court,
  PlanningDay,
  ResaCredentials,
  ResaIdentity,
  ResaSession,
  Slot,
} from "./types";
import { mockPlanning } from "./mock";
import { toInstant } from "@/lib/time";

/**
 * ============================================================================
 *  ADAPTATEUR RESAMANIA — point unique de contact avec l'API interne.
 *  Rétro-ingénierie validée en live (login OAuth2 + planning + réservation).
 * ============================================================================
 */

const API = process.env.RESA_API_BASE_URL ?? "https://api.resamania.com";
const TENANT = process.env.RESA_TENANT ?? "lecomplexbures";
const CLUB_ID = process.env.RESA_CLUB_ID ?? "/lecomplexbures/clubs/2345";
const ACTIVITY_ID =
  process.env.RESA_ACTIVITY_ID ?? "/lecomplexbures/activities/30592";
const CLIENT_ID = process.env.RESA_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.RESA_CLIENT_SECRET ?? "";
const REDIRECT_URI =
  process.env.RESA_REDIRECT_URI ??
  "https://member.resamania.com/lecomplexbures/";
const USE_MOCK = process.env.RESA_USE_MOCK === "1";

const AUTH_QS = `client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(
  REDIRECT_URI,
)}&response_type=code`;

// ----------------------------------------------------------------------------
//  Cookie jar minimal (le flux OAuth pose un cookie resa2_oauth qu'il faut garder)
// ----------------------------------------------------------------------------
class CookieJar {
  private jar = new Map<string, string>();
  absorb(res: Response) {
    const list: string[] = res.headers.getSetCookie?.() ?? [];
    for (const sc of list) {
      const [pair] = sc.split(";");
      const i = pair.indexOf("=");
      if (i > 0) this.jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  header() {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  get size() {
    return this.jar.size;
  }
}

// ----------------------------------------------------------------------------
//  Erreurs TYPÉES — l'appelant doit pouvoir distinguer « ResaMania dit non » de « ResaMania
//  ne répond pas », et les deux de « on ne sait pas si ResaMania a fait l'écriture ».
// ----------------------------------------------------------------------------
//
// POURQUOI. Avant, tout échec était un `Error` anonyme. Conséquence la plus grave : un 503
// passager au moment de rafraîchir le jeton passait pour un refresh token révoqué, et la
// session du membre était SUPPRIMÉE (cf. session.ts, resolveResaToken) — déconnexion forcée
// pour une panne de quelques secondes chez eux. Côté login, une panne ResaMania était comptée
// comme une tentative échouée par l'anti-brute-force.
//
// Chaque classe porte un `code` stable en plus de sa classe : les tests mockent ce module
// (vi.mock) et un `instanceof` sur une classe absente du mock lèverait ; les gardes
// `isResa…` ci-dessous ne lisent que le `code`, ce qui marche aussi à travers deux copies du
// module (bundles distincts).

/** ResaMania REFUSE l'authentification : mauvais identifiants, refresh token révoqué/expiré
 *  (400/401, `invalid_grant`). Réessayer ne changera rien : il faut se reconnecter. */
export class ResaAuthRejectedError extends Error {
  readonly code = "RESA_AUTH_REJECTED";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ResaAuthRejectedError";
  }
}

/** ResaMania INDISPONIBLE : 5xx, 429, erreur réseau, délai dépassé, réponse illisible.
 *  Passager par nature : on garde tout en l'état et on réessaiera. */
export class ResaUnavailableError extends Error {
  readonly code = "RESA_UNAVAILABLE";
  constructor(
    message: string,
    readonly status?: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ResaUnavailableError";
  }
}

/** Écriture (réservation / annulation) partie vers ResaMania SANS réponse exploitable (délai
 *  dépassé, connexion coupée) : elle a PU aboutir. Ni succès ni échec — l'appelant doit dire
 *  « vérifie le planning », surtout pas « échec, réessaie » (doublon) ni « c'est fait ». */
export class ResaOutcomeUnknownError extends Error {
  readonly code = "RESA_OUTCOME_UNKNOWN";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ResaOutcomeUnknownError";
  }
}

const codeOf = (e: unknown): unknown =>
  e && typeof e === "object" ? (e as { code?: unknown }).code : undefined;
export const isResaAuthRejected = (e: unknown): e is ResaAuthRejectedError =>
  codeOf(e) === "RESA_AUTH_REJECTED";
export const isResaUnavailable = (e: unknown): e is ResaUnavailableError =>
  codeOf(e) === "RESA_UNAVAILABLE";
export const isResaOutcomeUnknown = (e: unknown): e is ResaOutcomeUnknownError =>
  codeOf(e) === "RESA_OUTCOME_UNKNOWN";

// Timeout par requête ResaMania : sans lui, une connexion calée pend jusqu'au timeout réseau
// (~60 s) — la vue Semaine se bloque (le jour concerné doit retomber sur son snapshot, cf.
// /api/week), un login reste suspendu, et surtout un rafraîchissement de jeton garde son
// verrou (cf. session.ts) pendant tout ce temps. Avec, l'appel échoue vite en
// `ResaUnavailableError`, que les appelants traitent comme passagère.
const RESA_FETCH_TIMEOUT_MS = 8_000;
// Écritures (POST réservation / annulation) : délai PLUS LONG. Couper trop tôt une écriture
// qui aurait abouti produit un résultat inconnu — pire, pour le membre, que quelques
// secondes d'attente de plus.
const RESA_WRITE_TIMEOUT_MS = 15_000;

/** Statuts amont qui disent « réessaie plus tard » et non « non ». */
const isUpstreamDown = (status: number) => status >= 500 || status === 429;

/**
 * `fetch` vers ResaMania avec délai ; erreur réseau ou délai dépassé → `ResaUnavailableError`.
 * Le signal couvre aussi la lecture du CORPS : un corps qui n'arrive jamais rejette de même,
 * d'où `readJson` pour les lectures de corps.
 */
async function resaFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs = RESA_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    const kind = e instanceof Error ? e.name : "erreur réseau";
    throw new ResaUnavailableError(`ResaMania injoignable (${kind})`, undefined, { cause: e });
  }
}

/** Lit un corps JSON ; corps coupé, illisible ou délai dépassé = amont indisponible. */
async function readJson<T>(res: Response, what: string): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch (e) {
    throw new ResaUnavailableError(`${what} : réponse illisible`, res.status, { cause: e });
  }
}

/** Lève `ResaUnavailableError` si l'amont répond « plus tard » (5xx / 429). */
function assertUpstreamUp(res: Response, what: string): void {
  if (isUpstreamDown(res.status)) {
    throw new ResaUnavailableError(`${what} : ResaMania indisponible (${res.status})`, res.status);
  }
}

/**
 * Écriture : toute rupture APRÈS envoi possible (délai, connexion coupée) = résultat inconnu.
 * On ne cherche pas à distinguer « jamais partie » (DNS, connexion refusée) de « partie puis
 * coupée » : la cause réseau n'est pas fiable d'un runtime à l'autre, et se tromper dans le
 * sens « échec » ferait réessayer une résa peut-être déjà prise.
 */
async function resaWrite(url: string, init: RequestInit): Promise<Response> {
  try {
    return await resaFetch(url, init, RESA_WRITE_TIMEOUT_MS);
  } catch (e) {
    throw new ResaOutcomeUnknownError(
      "ResaMania n'a pas répondu à temps : résultat de l'opération inconnu",
      { cause: e },
    );
  }
}

function decodeJwt(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("access_token n'est pas un JWT");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
}

// ----------------------------------------------------------------------------
//  LOGIN — OAuth2 authorization_code (login Symfony en 2 étapes)
// ----------------------------------------------------------------------------
export async function login(creds: ResaCredentials): Promise<ResaSession> {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("RESA_CLIENT_ID / RESA_CLIENT_SECRET manquants dans .env");
  }
  const jar = new CookieJar();
  const form = (body: string) =>
    ({
      method: "POST",
      redirect: "manual" as const,
      headers: {
        cookie: jar.header(),
        "content-type": "application/x-www-form-urlencoded",
        accept: "*/*",
      },
      body,
    });

  // Chaque étape vérifie que l'amont n'est pas EN PANNE (5xx / 429) : sinon le flux se
  // terminerait « sans code » et la panne passerait pour de mauvais identifiants — comptée par
  // l'anti-brute-force de la route de login alors que le membre n'y est pour rien.

  // 1) page de login -> cookie de session
  const r1 = await resaFetch(`${API}/oauth/login/${TENANT}?${AUTH_QS}&locale=fr`, {
    redirect: "manual",
    headers: { accept: "*/*" },
  });
  assertUpstreamUp(r1, "login (page)");
  jar.absorb(r1);

  // 2) étape identifiant
  const r2 = await resaFetch(
    `${API}/oauth/login/${TENANT}?${AUTH_QS}&locale=fr`,
    form(`login_step_login[username]=${encodeURIComponent(creds.username)}`),
  );
  assertUpstreamUp(r2, "login (identifiant)");
  jar.absorb(r2);

  // 3) étape mot de passe (login_check)
  const r3 = await resaFetch(
    `${API}/${TENANT}/oauth/login_check?${AUTH_QS}`,
    form(
      `_username=${encodeURIComponent(creds.username)}&_password=${encodeURIComponent(
        creds.password,
      )}`,
    ),
  );
  assertUpstreamUp(r3, "login (mot de passe)");
  jar.absorb(r3);

  // 4) suivre les redirections jusqu'au code d'autorisation
  let loc = r3.headers.get("location");
  let code: string | null = null;
  for (let hop = 0; loc && hop < 6; hop++) {
    const m = loc.match(/[?&]code=([^&]+)/);
    if (m) {
      code = m[1];
      break;
    }
    const u = loc.startsWith("http") ? loc : API + loc;
    const r = await resaFetch(u, {
      redirect: "manual",
      headers: { cookie: jar.header(), accept: "*/*" },
    });
    assertUpstreamUp(r, "login (redirection)");
    jar.absorb(r);
    loc = r.headers.get("location");
  }
  if (!code) {
    // Amont joignable à chaque étape mais pas de code : ResaMania a renvoyé vers son
    // formulaire, c'est-à-dire refusé ces identifiants.
    throw new ResaAuthRejectedError("Identifiants invalides ou flux de connexion interrompu.");
  }

  // 5) échange code -> token, puis identité (indispensable à la réservation)
  const tokens = await exchangeToken(
    `grant_type=authorization_code&client_id=${CLIENT_ID}&client_secret=${encodeURIComponent(
      CLIENT_SECRET,
    )}&code=${code}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
  );
  const identity = await resolveIdentity(tokens.accessToken);
  return { ...tokens, identity };
}

type ResaTokens = Omit<ResaSession, "identity">;

/**
 * Appel au point d'échange OAuth (code → jetons, ou refresh → jetons). Ne résout PAS
 * l'identité : au rafraîchissement, l'appelant la possède déjà, et l'appel /contact_users
 * qu'on faisait ici était jeté (session.ts gardait l'ancienne identité) — un aller-retour
 * inutile, et surtout une occasion de plus d'échouer APRÈS que ResaMania a fait tourner le
 * refresh token, perdant le nouveau.
 *
 * Classement des échecs :
 *  - 5xx / 429 / réseau / délai / corps illisible → `ResaUnavailableError` (passager) ;
 *  - 400 / 401 → `ResaAuthRejectedError` (jeton révoqué, code expiré, `invalid_grant`…),
 *    SAUF `invalid_client` : c'est NOTRE couple RESA_CLIENT_ID/SECRET qui est refusé, pas le
 *    membre — le traiter en refus d'authentification supprimerait TOUTES les sessions au fil
 *    des rafraîchissements pour une erreur de configuration. Il est classé « indisponible » :
 *    la session est gardée, et la connexion répond 503 sans compter de tentative ;
 *  - autre statut → `Error` simple (inattendu ; les appelants ne le traitent pas en refus).
 */
async function exchangeToken(body: string): Promise<ResaTokens> {
  const res = await resaFetch(`${API}/${TENANT}/oauth/v2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    assertUpstreamUp(res, "Échange de token");
    let oauthError = "";
    try {
      oauthError = String(((await res.json()) as { error?: unknown }).error ?? "");
    } catch {
      /* corps non-JSON : on classe sur le seul statut */
    }
    if ((res.status === 400 || res.status === 401) && oauthError !== "invalid_client") {
      throw new ResaAuthRejectedError(
        `Échange de token refusé (${res.status}${oauthError ? ` ${oauthError}` : ""})`,
      );
    }
    if (oauthError === "invalid_client") {
      throw new ResaUnavailableError(
        "Échange de token : client OAuth refusé (invalid_client) — vérifier RESA_CLIENT_ID/SECRET",
        res.status,
      );
    }
    throw new Error(`Échange de token échoué (${res.status})`);
  }
  const tok = await readJson<{
    access_token: string;
    refresh_token: string;
    expires_in: number;
  }>(res, "Échange de token");
  return {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    expiresAt: Date.now() + (tok.expires_in - 60) * 1000, // marge de 60 s
  };
}

/**
 * Rafraîchit la session si le token a (presque) expiré. L'identité est CONSERVÉE telle quelle
 * (aucun appel /contact_users) : cf. `exchangeToken`. Lève `ResaAuthRejectedError` si le
 * refresh token est refusé, `ResaUnavailableError` si ResaMania ne répond pas.
 */
export async function ensureFresh(session: ResaSession): Promise<ResaSession> {
  if (Date.now() < session.expiresAt) return session;
  const tokens = await exchangeToken(
    `grant_type=refresh_token&client_id=${CLIENT_ID}&client_secret=${encodeURIComponent(
      CLIENT_SECRET,
    )}&refresh_token=${encodeURIComponent(session.refreshToken)}`,
  );
  return { ...tokens, identity: session.identity };
}

/** Déduit l'identité (contactId, etc.) à partir du JWT + d'un appel /contact_users. */
async function resolveIdentity(accessToken: string): Promise<ResaIdentity> {
  const claims = decodeJwt(accessToken) as {
    userId?: string;
    targetId?: string;
    clubId?: string;
    email?: string;
    familyName?: string;
    givenName?: string;
  };
  const contactUserId =
    claims.userId ?? String(claims.targetId ?? "").split("/").pop() ?? "";
  const cu = await apiGet<{
    contactId: string;
    familyName: string;
    givenName: string;
    email: string;
    createdAt: string;
  }>(`/contact_users/${contactUserId}`, accessToken);
  const contactNum = cu.contactId.split("/").pop();
  return {
    contactUserId,
    contactId: cu.contactId,
    contactNumber: `C${contactNum}`,
    clubId: claims.clubId ?? CLUB_ID,
    familyName: cu.familyName,
    givenName: cu.givenName,
    email: cu.email ?? claims.email ?? "",
    contactCreatedAt: cu.createdAt,
  };
}

// ----------------------------------------------------------------------------
//  Helpers API authentifiés (Bearer)
// ----------------------------------------------------------------------------
async function apiGet<T>(path: string, token: string): Promise<T> {
  const res = await resaFetch(`${API}/${TENANT}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  assertUpstreamUp(res, `GET ${path}`);
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return readJson<T>(res, `GET ${path}`);
}

// Cache des noms de courts (studios). On demande du ld+json pour obtenir les @id (IRI),
// que le format json simple omet.
let studiosCache: { iri: string; name: string }[] | null = null;
export async function getStudios(token: string): Promise<Map<string, string>> {
  if (!studiosCache) {
    const res = await resaFetch(
      `${API}/${TENANT}/studios?club=${encodeURIComponent(CLUB_ID)}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/ld+json",
        },
      },
    );
    // Ne JAMAIS mettre en cache un échec ou un résultat vide : sinon `[]` (qui n'est pas
    // null) reste en cache pour toute la durée de vie de l'instance serverless, et tous
    // les noms de terrains retombent sur leur ID numérique brut (ex. « 5382 »). On renvoie
    // une map vide pour CET appel (le planning s'affiche quand même) et on réessaiera au
    // prochain — auto-guérison dès que /studios répond à nouveau correctement.
    if (!res.ok) return new Map();
    const data = await readJson<{
      "hydra:member"?: Array<{ "@id": string; name: string }>;
    }>(res, "Studios");
    const members = data["hydra:member"] ?? [];
    if (members.length === 0) return new Map();
    studiosCache = members.map((s) => ({
      iri: s["@id"],
      name: s.name,
    }));
  }
  return new Map(studiosCache.map((s) => [s.iri, s.name]));
}

// ----------------------------------------------------------------------------
//  PLANNING
// ----------------------------------------------------------------------------
type RawEvent = {
  "@id": string;
  studio: string;
  startedAt: string;
  endedAt: string;
  attendeeRemaining: number;
  attendingLimit: number;
  bookedAttendees?: Array<{ contactId?: string }>;
};

// Cache court du planning BRUT par date (~20 s). Partagé entre requêtes et entre joueurs :
// le planning du club est identique pour tous. But : absorber les vues répétées et le
// reload-au-focus sans re-taper ResaMania à chaque fois (latence dominante). Invalidé
// explicitement sur réservation/annulation (cf. invalidatePlanningCache).
// NB serverless : cache par instance de fonction (réutilisée par Fluid Compute) ; une
// autre instance retombe sur ResaMania ou expire en ≤ 20 s — cohérence « eventual » assumée.
const PLANNING_TTL_MS = 20_000;
const planningCache = new Map<string, { at: number; data: PlanningDay }>();

/** Vide le cache planning : une date précise, ou tout le cache si `date` est omis. */
export function invalidatePlanningCache(date?: string): void {
  if (date) planningCache.delete(date);
  else planningCache.clear();
}

/**
 * Planning + d'où vient la donnée. `getPlanning` (ci-dessous) n'en rend que le planning.
 *
 * POURQUOI ces métadonnées ne sont pas DANS `PlanningDay` : /api/planning sérialise le
 * planning pour le snapshot et ne le réécrit que s'il a changé (comparaison du JSON). Un
 * horodatage dedans changerait à chaque lecture amont et ferait réécrire le gros JSON à
 * chaque affichage — exactement l'écriture que cette comparaison épargne à Neon.
 */
export interface PlanningFetch {
  planning: PlanningDay;
  /** Instant (epoch ms) où la donnée a été DEMANDÉE à ResaMania — la « photo » du planning.
   *  Pris AVANT l'appel : une écriture faite pendant l'aller-retour peut y manquer. */
  fetchedAt: number;
  /** `true` si servi par le cache mémoire : donnée vieille de ≤ 20 s, antérieure peut-être à
   *  une écriture faite entre-temps sur une AUTRE instance (dont ce cache ne sait rien). */
  fromCache: boolean;
}

/** Planning d'un jour (cf. `getPlanningWithMeta` pour l'horodatage de la donnée). */
export async function getPlanning(
  date: string,
  accessToken?: string,
  studios?: Map<string, string>,
  fresh?: boolean,
): Promise<PlanningDay> {
  return (await getPlanningWithMeta(date, accessToken, studios, fresh)).planning;
}

export async function getPlanningWithMeta(
  date: string,
  accessToken?: string,
  // Map studios pré-chargée (vue Semaine : évite 7 appels /studios concurrents).
  studios?: Map<string, string>,
  // Force un aller-retour ResaMania en ignorant le cache mémoire.
  //
  // POURQUOI c'est nécessaire : `planningCache` vit dans la mémoire du PROCESS. En
  // serverless, `invalidatePlanningCache()` appelé après une réservation ne vide que le
  // cache de l'instance qui a traité l'écriture. Le GET suivant peut atterrir sur une AUTRE
  // instance, dont le cache contient encore le planning d'avant — pendant 20 s. Le membre
  // réserve, la grille ne bouge pas, il actualise plusieurs fois, et ça finit par apparaître.
  // Le client demande donc explicitement du frais juste après avoir muté (cf. /api/planning
  // et /api/week, paramètre `fresh`). Coût : un seul appel amont de plus, au moment précis
  // où l'utilisateur attend un résultat — et surtout aucune requête base supplémentaire,
  // contrairement à un cache partagé qui pèserait sur le quota Neon.
  fresh?: boolean,
): Promise<PlanningFetch> {
  if (USE_MOCK || !accessToken) {
    return { planning: mockPlanning(date, CLUB_ID), fetchedAt: Date.now(), fromCache: false };
  }

  const cached = fresh ? undefined : planningCache.get(date);
  if (cached && Date.now() - cached.at < PLANNING_TTL_MS) {
    // Clone OBLIGATOIRE : les appelants MUTENT les slots (annotation par joueur, snapshot).
    // Servir l'objet caché tel quel polluerait le cache avec l'annotation d'un autre joueur.
    return { planning: structuredClone(cached.data), fetchedAt: cached.at, fromCache: true };
  }

  const studioMap = studios ?? (await getStudios(accessToken));
  const params = new URLSearchParams();
  params.set("club", CLUB_ID);
  params.set("activity", ACTIVITY_ID);
  params.set("order[startedAt]", "asc");
  params.set("startedAt[after]", `${date}T00:00:00`);
  params.set("startedAt[before]", `${date}T23:59:59`);
  params.set("itemsPerPage", "300");

  // Instant de la photo, pris AVANT l'appel (cf. PlanningFetch.fetchedAt) ; c'est aussi lui
  // qui date l'entrée de cache, donc le TTL court depuis la demande et non la réponse.
  const fetchedAt = Date.now();
  // On demande du ld+json : le json simple omet le champ @id (l'IRI), indispensable pour réserver.
  const res = await resaFetch(`${API}/${TENANT}/class_events?${params}`, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/ld+json",
    },
  });
  assertUpstreamUp(res, "Planning");
  if (!res.ok) throw new Error(`Planning indisponible (${res.status})`);
  const json = await readJson<{
    "hydra:member"?: RawEvent[];
  }>(res, "Planning");
  const events: RawEvent[] = Array.isArray(json)
    ? json
    : (json["hydra:member"] ?? []);

  const slots: Slot[] = events.map((e) => {
    const free = e.attendeeRemaining > 0;
    return {
      id: e["@id"],
      courtId: e.studio,
      courtName: studioMap.get(e.studio) ?? e.studio.split("/").pop() ?? "?",
      // ResaMania renvoie une heure murale sans fuseau → on la fige en instant absolu
      // (interprétée comme heure du club), sinon décalage selon où tourne le code.
      startsAt: toInstant(e.startedAt),
      endsAt: toInstant(e.endedAt),
      status: free ? "free" : "booked",
      bookable: free,
      remaining: e.attendeeRemaining,
      bookerContactId: e.bookedAttendees?.[0]?.contactId ?? null,
    };
  });

  // courts = studios présents ce jour-là, triés par nom
  const courtMap = new Map<string, Court>();
  for (const s of slots)
    if (!courtMap.has(s.courtId))
      courtMap.set(s.courtId, { id: s.courtId, name: s.courtName });
  const courts = [...courtMap.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  const result: PlanningDay = { date, clubId: CLUB_ID, courts, slots };
  // On met en cache un CLONE (l'original est renvoyé et sera muté par l'appelant).
  planningCache.set(date, { at: fetchedAt, data: structuredClone(result) });
  return { planning: result, fetchedAt, fromCache: false };
}

// ----------------------------------------------------------------------------
//  RÉSERVATION
// ----------------------------------------------------------------------------
/**
 * Réserve un créneau. Rend `{ ok: false }` sur un REFUS de ResaMania (réponse reçue), et LÈVE
 * `ResaOutcomeUnknownError` si la requête est partie sans réponse exploitable (délai de 15 s
 * dépassé, connexion coupée) : la résa a pu être prise, l'appelant doit inviter à vérifier le
 * planning plutôt qu'à réessayer.
 */
export async function book(
  session: ResaSession,
  classEventIri: string,
): Promise<BookResult> {
  const id = session.identity;
  const payload = {
    contactId: id.contactId,
    contactClubId: id.clubId,
    contactNumber: id.contactNumber,
    contactFamilyName: id.familyName,
    contactGivenName: id.givenName,
    contactCreatedAt: id.contactCreatedAt,
    classEvent: classEventIri,
  };
  const res = await resaWrite(`${API}/${TENANT}/attendees`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      "content-type": "application/json",
      // ld+json : sinon la réponse 201 omet @id (l'IRI de l'attendee, requis pour annuler)
      accept: "application/ld+json",
    },
    body: JSON.stringify(payload),
  });
  if (res.status !== 201) {
    let msg = `Réservation refusée (${res.status})`;
    try {
      const j = (await res.json()) as {
        "hydra:description"?: string;
        detail?: string;
      };
      msg = j["hydra:description"] || j.detail || msg;
    } catch {
      /* ignore */
    }
    return { ok: false, error: msg };
  }
  // 201 reçu : la résa EST prise. Si le corps n'arrive pas (délai écoulé pendant sa lecture)
  // ou est illisible, on rend quand même un succès, sans attendeeId — l'annulation sait le
  // retrouver après coup (findAttendeeId). Lever ici ferait croire à un échec une résa faite.
  try {
    const j = (await res.json()) as { "@id"?: string; state?: string };
    return { ok: true, attendeeId: j["@id"], state: j.state };
  } catch {
    return { ok: true };
  }
}

/**
 * Retrouve l'IRI de l'attendee du joueur courant pour un class_event donné.
 * Sert de rattrapage pour annuler une résa dont on n'aurait pas mémorisé l'attendeeId.
 */
export async function findAttendeeId(
  session: ResaSession,
  classEventIri: string,
): Promise<string | null> {
  // Lecture : délai ordinaire ; réseau/délai → `ResaUnavailableError` (et non `null`, qui
  // signifie « aucune résa active trouvée » et ferait conclure à tort à son absence).
  const res = await resaFetch(
    `${API}/${TENANT}/attendees?classEvent=${encodeURIComponent(classEventIri)}`,
    {
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        accept: "application/ld+json",
      },
    },
  );
  if (!res.ok) return null;
  const j = await readJson<{
    "hydra:member"?: Array<{ "@id": string; contactId?: string; state?: string }>;
  }>(res, "Attendees");
  // ResaMania conserve l'HISTORIQUE des attendees : après plusieurs cycles résa/annulation
  // sur le même créneau, plusieurs lignes coexistent pour le même contact (des "canceled"
  // + au plus une active). On IGNORE les annulées, sinon on retomberait sur une ligne déjà
  // "canceled" et l'annulation renverrait 400 (prohibited-transition cancel <- canceled).
  const mine = (j["hydra:member"] ?? []).filter(
    (a) => a.contactId === session.identity.contactId && a.state !== "canceled",
  );
  // Au plus une résa active par créneau ; en cas d'ambiguïté on prend la dernière.
  return mine.length ? mine[mine.length - 1]["@id"] : null;
}

/**
 * Annule une résa. Même contrat que `book` : `{ ok: false }` sur refus reçu,
 * `ResaOutcomeUnknownError` levée si la transition est partie sans réponse (15 s).
 */
export async function cancel(
  session: ResaSession,
  attendeeIri: string,
): Promise<BookResult> {
  // attendeeIri = "/lecomplexbures/attendees/116343527"
  // L'annulation n'est PAS un DELETE (⇒ 403) : c'est une transition de machine à états
  // (workflow Symfony). POST /attendees/{id}/transitions {"transition":"cancel"} → 201, state="canceled".
  const res = await resaWrite(`${API}${attendeeIri}/transitions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      "content-type": "application/json",
      // ld+json : API Platform renvoie alors le motif du refus dans hydra:description
      accept: "application/ld+json",
    },
    body: JSON.stringify({ transition: "cancel" }),
  });
  if (res.status >= 200 && res.status < 300) {
    let state: string | undefined;
    try {
      state = ((await res.json()) as { state?: string }).state;
    } catch {
      /* corps illisible : la transition a réussi malgré tout (2xx) */
    }
    return { ok: true, state };
  }

  // On fait remonter le vrai motif renvoyé par ResaMania (ex. délai d'annulation dépassé)
  let msg = `Annulation refusée (${res.status})`;
  try {
    const j = (await res.json()) as {
      "hydra:description"?: string;
      detail?: string;
      message?: string;
    };
    const detail = j["hydra:description"] || j.detail || j.message;
    if (detail) msg = `${detail} (${res.status})`;
  } catch {
    /* corps non-JSON : on garde le message générique */
  }
  return { ok: false, error: msg };
}
