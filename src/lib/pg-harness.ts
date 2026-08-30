// HARNAIS DES TESTS SUR VRAIE BASE — ce fichier n'est pas du code d'application.
//
// Il vit dans `src/lib` parce que c'est là que sont les modules qu'il sert, et parce que
// l'alias `@/` y résout sans réglage. Rien du bundle applicatif ne l'importe.
//
// POURQUOI IL EXISTE
// Certaines promesses ne se vérifient pas avec un faux client : la concurrence, ce que Postgres
// répond, ce qu'une clause `WHERE` supprime réellement. Les tests qui les mesurent partagent
// tous le même préambule — et surtout le même GARDE-FOU. Celui-ci n'a pas le droit d'exister en
// deux exemplaires : un jour, l'une des copies perdrait la vérification de l'hôte, et un test
// écrirait dans la base de Recette (partagée avec les préviews) ou pire.
//
// ⚠️ Ces tests ÉCRIVENT. Ils refusent donc toute base qui n'est pas sur `localhost`, sauf
// `ALLOW_REMOTE_TEST_DB=1` posé en conscience.
//
// ─── COMMENT LANCER LES TESTS QUI S'EN SERVENT ────────────────────────────────
//
//   docker run --rm -d --name pg-test -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16
//   export TEST_DATABASE_URL="postgresql://postgres:test@localhost:55432/postgres"
//   DATABASE_URL="$TEST_DATABASE_URL" DIRECT_URL="$TEST_DATABASE_URL" \
//     npx prisma db push --skip-generate
//   npm run test:pg
//   docker rm -f pg-test

/** La base de test, ou la chaîne vide si le poste n'en fournit aucune. */
export const URL_TEST = (process.env.TEST_DATABASE_URL ?? "").trim();

/** À passer à `describe.skipIf` : sans base, ces tests ne peuvent rien mesurer. */
export const SANS_BASE = !URL_TEST;

function estJetable(url: string): boolean {
  if (process.env.ALLOW_REMOTE_TEST_DB === "1") return true;
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "::1";
  } catch {
    return false;
  }
}

/**
 * Vérifie la base, pose les variables d'environnement, puis rend le singleton Prisma.
 *
 * À appeler depuis un `beforeAll`. L'import de `./db` est DYNAMIQUE et vient après l'écriture
 * des variables : un import statique construirait le client avant, donc sur la mauvaise base —
 * ou jetterait « Environment variable not found » sur un poste qui n'a pas de `.env`.
 */
export async function ouvrirBaseDeTest() {
  if (!estJetable(URL_TEST)) {
    throw new Error(
      "TEST_DATABASE_URL ne pointe pas sur localhost. Ces tests ÉCRIVENT en base : vise un " +
        "Postgres jetable, ou pose ALLOW_REMOTE_TEST_DB=1 si tu sais que celle-ci l'est.",
    );
  }
  process.env.DATABASE_URL = URL_TEST;
  // Le datasource déclare aussi `directUrl` : sans elle, le client refuse de se construire sur
  // un poste sans `.env`. Même base — elle ne sert qu'aux migrations.
  process.env.DIRECT_URL = URL_TEST;
  const { prisma } = await import("./db");
  return prisma;
}

/** Promesse ouverte de l'extérieur : c'est ce qui permet d'ENTRELACER deux transactions. */
export function jalon() {
  let ouvrir!: () => void;
  const atteint = new Promise<void>((r) => (ouvrir = r));
  return { atteint, ouvrir };
}

/** Le code Prisma d'une erreur, ou son message — pour que l'échec d'un test dise quoi. */
export function codePrisma(e: unknown): string {
  const c = (e as { code?: unknown })?.code;
  return typeof c === "string" ? c : `(sans code) ${String((e as Error)?.message ?? e)}`;
}
