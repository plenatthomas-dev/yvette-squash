// RENDU DU TEXTE D'UN MESSAGE, sans jamais fabriquer de HTML.
//
// Le dépôt n'a aucun échappeur HTML, et ne doit pas en gagner un pour un fil de club : ce
// serait de la surface d'attaque neuve pour un gain d'agrément. La règle tenue ici est donc
// stricte — ce module ne rend RIEN. Il découpe une chaîne en SEGMENTS de données, que le
// composant transforme en nœuds React. Il n'y a jamais de `dangerouslySetInnerHTML` au bout,
// donc jamais d'injection possible, quel que soit ce qu'un membre écrit.

/** Un morceau de message : du texte nu, ou une adresse à rendre cliquable. */
export type Segment = { type: "texte"; valeur: string } | { type: "lien"; valeur: string };

// UNIQUEMENT http(s). C'est ce qui écarte `javascript:`, `data:` et `vbscript:` — non par un
// filtre qui pourrait être contourné, mais parce qu'ils ne sont jamais reconnus au départ.
const LIEN = /https?:\/\/[^\s<>"']+/gi;

// Ponctuation de FIN de phrase, à rendre au texte : « regarde https://exemple.fr. » ne doit
// pas produire un lien qui avale le point. La parenthèse fermante est traitée à part.
const QUEUE = /[.,;:!?»"'’]+$/;

/** Retire d'une adresse la ponctuation qui appartenait à la phrase, pas à l'URL. */
function rogner(url: string): string {
  let u = url.replace(QUEUE, "");
  // Une parenthèse fermante finale n'est retirée que si elle n'est pas ouverte dans l'URL :
  // les adresses de wikipédia (« …_(homonymie) ») sont légitimes et se cassent sinon.
  while (u.endsWith(")") && (u.match(/\(/g) ?? []).length < (u.match(/\)/g) ?? []).length) {
    u = u.slice(0, -1).replace(QUEUE, "");
  }
  return u;
}

/**
 * Découpe un message en segments. Un texte SANS adresse ressort en un seul segment,
 * strictement identique à l'entrée — c'est l'invariant qui garantit qu'on n'abîme jamais
 * un message ordinaire en cherchant des liens dedans.
 */
export function segmenter(texte: string): Segment[] {
  // La chaîne vide est un TEXTE SANS ADRESSE comme un autre. L'invariant juste au-dessus dit
  // « un seul segment, strictement identique à l'entrée » ; la boucle rendait `[]`, et c'était
  // le seul cas où le module se contredisait. Sans conséquence à l'écran, mais un invariant
  // vrai à 99 % ne sert pas d'invariant.
  if (texte === "") return [{ type: "texte", valeur: "" }];
  const out: Segment[] = [];
  let curseur = 0;
  for (const m of texte.matchAll(LIEN)) {
    const brut = m[0];
    const url = rogner(brut);
    // L'adresse s'est réduite à son schéma seul (« https://. ») : ce n'est pas un lien.
    if (!/^https?:\/\/[^/\s]/i.test(url)) continue;
    const debut = m.index;
    if (debut > curseur) out.push({ type: "texte", valeur: texte.slice(curseur, debut) });
    out.push({ type: "lien", valeur: url });
    curseur = debut + url.length;
  }
  if (curseur < texte.length) out.push({ type: "texte", valeur: texte.slice(curseur) });
  return out;
}

/** « Aujourd'hui », « Hier », sinon « mardi 2 septembre » — l'en-tête d'un groupe de messages. */
export function libelleJour(iso: string, maintenant = new Date()): string {
  const d = new Date(iso);
  const jour = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const ecart = Math.round((jour(maintenant) - jour(d)) / 86_400_000);
  if (ecart === 0) return "Aujourd'hui";
  if (ecart === 1) return "Hier";
  const long = d.toLocaleDateString("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    // L'année n'apparaît que si elle diffère : « samedi 3 janvier » se lit mieux que
    // « samedi 3 janvier 2026 » quand on est en 2026, et la purge à 12 mois fait que
    // l'ambiguïté d'une année à l'autre ne peut pas se produire.
    ...(d.getFullYear() === maintenant.getFullYear() ? {} : { year: "numeric" }),
  });
  return long.charAt(0).toUpperCase() + long.slice(1);
}

/** Deux instants tombent-ils le même jour civil ? Sert à poser les séparateurs. */
export function memeJour(a: string, b: string): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getDate() === y.getDate() &&
    x.getMonth() === y.getMonth() &&
    x.getFullYear() === y.getFullYear()
  );
}
