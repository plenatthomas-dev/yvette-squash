import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  MAINTENANCE_EVENT,
  MaintenanceError,
  isDbDown,
  readJson,
  readOk,
  reportMaintenance,
} from "./apiFetch";

// « MAINTENANCE » NE DOIT PAS ÊTRE LE NOM DE TOUTES LES PANNES.
//
// Ce module tranche, à chaque réponse du serveur, entre deux diagnostics qui appellent deux
// réactions opposées : « la base ne répond pas » (bannière, message d'attente) et « le serveur a
// refusé, et il a dit pourquoi » (message du serveur, l'appli fonctionne). Se tromper de côté
// coûte cher dans les deux sens — crier à la panne générale sur un 409 ordinaire, ou afficher
// « Unexpected end of JSON input » à un membre pendant que Neon dort.
//
// Aucun test ne l'avait jamais exercé. Il tourne pourtant sur CHAQUE appel de l'appli.
//
// Sous jsdom, parce que la bannière se déclenche par un événement de `window` : la mesurer
// ailleurs reviendrait à ne mesurer que la moitié qui ne sert à rien.

const reponse = (
  status: number,
  corps: unknown,
  opts: { illisible?: boolean } = {},
): Response =>
  ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => {
      if (opts.illisible) throw new SyntaxError("Unexpected end of JSON input");
      return corps;
    },
  }) as Response;

/** Ce que le module est allé chercher sur le réseau : ici, uniquement /api/health. */
let fetchMock: ReturnType<typeof vi.fn>;
/** Les événements « maintenance » reçus par la fenêtre. */
let bannieres: { confirmed: boolean }[];

function ecouteBanniere(e: Event) {
  bannieres.push((e as CustomEvent).detail);
}

beforeEach(() => {
  bannieres = [];
  window.addEventListener(MAINTENANCE_EVENT, ecouteBanniere);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  window.removeEventListener(MAINTENANCE_EVENT, ecouteBanniere);
  vi.unstubAllGlobals();
});

describe("isDbDown", () => {
  it("répond FAUX sur un 404 : la route health a disparu, on ne peut rien conclure", async () => {
    // Le piège que ce cas évite : si `/api/health` est un jour supprimée, chaque incident
    // applicatif deviendrait une « panne de base » — la détection doit s'éteindre proprement,
    // pas se mettre à crier.
    fetchMock.mockResolvedValue(reponse(404, null));
    expect(await isDbDown()).toBe(false);
  });

  it("répond VRAI sur un statut non-ok, SANS avoir besoin de lire le corps", async () => {
    // Corps volontairement illisible : c'est ce que rend une route qui a jeté avant de répondre,
    // et c'est le seul cas qui éprouve vraiment le contrôle du statut. Un 503 accompagné d'un
    // `{ ok: false }` bien formé passerait aussi par la ligne suivante — le test aurait l'air
    // de mesurer le statut alors qu'il mesurerait le corps. C'est le contrôle par mutation
    // qui l'a dit : retirer le `if (!r.ok)` ne faisait tomber personne.
    fetchMock.mockResolvedValue(reponse(503, null, { illisible: true }));
    expect(await isDbDown()).toBe(true);
  });

  it("répond VRAI sur un 200 qui dit lui-même `{ ok: false }`", async () => {
    fetchMock.mockResolvedValue(reponse(200, { ok: false }));
    expect(await isDbDown()).toBe(true);
  });

  it("répond FAUX quand la base va bien", async () => {
    fetchMock.mockResolvedValue(reponse(200, { ok: true }));
    expect(await isDbDown()).toBe(false);
  });

  it("répond VRAI quand health elle-même est injoignable (réseau coupé)", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    expect(await isDbDown()).toBe(true);
  });
});

describe("readJson", () => {
  it("rend le corps d'un 4xx SANS sonder health : un refus n'est pas une panne", async () => {
    // C'est la moitié de la valeur du module. Un 409 « quelqu'un marque déjà ce match » doit
    // arriver tel quel à l'écran de marquage, sans requête de plus et sans bannière.
    const d = await readJson<{ error: string }>(reponse(409, { error: "Quelqu'un marque déjà" }));
    expect(d.error).toBe("Quelqu'un marque déjà");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(bannieres).toEqual([]);
  });

  it("croit le serveur sur parole quand il annonce lui-même la panne (503 + maintenance)", async () => {
    // Autoritaire : aucune sonde. Le login reste ainsi couvert même si /api/health disparaît.
    const p = readJson(reponse(503, { maintenance: true, error: "Base en veille" }));
    await expect(p).rejects.toBeInstanceOf(MaintenanceError);
    await expect(p).rejects.toThrow("Base en veille");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(bannieres).toEqual([{ confirmed: true }]);
  });

  it("sur un corps ILLISIBLE, sonde health — et lève MaintenanceError si la base est à terre", async () => {
    // Le symptôme d'origine : une route qui jette avant d'avoir pu répondre en JSON rend un 500
    // au corps vide, et `await res.json()` levait « Unexpected end of JSON input » à l'écran.
    fetchMock.mockResolvedValue(reponse(503, { ok: false }));
    await expect(readJson(reponse(500, null, { illisible: true }))).rejects.toBeInstanceOf(
      MaintenanceError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bannieres).toEqual([{ confirmed: true }]);
  });

  it("sur un corps illisible mais base DEBOUT, reste sur une erreur lisible et NE crie pas", async () => {
    // Un incident applicatif sans rapport avec la base ne doit pas afficher la bannière : elle
    // dit « reviens dans quelques minutes », ce qui serait un mensonge.
    fetchMock.mockResolvedValue(reponse(200, { ok: true }));
    await expect(readJson(reponse(500, null, { illisible: true }))).rejects.toThrow(
      "Réponse inattendue du serveur (500).",
    );
    await expect(readJson(reponse(500, null, { illisible: true }))).rejects.not.toBeInstanceOf(
      MaintenanceError,
    );
    expect(bannieres).toEqual([]);
  });
});

describe("readOk — pour que l'oubli du `if (!res.ok)` ne soit plus possible", () => {
  it("lève avec le message du serveur sur un statut d'erreur", async () => {
    // Sans ce raccourci, un 409 « quelqu'un marque déjà » ouvrait quand même l'écran de
    // marquage : le corps était rendu, personne ne regardait le statut.
    await expect(readOk(reponse(409, { error: "Quelqu'un marque déjà" }))).rejects.toThrow(
      "Quelqu'un marque déjà",
    );
  });

  it("se rabat sur le statut quand le serveur n'a pas donné de message", async () => {
    await expect(readOk(reponse(500, {}))).rejects.toThrow("Erreur 500");
  });

  it("rend les données quand tout va bien", async () => {
    await expect(readOk(reponse(200, { id: "f1" }))).resolves.toEqual({ id: "f1" });
  });

  it("laisse passer MaintenanceError telle quelle, sans la retraduire en « Erreur 503 »", async () => {
    // Le message de maintenance EST le texte affiché ; le remplacer par un numéro de statut
    // reviendrait à défaire le module.
    await expect(readOk(reponse(503, { maintenance: true }))).rejects.toBeInstanceOf(
      MaintenanceError,
    );
  });
});

describe("reportMaintenance", () => {
  it("annonce un simple SOUPÇON par défaut : la bannière confirmera d'elle-même", () => {
    reportMaintenance();
    expect(bannieres).toEqual([{ confirmed: false }]);
  });

  it("annonce une panne CONFIRMÉE quand l'appelant a déjà sondé health", () => {
    reportMaintenance(true);
    expect(bannieres).toEqual([{ confirmed: true }]);
  });
});
