import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// LE COOKIE DE DÉFI EST TOUTE LA MÉMOIRE D'UNE CÉRÉMONIE PASSKEY. Il n'y a pas de table des
// défis : entre `/options` et `/verify`, le serveur ne se souvient de rien, et c'est ce cookie
// chiffré qui lui rappelle quel défi il a émis, pour quelle cérémonie, et pour qui. Chaque refus
// d'`openChallenge` testé ici est donc une porte : un défi d'enrôlement rejoué en connexion, un
// défi expiré rejoué plus tard, un cookie bricolé — tous doivent rendre `null`, sans quoi la
// vérification WebAuthn se ferait contre un défi que le serveur n'a jamais émis pour elle.
//
// `@/lib/db` est bouchonné : le module l'importe pour l'anti-abus, que ce fichier ne teste pas,
// et le projet « node » de vitest n'ouvre aucune base (cf. .github/workflows/ci.yml).
vi.mock("./db", () => ({ prisma: {} }));

import { encrypt } from "./crypto";
import { CHALLENGE_TTL_S, openChallenge, rpParams, sealChallenge } from "./webauthn";

/** Une clé de 32 octets, comme l'exige `crypto.ts` — sa valeur n'importe pas, sa longueur si. */
const CLE = Buffer.alloc(32, 7).toString("base64");
const AUTRE_CLE = Buffer.alloc(32, 9).toString("base64");

beforeEach(() => {
  vi.stubEnv("CREDENTIALS_SECRET", CLE);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("sealChallenge / openChallenge", () => {
  it("aller-retour : rend le défi, la cérémonie et l'utilisateur, avec une échéance au TTL", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T20:00:00Z"));
    const scelle = sealChallenge({ challenge: "abc123", type: "reg", userId: "u1" });
    expect(openChallenge(scelle, "reg")).toEqual({
      challenge: "abc123",
      type: "reg",
      userId: "u1",
      exp: Date.now() + CHALLENGE_TTL_S * 1000,
    });
  });

  it("le cookie est CHIFFRÉ : ni le défi ni l'utilisateur ne s'y lisent en clair", () => {
    const scelle = sealChallenge({ challenge: "defi-secret", type: "reg", userId: "u-42" });
    expect(scelle).not.toContain("defi-secret");
    expect(scelle).not.toContain("u-42");
    // Et deux scellés du même contenu diffèrent (IV aléatoire) : rien à corréler entre deux.
    expect(sealChallenge({ challenge: "x", type: "auth" })).not.toBe(
      sealChallenge({ challenge: "x", type: "auth" }),
    );
  });

  // Le type de cérémonie est ce qui empêche un défi émis pour AJOUTER un passkey (utilisateur
  // connecté) de servir à SE CONNECTER, et inversement.
  it.each([
    ["reg", "auth"],
    ["auth", "reg"],
  ] as const)("un défi « %s » présenté à une cérémonie « %s » est refusé", (emis, attendu) => {
    expect(openChallenge(sealChallenge({ challenge: "abc", type: emis }), attendu)).toBeNull();
  });

  it("valide jusqu'à l'échéance comprise, refusé une milliseconde après", () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-10-17T20:00:00Z").getTime();
    vi.setSystemTime(t0);
    const scelle = sealChallenge({ challenge: "abc", type: "auth" });

    // `p.exp < Date.now()` : l'instant exact de l'échéance passe encore.
    vi.setSystemTime(t0 + CHALLENGE_TTL_S * 1000);
    expect(openChallenge(scelle, "auth")).not.toBeNull();

    vi.setSystemTime(t0 + CHALLENGE_TTL_S * 1000 + 1);
    expect(openChallenge(scelle, "auth")).toBeNull();
  });

  it("refuse un cookie absent, vide ou qui n'a pas le format du chiffrement", () => {
    expect(openChallenge(undefined, "auth")).toBeNull();
    expect(openChallenge("", "auth")).toBeNull();
    expect(openChallenge("pas-un-cookie", "auth")).toBeNull();
    expect(openChallenge("a.b", "auth")).toBeNull();
  });

  // AES-GCM AUTHENTIFIE le chiffré : un octet changé fait échouer `decipher.final()`. C'est ce
  // qui interdit de bricoler un cookie — par exemple d'y repousser l'échéance — sans la clé.
  it.each([
    ["l'IV", 0],
    ["l'étiquette d'authentification", 1],
    ["le chiffré", 2],
  ])("refuse un cookie dont %s a été altéré", (_quoi, partie) => {
    const morceaux = sealChallenge({ challenge: "abc", type: "auth" }).split(".");
    const octets = Buffer.from(morceaux[partie], "base64");
    octets[0] ^= 0x01;
    morceaux[partie] = octets.toString("base64");
    expect(openChallenge(morceaux.join("."), "auth")).toBeNull();
  });

  it("refuse un cookie scellé sous une AUTRE clé (secret changé entre-temps)", () => {
    const scelle = sealChallenge({ challenge: "abc", type: "auth" });
    vi.stubEnv("CREDENTIALS_SECRET", AUTRE_CLE);
    expect(openChallenge(scelle, "auth")).toBeNull();
  });

  // Ces cas ne peuvent pas sortir de `sealChallenge` : on les chiffre à la main, avec la bonne
  // clé, pour vérifier que la validation ne se repose pas sur le seul fait d'avoir pu déchiffrer.
  it("refuse un contenu bien chiffré mais sans défi, avec un défi vide, ou sans échéance", () => {
    const exp = Date.now() + 60_000;
    expect(openChallenge(encrypt(JSON.stringify({ type: "auth", exp })), "auth")).toBeNull();
    expect(
      openChallenge(encrypt(JSON.stringify({ challenge: "", type: "auth", exp })), "auth"),
    ).toBeNull();
    expect(
      openChallenge(encrypt(JSON.stringify({ challenge: "abc", type: "auth" })), "auth"),
    ).toBeNull();
    expect(
      openChallenge(encrypt(JSON.stringify({ challenge: "abc", type: "auth", exp: "demain" })), "auth"),
    ).toBeNull();
  });

  it("refuse un contenu bien chiffré qui n'est pas du JSON", () => {
    expect(openChallenge(encrypt("pas du json"), "auth")).toBeNull();
  });
});

describe("rpParams", () => {
  // Le rpID est un DOMAINE (sans port), l'origine est complète (avec port) : les confondre fait
  // échouer chaque cérémonie en local, où l'appli tourne sur localhost:3000.
  it("sur une URL avec port : rpID sans le port, origine avec", () => {
    const req = new NextRequest("http://localhost:3000/api/auth/passkey/options");
    expect(rpParams(req)).toEqual({ rpID: "localhost", origin: "http://localhost:3000" });
  });

  it("en HTTPS sur le port par défaut : ni port ni barre finale dans l'origine", () => {
    const req = new NextRequest("https://squash.example.org/api/auth/passkey/verify?x=1");
    expect(rpParams(req)).toEqual({
      rpID: "squash.example.org",
      origin: "https://squash.example.org",
    });
  });
});
