import { describe, it, expect } from "vitest";
import { CLASS_EVENT_IRI, isClassEventId } from "./validation";

// CETTE EXPRESSION EST LA SEULE BARRIÈRE entre le corps d'une requête et l'IRI que /book et
// /cancel-slot transmettent à ResaMania. Or les tests de ces routes la remplacent par un bouchon
// permissif (cf. api/book/route.test.ts) : sans ce fichier, la règle réelle n'était vérifiée
// nulle part, et un assouplissement par mégarde — un `.` à la place de `\/`, une ancre oubliée —
// serait passé sans un seul test rouge.
//
// Ce qu'elle doit empêcher : qu'une valeur fournie par le client fasse viser à notre appel
// authentifié AUTRE CHOSE qu'un créneau — une autre ressource, un autre hôte, un chemin remonté.

describe("isClassEventId — l'IRI d'un créneau ResaMania, et rien d'autre", () => {
  it.each([
    "/lecomplexbures/class_events/25312903",
    "/le-complexe_bures/class_events/1",
    // `i` : la casse du club ne change rien à la ressource visée.
    "/LeComplexBures/class_events/42",
  ])("accepte %s", (iri) => {
    expect(isClassEventId(iri)).toBe(true);
  });

  it.each([
    ["vide", ""],
    ["sans barre initiale", "lecomplexbures/class_events/25312903"],
    ["sans club", "/class_events/25312903"],
    ["identifiant non numérique", "/lecomplexbures/class_events/abc"],
    ["identifiant vide", "/lecomplexbures/class_events/"],
    ["une AUTRE ressource", "/lecomplexbures/bookings/25312903"],
    ["un segment en trop (ancre de fin)", "/lecomplexbures/class_events/25312903/cancel"],
    ["un préfixe en trop (ancre de début)", "/x/lecomplexbures/class_events/25312903"],
    ["une remontée de chemin", "/../class_events/25312903"],
    ["un hôte absolu", "https://evil.example/lecomplexbures/class_events/1"],
    ["un hôte relatif au protocole", "//evil.example/class_events/1"],
    ["une chaîne de requête", "/lecomplexbures/class_events/1?x=1"],
    ["un fragment", "/lecomplexbures/class_events/1#x"],
    ["un espace", "/lecomplexbures/class_events/1 "],
    // `$` sans drapeau `m` ne s'arrête PAS avant un saut de ligne final en JavaScript (à la
    // différence de PCRE) : vérifié ici pour que personne n'ajoute `m` en pensant bien faire.
    ["un saut de ligne final", "/lecomplexbures/class_events/1\n"],
    ["un saut de ligne au milieu", "/lecomplexbures/class_events/1\n/x/class_events/2"],
    ["des caractères encodés", "/lecomplex%2Fbures/class_events/1"],
  ])("refuse %s", (_cas, valeur) => {
    expect(isClassEventId(valeur)).toBe(false);
  });

  it.each([
    ["un nombre", 25312903],
    ["null", null],
    ["undefined", undefined],
    ["un objet", { toString: () => "/lecomplexbures/class_events/1" }],
    ["un tableau", ["/lecomplexbures/class_events/1"]],
  ])("refuse ce qui n'est pas une chaîne : %s", (_cas, valeur) => {
    // Un tableau ou un objet se convertiraient en un IRI valide si l'on testait la regex
    // directement (`RegExp.test` appelle `String(v)`) : d'où le `typeof` qui la précède.
    expect(isClassEventId(valeur)).toBe(false);
  });

  it("l'expression n'a pas d'état : pas de drapeau `g` ni `y`, qui ferait alterner les verdicts", () => {
    // Avec `g`, `test` reprend à `lastIndex` : le même IRI serait accepté, puis refusé.
    expect(CLASS_EVENT_IRI.global).toBe(false);
    expect(CLASS_EVENT_IRI.sticky).toBe(false);
    const iri = "/lecomplexbures/class_events/25312903";
    expect([isClassEventId(iri), isClassEventId(iri)]).toEqual([true, true]);
  });
});
