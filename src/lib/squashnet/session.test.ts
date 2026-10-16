import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AccesRefuse, SessionInvalide, ouvrirSession, posterAjax, posterFormulaire } from "./session";

// ============================================================================
//  LA SESSION SQUASHNET — cookies, jeton, refus. Le réseau est simulé.
//
//  Ce que ces tests tiennent : le jeton `ic_csrf` part dans chaque POST (sans
//  lui, squashnet répond « Session expirée ou requête invalide », mesuré), le
//  cookie de session suit, les deux pages de refus deviennent des erreurs
//  TYPÉES — et le mot de passe ne ressort JAMAIS d'une erreur.
// ============================================================================

type Appel = { url: string; method: string; headers: Record<string, string>; body: unknown };
let appels: Appel[] = [];
let reponses: Array<() => Response> = [];

const MDP = "m0t-de-passe-secret";

function reponse(body: string, cookies: string[] = [], status = 200): () => Response {
  return () => {
    const h = new Headers({ "content-type": "text/html" });
    for (const c of cookies) h.append("set-cookie", c);
    return new Response(body, { status, headers: h });
  };
}

const PAGE_CONNEXION =
  '<form method="post" action="index.php"><input name="ic_a" type="hidden" value="131328">' +
  '<input name="ic_csrf" type="hidden" value="JETON-PAGE"></form>';

beforeEach(() => {
  appels = [];
  reponses = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      appels.push({
        url,
        method: init.method ?? "GET",
        headers: init.headers as Record<string, string>,
        body: init.body,
      });
      const r = reponses.shift();
      if (!r) throw new Error("appel inattendu");
      return r();
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

async function connecte() {
  reponses.push(
    reponse(PAGE_CONNEXION, ["PHPSESSID=abc; path=/; secure; HttpOnly", "ic_csrf=JETON%2BCOOKIE; path=/"]),
    reponse('{"cb":"endMsg"}', ["PHPSESSID=def; path=/"]),
  );
  return ouvrirSession("thomas", MDP);
}

describe("ouvrirSession", () => {
  it("lit la page de connexion, puis poste identifiants et jeton avec le cookie reçu", async () => {
    const s = await connecte();
    expect(appels[0]).toMatchObject({ url: "https://www.squashnet.fr/connexion", method: "GET" });
    const login = appels[1];
    expect(login.url).toBe("https://www.squashnet.fr/index.php");
    expect(Object.fromEntries(new URLSearchParams(String(login.body)))).toEqual({
      ic_a: "131328",
      ic_ajax: "1",
      ic_csrf: "JETON-PAGE",
      login: "thomas",
      pwd: MDP,
    });
    expect(login.headers.cookie).toBe("PHPSESSID=abc; ic_csrf=JETON%2BCOOKIE");
    // La session tourne à la connexion : c'est le NOUVEAU cookie qu'on garde.
    expect(s.cookies.get("PHPSESSID")).toBe("def");
  });

  it("ne cite pas le mot de passe quand squashnet répond en erreur", async () => {
    reponses.push(reponse(PAGE_CONNEXION), reponse("panne", [], 500));
    const e = await ouvrirSession("thomas", MDP).catch((x: Error) => x);
    expect(e).toBeInstanceOf(Error);
    expect(String((e as Error).message)).not.toContain(MDP);
  });
});

describe("posterAjax", () => {
  it("joint le jeton du COOKIE (décodé) et marque l'appel comme AJAX", async () => {
    const s = await connecte();
    reponses.push(reponse("<form id='frmResults'></form>"));
    await posterAjax(s, { ic_a: "330249", tieid: "1893481" });
    const a = appels[2];
    expect(Object.fromEntries(new URLSearchParams(String(a.body)))).toEqual({
      ic_a: "330249",
      tieid: "1893481",
      ic_ajax: "1",
      ic_csrf: "JETON+COOKIE",
    });
    expect(a.headers["x-requested-with"]).toBe("XMLHttpRequest");
    expect(a.headers.origin).toBe("https://www.squashnet.fr");
    expect(a.headers.cookie).toContain("PHPSESSID=def");
  });

  it("fait de la page « Erreur 403 » un refus d'accès typé", async () => {
    const s = await connecte();
    reponses.push(reponse("<h1>Oups</h1> Erreur 403, merci de vous connecter avec le bon compte"));
    await expect(posterAjax(s, { ic_a: "330249" })).rejects.toBeInstanceOf(AccesRefuse);
  });

  it("fait de « Session expirée » une session invalide typée", async () => {
    const s = await connecte();
    reponses.push(reponse("Session expirée ou requête invalide. Merci de recharger la page et réessayer."));
    await expect(posterAjax(s, { ic_a: "330249" })).rejects.toBeInstanceOf(SessionInvalide);
  });
});

describe("posterFormulaire", () => {
  it("envoie un multipart avec les champs, le jeton et ic_ajax", async () => {
    const s = await connecte();
    reponses.push(reponse("ok"));
    await posterFormulaire(s, { ic_a: "330250", h1_1: "648361", sch1_1: "11" });
    const corps = appels[2].body as FormData;
    expect(corps).toBeInstanceOf(FormData);
    expect(Object.fromEntries(corps)).toEqual({
      ic_a: "330250",
      h1_1: "648361",
      sch1_1: "11",
      ic_ajax: "1",
      ic_csrf: "JETON+COOKIE",
    });
    // La frontière multipart est l'affaire de `fetch` : un content-type posé à la main la perdrait.
    expect(appels[2].headers["content-type"]).toBeUndefined();
  });
});
