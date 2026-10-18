// Envoie au serveur l'erreur qu'un membre vient de voir (cf. api/client-error). `keepalive` :
// la requête survit au rechargement que la page d'erreur propose juste après. Ne lève jamais.
export function reportClientError(error: { message?: string; digest?: string }): void {
  try {
    void fetch("/api/client-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: String(error?.message ?? "erreur inconnue").slice(0, 500),
        digest: error?.digest,
        path: typeof location !== "undefined" ? location.pathname + location.search : undefined,
      }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* rien : un écran d'erreur ne doit pas en produire une seconde */
  }
}
