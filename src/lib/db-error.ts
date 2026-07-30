import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";

// Distingue une base de données INJOIGNABLE (Neon en veille / au-delà du quota compute du plan
// Free, coupure réseau serveur→base…) d'une simple erreur applicative (contrainte violée, requête
// invalide…). Sert à répondre proprement 503 « maintenance » AU LIEU de laisser la route jeter et
// renvoyer un 500 au corps vide — corps vide qui, côté client, casse `res.json()` en « Unexpected
// end of JSON input ». Rend le login autonome : il signale la maintenance SANS dépendre de
// /api/health (cf. lib/apiFetch).

// Codes Prisma de connexion impossible (≠ erreur de requête métier). P1001 « Can't reach database
// server », P1002 « timed out », P1008 « operations timed out », P1017 « server closed the
// connection ». Ce sont exactement les symptômes d'un compute Neon en veille ou coupé.
const DB_DOWN_CODES = new Set(["P1001", "P1002", "P1008", "P1017"]);

/** `true` si l'erreur traduit une base INJOIGNABLE (et non une erreur de requête métier). */
export function isDbUnavailable(e: unknown): boolean {
  if (e instanceof Prisma.PrismaClientInitializationError) return true;
  if (e instanceof Prisma.PrismaClientKnownRequestError) return DB_DOWN_CODES.has(e.code);
  // Filet pour de rares erreurs non typées. Volontairement RESTREINT à un vocabulaire propre à la
  // BASE : surtout PAS de codes réseau génériques (ECONNREFUSED/ETIMEDOUT), sinon une panne
  // ResaMania (fetch amont) serait prise à tort pour une maintenance base. Les vraies coupures
  // Neon remontent, elles, en erreurs Prisma typées (ci-dessus) ; ce filet ne sert que de secours.
  const msg = e instanceof Error ? e.message : String(e);
  return /can'?t reach database server|database server (closed|timed out|terminated)|connection pool|too many connections/i.test(
    msg,
  );
}

/**
 * Réponse 503 lisible pour le client : corps JSON avec un drapeau `maintenance` explicite. Le
 * client (readJson) l'interprète pour afficher la bannière « Appli en maintenance » et un message
 * présentable, sans avoir à sonder /api/health.
 */
export function dbUnavailableResponse() {
  return NextResponse.json(
    {
      error:
        "Appli momentanément en maintenance : la base de données ne répond pas. Réessaie dans quelques minutes.",
      maintenance: true,
    },
    { status: 503 },
  );
}
