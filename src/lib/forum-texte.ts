// RENDU DU TEXTE D'UN MESSAGE, sans jamais fabriquer de HTML.
//
// Le dépôt n'a aucun échappeur HTML, et ne doit pas en gagner un pour un fil de club : ce
// serait de la surface d'attaque neuve pour un gain d'agrément. La règle tenue ici est donc
// stricte — ce module ne rend RIEN. Il découpe une chaîne en SEGMENTS de données, que le
// composant transforme en nœuds React. Il n'y a jamais de `dangerouslySetInnerHTML` au bout,
// donc jamais d'injection possible, quel que soit ce qu'un membre écrit.

/**
 * Un morceau de message : du texte nu, une adresse à rendre cliquable, ou un passage TROUVÉ
 * par la recherche.
 *
 * `trouve` est du texte, pas du balisage : le composant décide qu'il le rend en `<mark>`. La
 * règle du module ne bouge donc pas d'un pouce — on découpe, on ne rend pas.
 */
export type Segment =
  | { type: "texte"; valeur: string }
  | { type: "lien"; valeur: string }
  | { type: "trouve"; valeur: string };

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

// ============================================================================
//  LA RECHERCHE DANS LE FIL — repli sans accent, et soulignage du terme trouvé.
// ============================================================================

/** Diacritiques combinants, tels que NFD les détache de leur lettre. */
const COMBINANTS = /[̀-ͯ]/g;

/**
 * Replie une chaîne — sans accent, sans casse — EN CONSERVANT LES POSITIONS.
 *
 * `normalize()` de `squashnet/match.ts` fait presque cela, et ne convient pas ici : il compacte
 * la ponctuation et les espaces (`[^a-z0-9]+ → " "`), donc une position dans son résultat ne
 * désigne plus rien dans l'original. C'est sans conséquence pour rapprocher deux noms — son
 * emploi là-bas — mais c'est rédhibitoire pour SOULIGNER, où il faut savoir quelle tranche de
 * l'original la concordance recouvre.
 *
 * D'où le repli caractère par caractère, et la table `index` qui ramène chaque position du
 * repli vers l'octet correspondant de l'entrée. Elle compte une entrée de plus que `plie` : la
 * borne de fin, pour que `index[fin]` soit toujours lisible.
 *
 * Un caractère peut se replier en PLUSIEURS (« İ » donne « i̇ ») ; toutes ses positions
 * pointent alors le même caractère d'origine, et la tranche reste juste.
 */
export function replier(s: string): { plie: string; index: number[] } {
  let plie = "";
  const index: number[] = [];
  let position = 0;
  // Itération par POINT DE CODE (`for…of`), comme partout où ce fil découpe du texte : un
  // emoji est une seule unité pour le lecteur, et le couper en deux moitiés d'unité UTF-16
  // fabrique un caractère cassé.
  for (const c of s) {
    const f = c.normalize("NFD").replace(COMBINANTS, "").toLowerCase() || c;
    for (let k = 0; k < f.length; k++) index.push(position);
    plie += f;
    position += c.length;
  }
  index.push(s.length);
  return { plie, index };
}

/**
 * Le texte contient-il la requête, accents et casse ignorés ? Le test que la liste applique à
 * chaque message. Une requête vide ne concorde avec rien — c'est le mode « pas de recherche ».
 */
export function concorde(texte: string, requete: string): boolean {
  const q = replier(requete).plie.trim();
  return q !== "" && replier(texte).plie.includes(q);
}

/**
 * Découpe les segments de TEXTE sur les occurrences de la requête, en marquant les passages
 * trouvés. Les segments de lien ressortent intacts : une adresse coupée en deux n'est plus une
 * adresse cliquable, et c'est un prix qu'un surlignage ne vaut pas.
 *
 * Sans cela, un message de mille caractères remonté par la recherche ne dit pas POURQUOI il
 * remonte, et il faut le relire en entier — soit exactement le travail que la recherche était
 * censée éviter.
 *
 * Invariant repris de `segmenter` : une requête vide, ou qui ne concorde nulle part, rend les
 * segments STRICTEMENT inchangés.
 */
export function souligner(segments: Segment[], requete: string): Segment[] {
  const q = replier(requete).plie.trim();
  if (q === "") return segments;
  const out: Segment[] = [];
  for (const seg of segments) {
    if (seg.type !== "texte") {
      out.push(seg);
      continue;
    }
    const { plie, index } = replier(seg.valeur);
    let curseur = 0; // position dans le REPLI
    let trouve = plie.indexOf(q);
    if (trouve < 0) {
      out.push(seg);
      continue;
    }
    while (trouve >= 0) {
      if (trouve > curseur) {
        out.push({ type: "texte", valeur: seg.valeur.slice(index[curseur], index[trouve]) });
      }
      const fin = trouve + q.length;
      out.push({ type: "trouve", valeur: seg.valeur.slice(index[trouve], index[fin]) });
      curseur = fin;
      trouve = plie.indexOf(q, curseur);
    }
    if (curseur < plie.length) {
      out.push({ type: "texte", valeur: seg.valeur.slice(index[curseur]) });
    }
  }
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
