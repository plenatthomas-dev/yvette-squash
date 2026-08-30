import { describe, it, expect } from "vitest";
import { fmtEuros, parseEuros } from "@/components/Tricount";

// LES DEUX FONCTIONS PAR LESQUELLES L'ARGENT ENTRE ET SORT DE L'ÉCRAN.
//
// `parseEuros` est la FRONTIÈRE : au-delà, tout est en centimes entiers et la conservation des
// sommes est prouvée. En deçà, c'est une chaîne tapée au doigt sur un téléphone. Toute la
// rigueur arithmétique du tricount repose sur ce que cette fonction laisse passer — et elle
// est exportée, donc offerte à la vérification, sans que rien ne l'ait jamais exercée.
//
// Le piège qu'elle contient est classique et silencieux : `parseFloat("12.34") * 100` vaut
// 1233.9999999999998 en virgule flottante. Sans l'arrondi, une dépense sur deux perdrait un
// centime à la saisie, avant même d'entrer dans le partage.
//
// Sous jsdom parce que le module est un composant client (`"use client"`, JSX) : l'importer
// dans le projet « node » ferait échouer la compilation, pas la fonction.

describe("parseEuros — ce qui a le droit d'entrer", () => {
  it("accepte la virgule française comme le point", () => {
    expect(parseEuros("12,50")).toBe(1250);
    expect(parseEuros("12.50")).toBe(1250);
  });

  it("accepte un entier sans décimale", () => {
    expect(parseEuros("12")).toBe(1200);
    expect(parseEuros("0")).toBe(0);
  });

  it("accepte une seule décimale", () => {
    expect(parseEuros("12,5")).toBe(1250);
  });

  it("ignore les espaces, y compris ceux d'un clavier de téléphone", () => {
    expect(parseEuros(" 12,50 ")).toBe(1250);
    expect(parseEuros("1 250,00")).toBe(125000);
  });

  it("ARRONDIT au lieu de tronquer — le flottant fait perdre un centime autrement", () => {
    // `parseFloat("12.34") * 100 === 1233.9999999999998`. Un `Math.trunc` rendrait 1233 :
    // un centime évaporé à la saisie, sur une dépense parfaitement ordinaire.
    expect(parseEuros("12.34")).toBe(1234);
    expect(parseEuros("0,07")).toBe(7);
    expect(parseEuros("0,29")).toBe(29);
    expect(parseEuros("99999,99")).toBe(9999999);
  });

  it("refuse ce qui n'est pas un montant", () => {
    for (const mauvais of ["", " ", "abc", "12€", "1,2,3", "--1"]) {
      expect(parseEuros(mauvais)).toBeNull();
    }
  });

  it("refuse un montant NÉGATIF — une dépense ne se saisit pas à l'envers", () => {
    // Un montant négatif traverserait toute la répartition sans erreur et inverserait des
    // soldes. Le refus est ici, à la frontière.
    expect(parseEuros("-1")).toBeNull();
    expect(parseEuros("-12,50")).toBeNull();
  });

  it("refuse une TROISIÈME décimale plutôt que de l'arrondir en silence", () => {
    // « 1.234 » est presque sûrement une faute de frappe (un séparateur de milliers pris pour
    // une virgule). L'accepter écrirait 1,23 € là où le membre voulait 1 234 €.
    expect(parseEuros("1.234")).toBeNull();
    expect(parseEuros("12,345")).toBeNull();
  });
});

describe("fmtEuros — ce qui sort à l'écran", () => {
  it("affiche toujours deux décimales, séparateur français", () => {
    expect(fmtEuros(1234)).toBe("12,34 €");
    expect(fmtEuros(1200)).toBe("12,00 €");
    expect(fmtEuros(7)).toBe("0,07 €");
    expect(fmtEuros(0)).toBe("0,00 €");
  });

  it("affiche les dettes avec leur signe", () => {
    expect(fmtEuros(-1500)).toBe("-15,00 €");
  });

  it("fait l'aller-retour avec `parseEuros` sans rien perdre", () => {
    // La propriété qui compte vraiment : ce qu'on affiche, réécrit tel quel dans le champ,
    // redonne le même nombre de centimes.
    for (const cents of [0, 1, 7, 99, 100, 1234, 99999, 9999999]) {
      const affiche = fmtEuros(cents).replace(" €", "").replace(/\s/g, "");
      expect(parseEuros(affiche)).toBe(cents);
    }
  });
});
