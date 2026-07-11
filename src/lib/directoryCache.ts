// Cache mémoire (côté client) de l'annuaire /api/directory. Deux composants le
// consomment — la modale « Annuaire » et le panneau « Réglages » (choix d'un
// délégué) — souvent l'un après l'autre. Sans cache, chaque ouverture refait un
// aller-retour réseau identique. On mémorise donc la dernière réponse pendant un
// court TTL : assez pour éviter les doublons d'une même session de navigation,
// assez court pour que l'annuaire reste frais (un nouveau membre apparaît vite).

export interface DirectoryMember {
  id: string;
  name: string;
  clt?: string;
  rang?: number | null;
  cat?: string | null;
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
