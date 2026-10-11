// Les boutons des notifications, côté service worker (public/sw.js).
//
// Le worker est un fichier statique, chargé tel quel par le navigateur : on l'exécute ici dans
// un bac à sable `vm` avec un faux `self`, pour verrouiller ce que les boutons ENVOIENT aux
// routes et ce qu'ils AFFICHENT ensuite — le contrat que src/lib/notification-actions.ts
// décrit côté serveur.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SOURCE = readFileSync(fileURLToPath(new URL("../../public/sw.js", import.meta.url)), "utf8");

type Handler = (event: Record<string, unknown>) => void;
type Reponse = { status: number; json?: unknown };

let handlers: Record<string, Handler>;
let showNotification: ReturnType<typeof vi.fn>;
let openWindow: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;

function charger(reponses: Reponse[]) {
  handlers = {};
  showNotification = vi.fn(async () => {});
  openWindow = vi.fn(async () => {});
  const file = [...reponses];
  fetchMock = vi.fn(async () => {
    const r = file.shift();
    if (!r) throw new TypeError("Failed to fetch");
    return { status: r.status, json: async () => r.json ?? {} };
  });
  const self = {
    addEventListener: (type: string, fn: Handler) => {
      handlers[type] = fn;
    },
    registration: { showNotification },
    clients: { matchAll: async () => [], openWindow, claim: async () => {} },
    skipWaiting: () => {},
  };
  vm.runInNewContext(SOURCE, { self, fetch: fetchMock, console });
}

/** Déclenche `notificationclick` et attend tout ce que le worker a confié à `waitUntil`. */
async function cliquer(action: string, data: Record<string, unknown>, notif: { tag?: string; title?: string } = {}) {
  const attentes: Promise<unknown>[] = [];
  handlers.notificationclick({
    action,
    notification: { data, tag: notif.tag ?? "t1", title: notif.title ?? "Titre", close: () => {} },
    waitUntil: (p: Promise<unknown>) => attentes.push(p),
  });
  await Promise.all(attentes);
}

const corps = (i: number) => JSON.parse(fetchMock.mock.calls[i][1].body as string);
const derniere = () => showNotification.mock.calls.at(-1) as [string, Record<string, unknown>];

const demain = new Date(Date.now() + 86_400_000).toISOString();
const book = {
  quand: "mardi 14 octobre à 18:40",
  startsAt: demain,
  courts: [
    { id: "/club/class_events/1", name: "Terrain 1" },
    { id: "/club/class_events/2", name: "Terrain 2" },
  ],
};

beforeEach(() => charger([]));

describe("sw.js — réception d'un push", () => {
  it("transmet les boutons, leurs données et le destinataire à la notification", async () => {
    const attentes: Promise<unknown>[] = [];
    handlers.push({
      data: {
        json: () => ({
          title: "Un terrain s'est libéré 🎾",
          body: "…",
          url: "/?view=day",
          tag: "alert-a1",
          actions: [{ action: "book", title: "Réserver" }],
          data: { book },
          to: "u1",
        }),
      },
      waitUntil: (p: Promise<unknown>) => attentes.push(p),
    });
    await Promise.all(attentes);
    const [, options] = derniere();
    expect(options.actions).toEqual([{ action: "book", title: "Réserver" }]);
    expect(options.data).toEqual({ book, url: "/?view=day", to: "u1" });
  });

  it("n'affiche aucun bouton quand le push n'en porte pas", async () => {
    const attentes: Promise<unknown>[] = [];
    handlers.push({
      data: { json: () => ({ title: "Annonce", body: "…" }) },
      waitUntil: (p: Promise<unknown>) => attentes.push(p),
    });
    await Promise.all(attentes);
    expect(derniere()[1].actions).toEqual([]);
  });
});

