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
//
// POURQUOI UN MODULE À PART (et non plus dans client.ts, qui les ré-exporte toujours) : les
// routes qui TRADUISENT ces erreurs en réponses HTTP importent les gardes d'ici. Or presque
// tous les tests de route remplacent `@/lib/resamania/client` par une fabrique qui ne fournit
// que `book`, `getPlanning`… : une garde importée de client.ts y serait absente, et le chemin
// d'erreur — celui qu'on veut justement tester — lèverait « No export defined on the mock ».
// Ce module-ci n'a aucune dépendance (ni réseau, ni base) : personne n'a de raison de le mocker.

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

/**
 * Échec PASSAGER de la résolution du jeton ResaMania d'une session : un autre processus
 * rafraîchit encore (attente épuisée), ou ResaMania est indisponible au moment du
 * rafraîchissement (5xx, 429, réseau, délai). Dans les deux cas la session est CONSERVÉE — la
 * requête suivante réessaiera. Levée par session.ts (`resolveResaToken`), qui la ré-exporte.
 *
 * Elle vit ici, avec les autres, pour la même raison qu'elles : les crons et les routes la
 * reconnaissent par `isResaRefreshTransient` (lecture du `code`) alors que leurs tests
 * remplacent `@/lib/session` par une fabrique réduite à `getResaTokenForUser`.
 */
export class ResaRefreshTransientError extends Error {
  readonly code = "RESA_REFRESH_TRANSIENT";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ResaRefreshTransientError";
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
export const isResaRefreshTransient = (e: unknown): e is ResaRefreshTransientError =>
  codeOf(e) === "RESA_REFRESH_TRANSIENT";
