import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Config vitest minimale : résout l'alias « @/ » (comme tsconfig `paths`) vers `src/`, pour
// que les tests puissent importer les modules qui l'utilisent (ex. tournament-db → @/lib/…).
// Les imports `import type` (ex. @prisma/client) sont retirés par esbuild → pas de résolution.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
