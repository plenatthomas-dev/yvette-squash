// Cache mémoire (côté client) de l'annuaire /api/directory. Deux composants le
// consomment — la modale « Annuaire » et le panneau « Réglages » (choix d'un
// délégué) — souvent l'un après l'autre. Sans cache, chaque ouverture refait un
// aller-retour réseau identique. On mémorise donc la dernière réponse pendant un
// court TTL : assez pour éviter les doublons d'une même session de navigation,
// assez court pour que l'annuaire reste frais (un nouveau membre apparaît vite).

export interface DirectoryMember {
  id: string;
  /**
   * « member » = compte sur l'appli ; « guest » = joueur d'une équipe interclub SANS compte
   * (`InterclubGuest`), qui joue le championnat sans avoir jamais ouvert l'appli.
   *
   * ⚠️ Ce n'est pas une étiquette d'affichage. L'annuaire les MÊLE délibérément — à l'écran un
   * joueur est un joueur — mais tout écran qui propose une action supposant un COMPTE (déléguer
   * ses droits, inscrire quelqu'un à un tournoi) doit écarter les seconds : cf.
   * `accountHolders` ci-dessous, à préférer à un filtre recopié sur place.
   *
   * Optionnel pour tolérer une réponse servie par une version antérieure du serveur (cache HTTP,
   * onglet resté ouvert pendant un déploiement) ; absent, l'entrée est un membre.
   */
  kind?: "member" | "guest";
  name: string;
  clt?: string;
  rang?: number | null; // rang dans son genre — sert au tri des têtes de série (tournoi)
  rangM?: number | null; // rang MIXTE toutes catégories — le nombre affiché/trié dans l'annuaire
  cat?: string | null;
  team?: string; // équipe interclub ("Équipe 1"…) — absent si non aligné ou fonction coupée
}

/**
 * Les seules entrées à qui l'on peut proposer une action qui suppose un compte : déléguer ses
 * droits, être inscrit à un tournoi, recevoir une notification. Un joueur sans compte figure
 * dans l'annuaire pour être TROUVÉ, pas pour être sollicité — lui tendre une action qui
 * échouerait au serveur serait une promesse en l'air.
 */
export function accountHolders(members: DirectoryMember[]): DirectoryMember[] {
  return members.filter((m) => m.kind !== "guest");
}

const TTL_MS = 60_000; // 1 min : suffisant pour dédupliquer, sans figer l'annuaire.

let cache: { at: number; members: DirectoryMember[]; groupUrl: string | null } | null = null;
// Requête en vol partagée : deux ouvertures quasi simultanées ne déclenchent
// qu'un seul fetch réseau (les deux attendent la même promesse).
let inflight: Promise<DirectoryMember[]> | null = null;

/**
 * Renvoie la liste des membres, depuis le cache si elle est récente (< TTL),
 * sinon via /api/directory. `force: true` ignore le cache (rechargement explicite).
 * Lève en cas d'erreur réseau/HTTP — l'appelant gère l'affichage (toast, etc.).
 */
export async function fetchDirectory(opts?: { force?: boolean }): Promise<DirectoryMember[]> {
  const now = Date.now();
  if (!opts?.force && cache && now - cache.at < TTL_MS) return cache.members;
  if (!opts?.force && inflight) return inflight;

  inflight = (async () => {
    try {
      const res = await fetch("/api/directory");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Erreur ${res.status}`);
      const members: DirectoryMember[] = data.members ?? [];
      const groupUrl: string | null = typeof data.groupUrl === "string" ? data.groupUrl : null;
      cache = { at: Date.now(), members, groupUrl };
      return members;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * URL d'invitation du groupe WhatsApp de l'asso (ou null si non configurée côté serveur).
 * Renseignée par le dernier `fetchDirectory` — appeler après avoir `await`é celui-ci.
 */
export function getDirectoryGroupUrl(): string | null {
  return cache?.groupUrl ?? null;
}

/** Invalide le cache (à appeler si l'annuaire a pu changer côté serveur). */
export function invalidateDirectory() {
  cache = null;
}
