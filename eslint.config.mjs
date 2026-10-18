// Configuration ESLint « plate » (ESLint 9) — remplace .eslintrc.json depuis le passage à
// Next 16, qui a supprimé `next lint` (audit 2026-10, point 31). Mêmes règles qu'avant.
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const config = [
  ...nextVitals,
  ...nextTs,
  {
    ignores: [".next/**", "node_modules/**", "android/**", "public/**", ".claude/**", "next-env.d.ts"],
  },
  {
    rules: {
      // Règles du React Compiler, arrivées avec eslint-plugin-react-hooks 7 (Next 16). Le
      // projet n'utilise pas le compilateur : ces motifs (setState de synchronisation dans un
      // effet, ref tenue à jour pendant le rendu, Date.now() au rendu) y sont sûrs et voulus,
      // et `next lint` (Next 15) ne les signalait pas. Les adopter serait un chantier à part —
      // `exhaustive-deps` et `rules-of-hooks`, eux, restent actifs.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
      "react-hooks/purity": "off",
      "react-hooks/immutability": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react/no-unescaped-entities": "off",
      "@next/next/no-img-element": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
];

export default config;
