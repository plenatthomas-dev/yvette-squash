import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { Features } from "@/lib/features";

// LA NOTE DOIT DÉCRIRE L'APPLI QU'ON A SOUS LES YEUX — NI PLUS, NI MOINS.
//
// L'obligation d'information (art. 13 RGPD) porte sur un traitement RÉEL. Chaque paragraphe de
// cette note est donc conditionné par le flag de la fonction qu'il décrit, et les deux erreurs
// se valent :
//
//   * le paragraphe MANQUE alors que la fonction tourne — l'appli crée de la donnée nominative
//     sans le dire. C'est ce qui bloquait l'activation de l'interclub en production ;
//   * le paragraphe est LÀ alors que la fonction est coupée — la note décrit un traitement qui
//     n'existe pas, ce qui la rend fausse dans l'autre sens et illisible.
//
// Ce couplage ne se voit nulle part à l'usage : la note est un écran qu'on ouvre une fois. D'où
// ces tests, qui portent sur ce que le texte AFFIRME, pas sur sa mise en forme.

const flags = vi.hoisted(() => ({ valeurs: {} as Features }));

vi.mock("@/components/FeatureProvider", () => ({ useFeatures: () => flags.valeurs }));

import { PrivacyNotice } from "@/components/PrivacyNotice";

const TOUT_OFF: Features = {
  tricount: false,
  emailLogin: false,
  biometry: false,
  directory: false,
  delegation: false,
  tournament: false,
  ranking: false,
  externalBookings: false,
  interclub: false,
};

/** Ouvre la note et rend son texte entier, espaces normalisés. */
function texteDeLaNote(actifs: Partial<Features> = {}) {
  flags.valeurs = { ...TOUT_OFF, ...actifs };
  render(<PrivacyNotice />);
  fireEvent.click(screen.getByRole("button", { name: /Confidentialité et données/i }));
  return (document.querySelector(".privacy-body")?.textContent ?? "").replace(/\s+/g, " ");
}

beforeEach(() => {
  flags.valeurs = { ...TOUT_OFF };
});

describe("note de confidentialité — le paragraphe interclub", () => {
  it("ne dit RIEN de l'interclub quand la fonction est coupée", () => {
    // En production, le flag est à 0 : l'onglet n'existe pas et les routes répondent 404. Une
    // note qui parlerait quand même de feuilles de match décrirait un traitement inexistant.
    const t = texteDeLaNote();
    expect(t).not.toMatch(/Interclub/i);
    expect(t).not.toMatch(/feuille de match/i);
  });

  it("annonce la donnée nominative dès que la fonction est active", () => {
    // Les trois faits qui ont motivé ce paragraphe : ce qui est enregistré, qui le voit, et le
    // fait que des noms de NON-MEMBRES y figurent — saisis par quelqu'un d'autre qu'eux.
    const t = texteDeLaNote({ interclub: true });
    expect(t).toMatch(/qui joue, contre qui, le score jeu par jeu/i);
    expect(t).toMatch(/tous les membres connectés/i);
    expect(t).toMatch(/adversaires/i);
    expect(t).toMatch(/administrateur/i);
  });

  it("prévient que le nom SURVIT à la suppression du compte", () => {
    // C'est l'exception à la promesse « tes données disparaissent avec ton compte », faite plus
    // haut dans la même note. Une exception non écrite rendrait la promesse fausse.
    const t = texteDeLaNote({ interclub: true });
    expect(t).toMatch(/même si son compte est supprimé/i);
    expect(t).toMatch(/seule exception/i);
  });

  it("dit que le déroulé point par point ne quitte pas le téléphone du marqueur", () => {
    // Une donnée qu'on ne garde PAS mérite d'être annoncée autant qu'une donnée qu'on garde :
    // c'est la différence entre « on enregistre les scores » et « on enregistre ta partie ».
    const t = texteDeLaNote({ interclub: true });
    expect(t).toMatch(/ne quitte jamais le navigateur/i);
  });

  it("présente le suivi par notifications comme FACULTATIF et retirable", () => {
    // Le consentement doit être annoncé comme tel, et le retrait comme aussi simple que l'octroi.
    const t = texteDeLaNote({ interclub: true });
    expect(t).toMatch(/facultatif/i);
    expect(t).toMatch(/se retire à tout moment/i);
  });
});

describe("note de confidentialité — la cohérence entre paragraphes", () => {
  it("maintient « le seul endroit… » tant qu'aucune fonction ne saisit de nom de non-membre", () => {
    expect(texteDeLaNote()).toMatch(/seul endroit où l'appli garde une donnée sur quelqu'un qui n'est pas membre\./i);
  });

  it("nuance cette phrase dès que l'interclub est actif", () => {
    // Sans cette nuance, la note se contredit d'un paragraphe à l'autre : elle jure qu'il n'y a
    // qu'un seul endroit, puis en décrit un second quelques lignes plus bas.
    expect(texteDeLaNote({ interclub: true })).toMatch(
      /en dehors des noms que des membres saisissent eux-mêmes/i,
    );
  });

  it("la nuance vaut aussi pour les tournois, qui portent des prénoms d'invités", () => {
    // La phrase était déjà limite avant l'interclub : un tournoi enregistre des invités hors
    // asso. Ce test dit que la nuance couvre les deux, et non seulement la dernière arrivée.
    expect(texteDeLaNote({ tournament: true })).toMatch(
      /en dehors des noms que des membres saisissent eux-mêmes/i,
    );
  });
});
