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
          exclude: [...configDefaults.exclude, "src/**/*.dom.test.tsx"],
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["src/**/*.dom.test.tsx"],
          setupFiles: ["./vitest.setup.dom.ts"],
        },
        // `tsconfig.json` fixe `jsx: "preserve"` — le bon réglage pour la production, où c'est
        // le compilateur de Next qui transforme le JSX. Vite suit ce réglage et laisse alors
        // passer du JSX brut, que son analyse d'imports ne sait pas lire. Le plugin React fait
        // la transformation, et il n'est chargé QUE pour ce projet : le projet « node » n'a pas
        // une ligne de JSX à compiler.
        plugins: [react()],
      },
    ],
  },
});
