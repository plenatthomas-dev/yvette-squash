import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
//  UN FICHIER `route.ts` N'EXPORTE QUE CE QUE NEXT CONNAÎT.
//
//  App Router valide les exports d'un module de route : les verbes HTTP, et
//  une poignée d'options de segment. Tout autre `export` est une erreur de
//  BUILD — « <nom> is not a valid Route export field ».
//
//  Pourquoi ce fichier existe : cette règle appartient au framework, pas au
//  langage. `tsc --noEmit` ne la connaît pas, `eslint` non plus, la suite de
//  tests encore moins. Une fonction utilitaire exportée depuis une route passe
//  donc les trois portes locales et ne casse qu'au `next build` — c'est-à-dire
//  sur Vercel, après un push, ce qui est le pire endroit pour l'apprendre.
//  C'est exactement ce qui est arrivé à `describeDiff`, exportée depuis
//  `admin/interclub-calendar/route.ts` : elle vit désormais dans
//  `lib/squashnet/calendar.ts`, à côté du diff qu'elle décrit.
//
//  La parade n'est pas « y penser » : c'est cette vérification, qui coûte
//  quelques millisecondes et parle la même langue que l'erreur de build.
// ============================================================================

/**
 * Ce qu'App Router accepte à l'export d'une route. La liste des options de segment est plus
 * large que ce que ce projet utilise ; on la garde complète pour que l'ajout légitime de
 * `revalidate` ou `preferredRegion` demain ne fasse pas échouer ce test à tort.
 */
const AUTORISES = new Set([
  // Les verbes.
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "OPTIONS",
  // Les options de segment.
  "dynamic",
  "dynamicParams",
  "revalidate",
  "fetchCache",
  "runtime",
  "preferredRegion",
  "maxDuration",
  "generateStaticParams",
]);

/** Tous les `route.ts` de l'application, quel que soit leur niveau d'imbrication. */
function routeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) routeFiles(full, out);
    else if (entry === "route.ts" || entry === "route.tsx") out.push(full);
  }
  return out;
}

/** Les noms exportés d'un module, lus à la source — pas d'import, donc pas d'effet de bord. */
function exportedNames(src: string): string[] {
  const noms: string[] = [];
  // `export const x`, `export function x`, `export async function x`, `export class x`.
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:const|let|var|function|class)\s+(\w+)/gm)) {
    noms.push(m[1]);
  }
  // `export { a, b as c }` — la forme qui échappe le plus facilement à la relecture.
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(",")) {
      const nom = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (nom) noms.push(nom);
    }
  }
  return noms;
}

describe("les fichiers de route n'exportent que ce que Next accepte", () => {
  const fichiers = routeFiles("src/app");

  it("en trouve, sinon ce test ne mesure rien", () => {
    // Un test qui parcourt le disque doit prouver qu'il a bien parcouru quelque chose : un
    // chemin devenu faux le rendrait vert et muet.
    expect(fichiers.length).toBeGreaterThan(20);
  });

  it.each(fichiers)("%s", (fichier) => {
    // `type` et `interface` exportés sont effacés à la compilation et ne gênent pas Next : la
    // lecture ci-dessus ne les capte pas, et c'est voulu.
    const interdits = exportedNames(readFileSync(fichier, "utf8")).filter((n) => !AUTORISES.has(n));
    expect(interdits).toEqual([]);
  });
});
