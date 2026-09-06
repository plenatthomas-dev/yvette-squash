import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// LE COURTIER TEMPS RÉEL — le module dont tout le contrat tient en une phrase :
//
//     ⚠️ AUCUNE FONCTION D'ICI NE JETTE, JAMAIS.
//
// Il n'avait aucun test, alors que c'est précisément le genre de promesse qu'un refactoring
// casse sans bruit : le fil doit continuer à marcher clés absentes (développement, prod tant
// que la fonction est en essai), quota dépassé, courtier en panne. Postgres reste la source de
// vérité, le push reste le canal de notification, `onForeground` reste le rattrapage — Pusher
// n'ajoute que l'immédiateté. Un jet ici transformerait un service d'agrément en 500 sur
// l'écriture d'un message.
//
// Second invariant, celui-là de confidentialité : `user_info` est VISIBLE DE TOUS LES ABONNÉS.
// N'y voyager qu'un nom d'affichage, jamais une adresse.

const h = vi.hoisted(() => ({
  /** Ce que le constructeur de Pusher doit jeter, ou null. */
  jetteConstructeur: null as null | Error,
  /** Ce que `trigger` / `authorizeChannel` doivent jeter, ou null. */
  jetteAppel: null as null | Error,
  /** Les arguments du dernier `trigger`. */
  declenche: null as null | unknown[],
  /** Les arguments du dernier `authorizeChannel`. */
  autorise: null as null | unknown[],
  /** Combien de fois le client a été construit : la mémoïsation se mesure. */
  constructions: 0,
}));

vi.mock("pusher", () => ({
  default: class {
    constructor() {
      h.constructions += 1;
      if (h.jetteConstructeur) throw h.jetteConstructeur;
    }
    async trigger(...args: unknown[]) {
      h.declenche = args;
      if (h.jetteAppel) throw h.jetteAppel;
      return {};
    }
    authorizeChannel(...args: unknown[]) {
      h.autorise = args;
      if (h.jetteAppel) throw h.jetteAppel;
      return { auth: "signature", channel_data: JSON.stringify(args[2]) };
    }
  },
}));

import {
  broadcastForum,
  authorizeForumChannel,
  realtimeConfigured,
  resetForumRealtimeForTests,
  FORUM_CHANNEL,
} from "./forum-realtime";

/** Pose les quatre variables sans lesquelles le module renonce en silence. */
const configurer = () => {
  vi.stubEnv("PUSHER_APP_ID", "1234");
  vi.stubEnv("NEXT_PUBLIC_PUSHER_KEY", "cle");
  vi.stubEnv("PUSHER_SECRET", "secret");
  vi.stubEnv("NEXT_PUBLIC_PUSHER_CLUSTER", "eu");
};

beforeEach(() => {
  h.jetteConstructeur = null;
  h.jetteAppel = null;
  h.declenche = null;
  h.autorise = null;
  h.constructions = 0;
  resetForumRealtimeForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetForumRealtimeForTests();
});

describe("sans configuration — le mode dégradé assumé", () => {
  it("renonce en silence quand les clés manquent", async () => {
    vi.stubEnv("PUSHER_APP_ID", "");
    vi.stubEnv("NEXT_PUBLIC_PUSHER_KEY", "");
    vi.stubEnv("PUSHER_SECRET", "");
    vi.stubEnv("NEXT_PUBLIC_PUSHER_CLUSTER", "");
    expect(realtimeConfigured()).toBe(false);
    await expect(broadcastForum("message", { id: "m1" })).resolves.toBeUndefined();
    expect(authorizeForumChannel("s1", FORUM_CHANNEL, { id: "u1", name: "Thomas" })).toBeNull();
    expect(h.declenche).toBeNull();
  });

  // UNE SEULE variable manquante suffit : mieux vaut renoncer que signer avec une moitié de
  // configuration, ce qui échouerait plus tard et plus loin.
  it("renonce dès qu'une seule des quatre variables manque", () => {
    configurer();
    vi.stubEnv("PUSHER_SECRET", "");
    expect(realtimeConfigured()).toBe(false);
  });

  it("MÉMORISE l'échec, pour ne pas relire l'environnement à chaque message", async () => {
    configurer();
    h.jetteConstructeur = new Error("clé mal formée");
    expect(realtimeConfigured()).toBe(false);
    await broadcastForum("message", { id: "m1" });
    expect(realtimeConfigured()).toBe(false);
    // Une seule tentative de construction, malgré trois appels.
    expect(h.constructions).toBe(1);
  });
});

describe("avec configuration", () => {
  beforeEach(configurer);

  it("diffuse sur le canal unique du fil", async () => {
    await broadcastForum("message", { id: "m1" });
    expect(h.declenche).toEqual([FORUM_CHANNEL, "message", { id: "m1" }]);
  });

  it("construit le client UNE FOIS, quel que soit le nombre de messages", async () => {
    await broadcastForum("message", { id: "m1" });
    await broadcastForum("message", { id: "m2" });
    await broadcastForum("deleted", { id: "m1" });
    expect(h.constructions).toBe(1);
  });

  // LE CONTRAT DU MODULE. Quota dépassé, courtier en panne, réseau : l'écriture en base a déjà
  // eu lieu, le message existe, et il apparaîtra au prochain rattrapage. Jeter ici rendrait un
  // 500 sur un message pourtant enregistré.
  it("NE JETTE PAS quand le courtier refuse la diffusion", async () => {
    h.jetteAppel = new Error("quota dépassé");
    await expect(broadcastForum("message", { id: "m1" })).resolves.toBeUndefined();
  });

  it("NE JETTE PAS quand la signature d'accès échoue — elle rend null", () => {
    h.jetteAppel = new Error("socket inconnu");
    expect(authorizeForumChannel("s1", FORUM_CHANNEL, { id: "u1", name: "Thomas" })).toBeNull();
  });

  it("signe l'accès au canal du fil", () => {
    const out = authorizeForumChannel("s1", FORUM_CHANNEL, { id: "u1", name: "Thomas" });
    expect(out?.auth).toBe("signature");
    expect(h.autorise?.[0]).toBe("s1");
    expect(h.autorise?.[1]).toBe(FORUM_CHANNEL);
  });

  // `user_info` est VISIBLE DE TOUS LES ABONNÉS : c'est le principe d'un canal de présence.
  // N'y voyage qu'un identifiant et un nom d'affichage — jamais une adresse, jamais un
  // `contactId`. Le test le verrouille sur la FORME, pas seulement sur l'absence d'un champ.
  it("ne fait voyager que l'identifiant et le nom, jamais une adresse", () => {
    authorizeForumChannel("s1", FORUM_CHANNEL, {
      id: "u1",
      name: "Thomas",
    });
    const data = h.autorise?.[2] as { user_id: string; user_info: Record<string, unknown> };
    expect(data.user_id).toBe("u1");
    expect(Object.keys(data.user_info)).toEqual(["name"]);
    expect(JSON.stringify(data)).not.toContain("@");
  });

  // Refuser tout autre canal est ce qui empêche cette route de servir de signeur universel :
  // un client bricolé demanderait sinon l'accès à n'importe quel canal privé de l'application.
  it("refuse de signer un canal qui n'est pas celui du fil", () => {
    expect(authorizeForumChannel("s1", "presence-autre", { id: "u1", name: "Thomas" })).toBeNull();
    expect(h.autorise).toBeNull();
  });
});
