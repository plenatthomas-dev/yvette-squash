import { NextResponse } from "next/server";

// ----------------------------------------------------------------------------
//  Réponses HTTP des pannes ResaMania — un seul texte par situation, partagé par toutes les
//  routes, pour que le membre lise la MÊME consigne quel que soit le bouton pressé.
// ----------------------------------------------------------------------------
//
// Deux situations, deux consignes OPPOSÉES, à ne jamais mélanger :
//
//  - ResaMania ne répond pas, et RIEN n'est parti chez eux (lecture, rafraîchissement du
//    jeton) → 503 « réessaie dans un instant ». Réessayer est sans danger.
//
//  - Une ÉCRITURE (réservation, annulation) est partie sans réponse → 504 « vérifie le
//    planning ». Elle a peut-être abouti : dire « réessaie » ferait prendre un 2ᵉ terrain ou
//    retenter une annulation déjà faite ; dire « échec » serait peut-être faux. Seul le
//    planning sait. Le client (lib/apiFetch, `ApiError.status === 504`) recharge la grille.
//
// Aucune ne porte `maintenance: true` : ce drapeau déclenche la bannière « base de données en
// panne » (cf. lib/apiFetch, readJson), ce qui serait faux ici — la base va bien.

/** Texte unique de la panne ResaMania passagère (rien n'a été écrit chez eux). */
export const RESA_UNAVAILABLE_MESSAGE = "ResaMania ne répond pas, réessaie dans un instant.";

/** Code machine joint au 503, pour qu'un écran puisse le distinguer d'un autre 503. */
export const RESA_UNAVAILABLE_CODE = "resa-unavailable";

/** 503 « ResaMania ne répond pas » — à n'utiliser que si AUCUNE écriture n'est partie. */
export function resaUnavailableResponse(): NextResponse {
  return NextResponse.json(
    { error: RESA_UNAVAILABLE_MESSAGE, code: RESA_UNAVAILABLE_CODE },
    // Indicatif : quelques secondes suffisent en général à un rafraîchissement de jeton.
    { status: 503, headers: { "Retry-After": "5" } },
  );
}

/**
 * 504 « résultat inconnu » après une écriture partie sans réponse. `quoi` est le sujet de la
 * phrase (« La réservation », « L'annulation ») — tous deux féminins, d'où « confirmée ».
 *
 * ⚠️ L'appelant doit AUSSI vider le cache planning (`invalidatePlanningCache`) avant de
 * répondre : le membre va regarder la grille, elle doit refléter ResaMania et non la photo
 * d'avant l'écriture. Laissé à l'appelant (et non fait ici) pour que ce module reste sans
 * dépendance vers le client ResaMania, que les tests de route remplacent.
 */
export function outcomeUnknownResponse(quoi: "La réservation" | "L'annulation"): NextResponse {
  return NextResponse.json(
    { error: `${quoi} n'a pas pu être confirmée : vérifie le planning.`, code: "outcome-unknown" },
    { status: 504 },
  );
}
