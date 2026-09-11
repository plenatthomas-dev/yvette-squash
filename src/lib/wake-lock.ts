// ============================================================================
//  EMPÊCHER L'ÉCRAN DE S'ÉTEINDRE — pendant qu'on marque, et seulement là.
//
//  LE DÉFAUT QU'IL CORRIGE. Un téléphone posé au bord du court se verrouille au
//  bout de trente secondes. Le marqueur le reprend, le déverrouille, retrouve
//  l'écran, tape le point — entre chaque échange. C'est le geste qui fait
//  abandonner le marquage au milieu du deuxième jeu, et aucune ligne de code ne
//  le montrait : l'appli, elle, fonctionnait parfaitement.
//
//  ⚠️ CE N'EST PAS UNE GARANTIE, ET ÇA NE DOIT JAMAIS EN ÊTRE UNE. Le verrou
//  peut être refusé (batterie faible, réglage du système, navigateur qui ne
//  connaît pas l'API — Firefox Android à ce jour), et il est RELÂCHÉ D'OFFICE
//  dès que l'onglet passe en arrière-plan. Rien de ce qui compte ne doit en
//  dépendre : le marquage fonctionne exactement pareil sans lui, c'est du
//  confort. D'où le silence complet sur l'échec — un message « impossible de
//  garder l'écran allumé » ne servirait qu'à inquiéter quelqu'un qui compte des
//  points.
//
//  LA REPRISE APRÈS UN RETOUR AU PREMIER PLAN est la moitié qu'on oublie. Sans
//  elle, le verrou tient jusqu'au premier appel téléphonique et ne revient
//  jamais — donc il tient pendant le premier jeu, celui où l'on regarde encore
//  l'écran, et lâche pour tous les suivants.
// ============================================================================

/** Ce que l'API rend, réduit à ce qu'on en emploie. */
interface Sentinelle {
  release(): Promise<void>;
  released?: boolean;
}

/** La partie de `navigator` qui nous intéresse — absente sur la moitié des navigateurs. */
interface AvecWakeLock {
  wakeLock?: { request(type: "screen"): Promise<Sentinelle> };
}

/**
 * Garde l'écran allumé tant que la fonction rendue n'est pas appelée.
 *
 * Rend TOUJOURS une fonction d'arrêt, même quand rien n'a pu être posé : un appelant qui
 * devrait tester le retour finirait par l'oublier, et le nettoyage d'un `useEffect` doit
 * pouvoir s'écrire en une ligne.
 *
 * `doc` et `nav` sont injectables pour les essais : jsdom ne connaît pas l'API, et un test qui
 * se contenterait de vérifier « ça ne jette pas » ne dirait rien de la reprise au premier plan,
 * qui est précisément la partie qu'on rate.
 */
export function keepAwake(
  nav: AvecWakeLock = typeof navigator === "undefined" ? {} : (navigator as AvecWakeLock),
  doc: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState"> | null =
    typeof document === "undefined" ? null : document,
): () => void {
  let sentinelle: Sentinelle | null = null;
  let arrete = false;

  const demander = () => {
    if (arrete || sentinelle || !nav.wakeLock) return;
    nav.wakeLock
      .request("screen")
      .then((s) => {
        // ARRÊTÉ ENTRE-TEMPS ? On relâche aussitôt. La demande est asynchrone : fermer l'écran
        // de marquage pendant qu'elle est en vol laisserait sinon un verrou que plus personne
        // ne tient, et l'écran du téléphone resterait allumé jusqu'à ce qu'on quitte l'appli.
        if (arrete) {
          void s.release().catch(() => {});
          return;
        }
        sentinelle = s;
      })
      .catch(() => {
        // Refusé : batterie faible, réglage système, onglet caché. On n'insiste pas et on ne
        // dit rien — le marquage n'en dépend pas.
      });
  };

  const auRetour = () => {
    // Le système relâche le verrou dès que l'onglet est caché, SANS prévenir : `sentinelle`
    // pointe alors sur un verrou mort. On le jette et on redemande — sans quoi le verrou ne
    // tiendrait que jusqu'au premier appel téléphonique.
    if (doc?.visibilityState !== "visible") return;
    if (sentinelle?.released) sentinelle = null;
    demander();
  };

  demander();
  doc?.addEventListener("visibilitychange", auRetour);

  return () => {
    arrete = true;
    doc?.removeEventListener("visibilitychange", auRetour);
    const s = sentinelle;
    sentinelle = null;
    // `release()` peut jeter si le verrou est déjà tombé de lui-même : c'est un nettoyage, il
    // n'a rien à signaler à personne.
    if (s) void s.release().catch(() => {});
  };
}
