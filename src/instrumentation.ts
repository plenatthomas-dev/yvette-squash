// Hook serveur de Next.js : chaque erreur non rattrapée d'une route ou d'un rendu passe ici.
// On la garde en base (cf. lib/error-report) : les logs du plan Hobby ne vivent qu'environ une
// heure. Import DYNAMIQUE : ce fichier est aussi chargé par le runtime Edge (middleware), qui
// ne doit pas embarquer Prisma.

export async function register() {}

export async function onRequestError(
  err: unknown,
  request: { path: string },
  context: { routerKind: string; routeType: string },
) {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { recordError } = await import("./lib/error-report");
    const e = err as { message?: string; digest?: string };
    await recordError({
      source: "server",
      message: `${context.routeType} : ${e?.message ?? String(err)}`,
      digest: e?.digest,
      path: request.path,
    });
  } catch {
    /* le suivi ne doit jamais produire une seconde erreur */
  }
}
