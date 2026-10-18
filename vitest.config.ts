import { defineConfig, configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// Config vitest : résout l'alias « @/ » (comme tsconfig `paths`) vers `src/`, pour
// que les tests puissent importer les modules qui l'utilisent (ex. tournament-db → @/lib/…).
// Les imports `import type` (ex. @prisma/client) sont retirés par esbuild → pas de résolution.
//
// DEUX PROJETS, ET C'EST DÉLIBÉRÉ. L'écrasante majorité des tests sont des tests de modules :
// ils n'ont aucun DOM à toucher, et tourner sous `jsdom` leur coûterait un document complet
// par fichier pour rien. Seuls les tests de composants — suffixés `.dom.test.tsx`, le nom dit
// dans quel monde ils tournent — paient ce prix.
//
// `extends: true` fait hériter chaque projet de la config racine, donc de l'alias ci-dessus :
// il n'est écrit qu'une fois. (`environmentMatchGlobs`, qui rendait ce service en une ligne,
// n'existe plus depuis vitest 4.)
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/*.test.{ts,tsx}"],
          // Les défauts (node_modules, dist…) ne se remplacent pas, ils se complètent.
          exclude: [...configDefaults.exclude, "src/**/*.dom.test.{ts,tsx}"],
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          // `.ts` autant que `.tsx` : un module peut avoir besoin d'un DOM sans être un
          // composant — `onForeground` s'abonne à `focus`, `visibilitychange` et `pageshow`,
          // et n'a pas une ligne de JSX. C'est le suffixe `.dom.` qui dit le monde, pas
          // l'extension.
          include: ["src/**/*.dom.test.{ts,tsx}"],
          setupFiles: ["./vitest.setup.dom.ts"],
        },
        // Le JSX est transformé par le plugin React, chargé QUE pour ce projet : le projet
        // « node » n'a pas une ligne de JSX à compiler. (Next 16 impose `jsx: "react-jsx"` dans
        // tsconfig.json ; sous Next 15 c'était `preserve`, que Vite laissait passer brut.)
        plugins: [react()],
      },
    ],
  },
});