describe("sw.js — « Réserver »", () => {
  it("réserve le premier terrain, au nom du destinataire, et l'annonce", async () => {
    charger([{ status: 200, json: { ok: true } }]);
    await cliquer("book", { book, to: "u1", url: "/?view=day" }, { tag: "alert-a1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/book");
    expect(corps(0)).toEqual({ classEventId: "/club/class_events/1", startsAt: demain, forUserId: "u1" });
    // L'attente, en silence, puis le résultat, qui remplace la notification (même tag).
    expect(showNotification.mock.calls[0][1]).toMatchObject({ tag: "alert-a1", silent: true });
    expect(derniere()[0]).toBe("Terrain réservé ✅");
    expect(derniere()[1]).toMatchObject({ body: "Terrain 1 — mardi 14 octobre à 18:40", tag: "alert-a1", renotify: true });
  });

  it("passe au terrain suivant quand le premier a été pris entre-temps", async () => {
    charger([
      { status: 409, json: { error: "Créneau complet" } },
      { status: 200, json: { ok: true } },
    ]);
    await cliquer("book", { book, to: "u1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(corps(1).classEventId).toBe("/club/class_events/2");
    expect(derniere()[1].body).toBe("Terrain 2 — mardi 14 octobre à 18:40");
  });

  it("s'arrête au premier refus qui vaut pour tous les terrains (chevauchement)", async () => {
    const error = "Tu as déjà une réservation sur ce créneau (Terrain 3). Un seul terrain par horaire.";
    charger([{ status: 409, json: { error, code: "overlap" } }]);
    await cliquer("book", { book, to: "u1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(derniere()[0]).toBe("Réservation impossible");
    expect(derniere()[1].body).toBe(error);
  });

  it("demande de se reconnecter quand la session a expiré", async () => {
    charger([{ status: 401, json: { error: "Non authentifié" } }]);
    await cliquer("book", { book, to: "u1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(derniere()[1].body).toBe("Ta session a expiré : ouvre l'appli pour te reconnecter.");
  });

  it("dit qu'il n'y a pas de réseau plutôt que d'échouer en silence", async () => {
    charger([]);
    await cliquer("book", { book, to: "u1" });
    expect(derniere()[1].body).toBe("Pas de réseau : ouvre l'appli pour réessayer.");
  });

  it("annonce le dernier refus quand tous les terrains ont été pris", async () => {
    charger([
      { status: 409, json: { error: "Créneau complet" } },
      { status: 409, json: { error: "Ce créneau n'existe plus. Actualise le planning." } },
    ]);
    await cliquer("book", { book, to: "u1" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(derniere()[1].body).toBe("Ce créneau n'existe plus. Actualise le planning.");
  });

  it("ne tente rien sur un créneau déjà commencé", async () => {
    await cliquer("book", { book: { ...book, startsAt: new Date(Date.now() - 60_000).toISOString() }, to: "u1" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(derniere()[0]).toBe("Trop tard");
  });
});

describe("sw.js — « Dispo » / « Pas dispo »", () => {
  it("pose la réponse du destinataire et la confirme sous le titre de la rencontre", async () => {
    charger([{ status: 200, json: { entries: [] } }]);
    await cliquer("avail-yes", { fixtureId: "fx 1", to: "u1", url: "/?view=interclub" }, {
      tag: "interclub-fx1",
      title: "Yvette 1 – Massy",
    });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/interclub/fx%201/availability");
    expect(fetchMock.mock.calls[0][1].method).toBe("PUT");
    expect(corps(0)).toEqual({ status: "yes", forUserId: "u1" });
    expect(derniere()).toEqual([
      "Yvette 1 – Massy",
      expect.objectContaining({ body: "C'est noté : disponible ✅", tag: "interclub-fx1" }),
    ]);
  });

  it("« Pas dispo » envoie `no`", async () => {
    charger([{ status: 200, json: {} }]);
    await cliquer("avail-no", { fixtureId: "fx1", to: "u1" });
    expect(corps(0).status).toBe("no");
    expect(derniere()[1].body).toBe("C'est noté : pas disponible.");
  });

  it("renvoie vers l'appli quand la route demande une confirmation", async () => {
    charger([{ status: 409, json: { error: "confirm_override", existing: { status: "no" } } }]);
    await cliquer("avail-yes", { fixtureId: "fx1", to: "u1" });
    expect(derniere()[1].body).toBe("Une réponse a déjà été donnée pour toi : ouvre l'appli pour la remplacer.");
  });

  it("montre le refus de la route tel quel (autre compte sur l'appareil)", async () => {
    const error = "Cette notification était destinée à un autre compte que celui connecté sur cet appareil.";
    charger([{ status: 409, json: { error, code: "other_account" } }]);
    await cliquer("avail-no", { fixtureId: "fx1", to: "u1" });
    expect(derniere()[1].body).toBe(error);
  });
});

describe("sw.js — toucher la notification elle-même", () => {
  it("ouvre l'appli à l'adresse de la notification, sans rien appeler", async () => {
    await cliquer("", { book, to: "u1", url: "/?date=2026-10-14&view=day" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(openWindow).toHaveBeenCalledWith("/?date=2026-10-14&view=day");
  });
});
