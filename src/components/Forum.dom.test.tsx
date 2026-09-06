import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import Forum from "@/components/Forum";

// LE FIL, À L'ÉCRAN.
//
// Quatre propriétés tiennent tout ce composant, et aucune ne se relit dans le JSX :
//
//  1. ON NE SE VOIT PAS PARLER DOUBLE. Son propre message est inséré par la réponse du POST,
//     PUIS renvoyé par le courtier. Sans déduplication par id, il s'affiche deux fois — le
//     défaut classique de toute messagerie optimiste.
//  2. LE FIL MARCHE SANS LE COURTIER. Clés absentes, quota, panne : les messages doivent
//     continuer d'arriver, la frappe et la présence disparaissent en silence. C'est le mode
//     nominal en développement et en production tant que la fonction est en essai.
//  3. LA FRAPPE EST BRIDÉE. Un événement toutes les 3 s au plus. Sans ce frein, la saisie
//     ferait dix fois le volume des messages, et les deux courtiers comptent PAR ABONNÉ.
//  4. LE PUSH RECHARGE LE FIL, mais seulement le sien : le service worker prévient les onglets
//     pour TOUS les push, y compris les alertes de créneau qui n'ont rien à voir.
//  5. « C'EST MOI QUI PARLE » SE DÉRIVE DE `meId`, JAMAIS D'UN DROIT. L'écran s'appuyait sur
//     `canDelete`, qui vaut `admin || auteur` : un ADMIN voyait donc tout le fil aligné à
//     droite, et un message reçu par le courtier n'avait pas le même comportement que le même
//     message après rechargement. Les tests d'alignement ci-dessous ferment cette porte.

// Le module `pusher-js` est chargé dynamiquement par le composant. On le remplace par un
// double inerte : ces tests portent sur le comportement de l'écran, pas sur le réseau.
const canal = vi.hoisted(() => ({
  handlers: new Map<string, (data: unknown) => void>(),
  /** Ce que le composant a émis vers les autres navigateurs. */
  emis: [] as Array<[string, unknown]>,
  membres: null as null | { each: (cb: (m: unknown) => void) => void; me?: unknown },
}));

vi.mock("pusher-js", () => ({
  default: class {
    connection = { bind: () => {} };
    subscribe() {
      return {
        bind: (e: string, cb: (d: unknown) => void) => canal.handlers.set(e, cb),
        trigger: (e: string, d: unknown) => canal.emis.push([e, d]),
        get members() {
          return canal.membres;
        },
      };
    }
    disconnect() {}
  },
}));

const msg = (over: Record<string, unknown> = {}) => ({
  id: "m1",
  body: "Salut",
  authorId: "u2",
  authorName: "Gégé",
  createdAt: "2026-09-05T18:00:00.000Z",
  replyToId: null,
  replyToAuthor: null,
  replyToExcerpt: null,
  ...over,
});

/** Les abonnés au canal du service worker, remis à zéro entre les tests. */
let swListeners: Array<(e: MessageEvent) => void> = [];
Object.defineProperty(globalThis.navigator, "serviceWorker", {
  configurable: true,
  value: {
    addEventListener: (_: string, cb: (e: MessageEvent) => void) => swListeners.push(cb),
    removeEventListener: (_: string, cb: (e: MessageEvent) => void) => {
      swListeners = swListeners.filter((f) => f !== cb);
    },
  },
});

let appels: string[] = [];
/**
 * Les requêtes SORTANTES, corps compris.
 *
 * Le double ne gardait que la méthode et l'URL. Quatre tests promettaient donc ce qui est
 * ENVOYÉ sans jamais le regarder : envoyer `{ optionIds: [celle qui vient de changer] }` au
 * lieu de l'ensemble des cases — l'invariant n°1 du choix multiple — les laissait tous verts.
 * Un corps non lu est un test qui ne teste rien.
 */
let envois: Array<{ methode: string; url: string; corps: Record<string, unknown> | null }> = [];

/** Le corps du dernier envoi correspondant à `methode` et à un fragment d'URL. */
const corpsDe = (methode: string, urlContient: string) =>
  [...envois].reverse().find((e) => e.methode === methode && e.url.includes(urlContient))?.corps ??
  null;
let page: {
  messages: unknown[];
  hasMore?: boolean;
  muted?: boolean;
  meId?: string;
  meName?: string;
  admin?: boolean;
  reactions?: Record<string, unknown>;
  polls?: Record<string, unknown>;
};
let postReponse: { message: unknown } | "erreur";

const toast = vi.fn();
const rendre = () => render(<Forum toast={toast} onExpired={() => false} />);

beforeEach(() => {
  // Les clés viennent du TEST et non de l'environnement : sans ça, la suite passait en local
  // (variables exportées à la main) et échouait en intégration continue, ou l'inverse.
  vi.stubEnv("NEXT_PUBLIC_PUSHER_KEY", "cle-de-test");
  vi.stubEnv("NEXT_PUBLIC_PUSHER_CLUSTER", "eu");
  appels = [];
  envois = [];
  swListeners = [];
  canal.handlers.clear();
  canal.emis = [];
  canal.membres = null;
  page = { messages: [msg()], hasMore: false, muted: false, meId: "u1", meName: "Thomas" };
  postReponse = {
    message: msg({ id: "mien", body: "Coucou", authorId: "u1", authorName: "Thomas" }),
  };
  toast.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const methode = init?.method ?? "GET";
      appels.push(`${methode} ${url}`);
      envois.push({
        methode,
        url,
        corps: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      if (init?.method === "POST") {
        if (postReponse === "erreur") {
          return { ok: false, status: 429, json: async () => ({ error: "Trop de messages" }) };
        }
        return { ok: true, status: 201, json: async () => postReponse };
      }
      if (init?.method === "PATCH") return { ok: true, status: 200, json: async () => ({}) };
      if (init?.method === "DELETE") return { ok: true, status: 200, json: async () => ({ ok: true }) };
      return { ok: true, status: 200, json: async () => page };
    }),
  );
  // jsdom n'implémente pas le défilement : le composant l'appelle après chaque arrivée.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("chargement et affichage", () => {
  it("charge le fil et rend les messages", async () => {
    rendre();
    await waitFor(() => expect(screen.getByText("Salut")).toBeTruthy());
    expect(screen.getByText("Gégé")).toBeTruthy();
  });

  it("dit qu'il n'y a rien, plutôt que d'afficher une liste vide", async () => {
    page = { messages: [] };
    rendre();
    await waitFor(() => expect(screen.getByText(/Lance la conversation/)).toBeTruthy());
  });

  // Le silence serait indiscernable d'un club qui n'a jamais rien écrit — crédible, donc pire.
  it("dit l'échec réseau au lieu de se taire", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    rendre();
    await waitFor(() => expect(screen.getByText(/indisponible/)).toBeTruthy());
  });
});

// LA TOUCHE ENTRÉE, ET LES DEUX CONVENTIONS QU'ELLE SERT. Au clavier physique elle envoie
// (Maj+Entrée passe à la ligne) ; au clavier tactile, où Maj+Entrée n'existe pas, garder
// l'envoi revenait à SUPPRIMER le retour à la ligne — un message en trois points ne pouvait
// plus s'écrire qu'en trois messages. Ces tests tiennent la bascule, qui ne se relit pas dans
// le JSX : elle est dans une media query.
describe("la touche Entrée", () => {
  /** Un appareil où `(pointer: coarse)` répond ce qu'on lui dit. */
  const pointeur = (grossier: boolean) =>
    vi.stubGlobal("matchMedia", (q: string) => ({
      matches: q.includes("coarse") ? grossier : !grossier,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));

  const taper = async () => {
    rendre();
    await waitFor(() => expect(screen.getByText("Salut")).toBeTruthy());
    const zone = screen.getByLabelText("Votre message") as HTMLTextAreaElement;
    fireEvent.change(zone, { target: { value: "Première ligne" } });
    return zone;
  };

  it("envoie au CLAVIER PHYSIQUE — la main ne quitte pas le clavier", async () => {
    pointeur(false);
    const zone = await taper();
    fireEvent.keyDown(zone, { key: "Enter" });
    await waitFor(() => expect(corpsDe("POST", "/api/forum")?.body).toBe("Première ligne"));
  });

  // LE CAS QUI MOTIVE TOUT. `fireEvent` rend `false` si l'événement a été annulé : ce qu'on
  // vérifie ici, c'est que la frappe suit son cours — donc que le navigateur insère le saut.
  it("passe À LA LIGNE au clavier tactile, et n'envoie rien", async () => {
    pointeur(true);
    const zone = await taper();
    expect(fireEvent.keyDown(zone, { key: "Enter" })).toBe(true);
    expect(appels.some((a) => a.startsWith("POST /api/forum"))).toBe(false);
  });

  it("laisse Maj+Entrée passer à la ligne, clavier physique compris", async () => {
    pointeur(false);
    const zone = await taper();
    expect(fireEvent.keyDown(zone, { key: "Enter", shiftKey: true })).toBe(true);
    expect(appels.some((a) => a.startsWith("POST /api/forum"))).toBe(false);
  });

  // Un navigateur sans `matchMedia` (contexte réduit, très vieux moteur) ne doit pas perdre
  // l'envoi au clavier : l'absence de réponse vaut « pointeur fin ».
  it("envoie encore quand `matchMedia` n'existe pas", async () => {
    vi.stubGlobal("matchMedia", undefined);
    const zone = await taper();
    fireEvent.keyDown(zone, { key: "Enter" });
    await waitFor(() => expect(corpsDe("POST", "/api/forum")?.body).toBe("Première ligne"));
  });
});

describe("envoi", () => {
  it("envoie le message et le montre tout de suite", async () => {
    rendre();
    await waitFor(() => expect(screen.getByText("Salut")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Votre message"), { target: { value: "Coucou 👍" } });
    fireEvent.click(screen.getByRole("button", { name: "Envoyer" }));
    await waitFor(() => expect(appels.some((a) => a.startsWith("POST"))).toBe(true));
    // Ce qui est ENVOYÉ, et pas seulement le fait qu'une requête soit partie.
    expect(corpsDe("POST", "/api/forum")?.body).toBe("Coucou 👍");
    // Et « le montre tout de suite » : la réponse est insérée sans attendre le courtier.
    await waitFor(() => expect(screen.getByText("Coucou")).toBeTruthy());
  });

  it("vide le champ après un envoi réussi, et le garde après un refus", async () => {
    rendre();
    const zone = screen.getByLabelText("Votre message") as HTMLTextAreaElement;
    await waitFor(() => expect(screen.getByText("Salut")).toBeTruthy());

    fireEvent.change(zone, { target: { value: "ok" } });
    fireEvent.click(screen.getByRole("button", { name: "Envoyer" }));
    await waitFor(() => expect(zone.value).toBe(""));

    postReponse = "erreur";
    fireEvent.change(zone, { target: { value: "refusé" } });
    fireEvent.click(screen.getByRole("button", { name: "Envoyer" }));
    // Perdre le texte d'un message refusé obligerait à le retaper — le pire moment pour ça.
    await waitFor(() => expect(toast).toHaveBeenCalledWith("err", "Trop de messages"));
    expect(zone.value).toBe("refusé");
  });

  it("n'envoie rien sur un message vide ou fait d'espaces", async () => {
    rendre();
    await waitFor(() => expect(screen.getByText("Salut")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Votre message"), { target: { value: "   " } });
    expect((screen.getByRole("button", { name: "Envoyer" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("le courtier", () => {
  it("ajoute un message reçu SANS refaire de requête", async () => {
    rendre();
    await waitFor(() => expect(screen.getByText("Salut")).toBeTruthy());
    const avant = appels.length;
    act(() => {
      canal.handlers.get("message")?.(msg({ id: "m2", body: "Je prends la voiture", authorName: "Marie" }));
    });
    await waitFor(() => expect(screen.getByText("Je prends la voiture")).toBeTruthy());
    expect(appels.length).toBe(avant);
  });

  // LE TEST QUI JUSTIFIE `fusionner`. Son propre message revient toujours par le courtier
  // après avoir été inséré par la réponse du POST.
  it("NE SE VOIT PAS PARLER DOUBLE quand son message revient par le courtier", async () => {
    rendre();
    await waitFor(() => expect(screen.getByText("Salut")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Votre message"), { target: { value: "Coucou" } });
    fireEvent.click(screen.getByRole("button", { name: "Envoyer" }));
    await waitFor(() => expect(screen.getAllByText("Coucou")).toHaveLength(1));
    // Le courtier renvoie EXACTEMENT le même message, avec le même id : c'est ce qui arrive
    // toujours en vrai, et c'est là que la déduplication se joue.
    act(() => {
      canal.handlers.get("message")?.(msg({ id: "mien", body: "Coucou", authorName: "Thomas" }));
    });
    await waitFor(() => expect(screen.getAllByText("Coucou")).toHaveLength(1));
  });

  it("referme un message supprimé ailleurs", async () => {
    rendre();
    await waitFor(() => expect(screen.getByText("Salut")).toBeTruthy());
    act(() => canal.handlers.get("deleted")?.({ id: "m1" }));
    await waitFor(() => expect(screen.queryByText("Salut")).toBeNull());
  });

  it("annonce qui écrit, et l'oublie tout seul", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    rendre();
    await waitFor(() => expect(screen.getByText("Salut")).toBeTruthy());
    act(() => canal.handlers.get("client-typing")?.({ name: "Marie" }));
    await waitFor(() => expect(screen.getByText("Marie écrit…")).toBeTruthy());
    // Sans cet oubli, quelqu'un qui ferme son onglet en pleine phrase resterait « en train
    // d'écrire » pour toujours.
    await act(async () => {
      vi.advanceTimersByTime(6_000);
    });
    await waitFor(() => expect(screen.queryByText("Marie écrit…")).toBeNull());
  });

  it("BRIDE la frappe à un signal toutes les 3 s", async () => {
    canal.membres = { each: () => {}, me: { id: "u1", info: { name: "Thomas" } } };
    rendre();
    await waitFor(() => expect(screen.getByText("Salut")).toBeTruthy());
    act(() => canal.handlers.get("pusher:subscription_succeeded")?.(null));

    const zone = screen.getByLabelText("Votre message");
    fireEvent.change(zone, { target: { value: "a" } });
    fireEvent.change(zone, { target: { value: "ab" } });
    fireEvent.change(zone, { target: { value: "abc" } });
    const typing = canal.emis.filter(([e]) => e === "client-typing");
    expect(typing).toHaveLength(1);
    // L'identifiant voyage AVEC le nom : la frappe est indexée par id, sinon deux homonymes
    // — un club en a — se confondent en une seule personne et l'un fait taire l'autre.
    expect(typing[0][1]).toEqual({ id: "u1", name: "Thomas" });

    // LA MOITIÉ QUI MANQUAIT. Sans elle, un drapeau « une seule fois par montage » passerait le
    // test : ce qu'on veut n'est pas « un signal », c'est « un signal PAR FENÊTRE ». On avance
    // au-delà des 3 s et on vérifie qu'un second signal repart.
    vi.setSystemTime(Date.now() + 4_000);
    fireEvent.change(zone, { target: { value: "abcd" } });
    expect(canal.emis.filter(([e]) => e === "client-typing")).toHaveLength(2);
  });

  it("affiche qui est en ligne, sans se compter soi-même", async () => {
    canal.membres = {
      me: { id: "u1", info: { name: "Thomas" } },
      each: (cb: (m: unknown) => void) => {
        cb({ id: "u1", info: { name: "Thomas" } });
        cb({ id: "u2", info: { name: "Gégé" } });
      },
    };
    rendre();
    await waitFor(() => expect(screen.getByText("Salut")).toBeTruthy());
    act(() => canal.handlers.get("pusher:subscription_succeeded")?.(null));
    await waitFor(() => expect(screen.getByText("Gégé est en ligne")).toBeTruthy());
  });
});

// LE MODE NOMINAL EN DÉVELOPPEMENT, ET EN PRODUCTION TANT QUE LA FONCTION EST EN ESSAI.
describe("sans le courtier", () => {
  it("reste pleinement utilisable : ni frappe, ni présence, mais les messages passent", async () => {
    // Pas de clé : le bloc du courtier renonce avant même de charger le module. C'est le mode
    // nominal en développement, et en production tant que la fonction est en essai.
    vi.stubEnv("NEXT_PUBLIC_PUSHER_KEY", "");
    vi.stubEnv("NEXT_PUBLIC_PUSHER_CLUSTER", "");
    canal.handlers.clear();
    rendre();
    await waitFor(() => expect(screen.getByText("Salut")).toBeTruthy());
    expect(screen.queryByText(/écrit…/)).toBeNull();
    expect(screen.queryByText(/en ligne/)).toBeNull();

    fireEvent.change(screen.getByLabelText("Votre message"), { target: { value: "Coucou" } });
    fireEvent.click(screen.getByRole("button", { name: "Envoyer" }));
    await waitFor(() => expect(appels.some((a) => a.startsWith("POST"))).toBe(true));
  });
});

describe("le repli sur le push", () => {
  it("recharge le fil quand le service worker signale un push DU FIL", async () => {
    rendre();
    await waitFor(() => expect(screen.getByText("Salut")).toBeTruthy());
    const avant = appels.length;
    act(() => {
      swListeners.forEach((cb) =>
        cb({ data: { type: "push-received", tag: "forum" } } as MessageEvent),
      );
    });
    await waitFor(() => expect(appels.length).toBeGreaterThan(avant));
  });

  it("IGNORE un push qui n'est pas le sien — une alerte de créneau ne recharge pas le fil", async () => {
    rendre();
    await waitFor(() => expect(screen.getByText("Salut")).toBeTruthy());
    const avant = appels.length;
    act(() => {
      swListeners.forEach((cb) =>
        cb({ data: { type: "push-received", tag: "alert-12h" } } as MessageEvent),
      );
    });
    expect(appels.length).toBe(avant);
  });
});

describe("notifications du fil", () => {
  it("coupe et rétablit, et le dit au serveur", async () => {
    rendre();
    await waitFor(() => expect(screen.getByText("Salut")).toBeTruthy());
    // NOM ACCESSIBLE STABLE : c'est `aria-pressed` qui porte l'état, pas le libellé. « Couper
    // les notifications, enfoncé » se lit sans ambiguïté ; « Notifications coupées, enfoncé »
    // ne disait pas si « coupées » décrivait l'état ou l'effet du clic.
    const bouton = () => screen.getByRole("button", { name: /Couper les notifications/ });
    expect(bouton().getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(bouton());
    await waitFor(() => expect(appels.some((a) => a.startsWith("PATCH"))).toBe(true));
    // L'affichage est OPTIMISTE : sans lire le corps, envoyer `{ muted: false }` en dur
    // laisserait l'écran dire « coupées » et le serveur ne rien couper du tout.
    expect(corpsDe("PATCH", "/api/forum")).toEqual({ muted: true });
    await waitFor(() => expect(bouton().getAttribute("aria-pressed")).toBe("true"));
    // Le libellé VISIBLE, lui, change bien : c'est ce qu'on lit d'un coup d'œil.
    expect(bouton().textContent).toContain("coupées");

    fireEvent.click(bouton());
    await waitFor(() => expect(corpsDe("PATCH", "/api/forum")).toEqual({ muted: false }));
  });

  it("reflète l'état reçu du serveur au chargement", async () => {
    page = { messages: [msg()], muted: true, meId: "u1", meName: "Thomas" };
    rendre();
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: /Couper les notifications/ })
          .getAttribute("aria-pressed"),
      ).toBe("true"),
    );
  });
});

describe("suppression", () => {
  it("n'offre le bouton qu'à qui en a le droit", async () => {
    page = {
      messages: [msg({ id: "a", authorId: "u2" }), msg({ id: "b", authorId: "u1" })],
      meId: "u1",
      meName: "Thomas",
    };
    rendre();
    await waitFor(() => expect(screen.getAllByText("Salut")).toHaveLength(2));
    expect(screen.getAllByRole("button", { name: /Supprimer le message/ })).toHaveLength(1);
  });

  it("offre le bouton à l'admin sur TOUS les messages : le fil a besoin d'un modérateur", async () => {
    page = {
      messages: [msg({ id: "a", authorId: "u2" }), msg({ id: "b", authorId: "u3" })],
      meId: "chef",
      meName: "Chef",
      admin: true,
    };
    rendre();
    await waitFor(() => expect(screen.getAllByText("Salut")).toHaveLength(2));
    expect(screen.getAllByRole("button", { name: /Supprimer le message/ })).toHaveLength(2);
  });

  it("retire le message de l'écran une fois supprimé", async () => {
    page = { messages: [msg({ authorId: "u1" })], meId: "u1", meName: "Thomas" };
    rendre();
    await waitFor(() => expect(screen.getByText("Salut")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Supprimer le message/ }));
    await waitFor(() => expect(screen.queryByText("Salut")).toBeNull());
  });
});

// LE DÉFAUT CORRIGÉ, ET SA GARDE.
//
// L'alignement lisait `canDelete`, qui vaut `admin || auteur`. Un administrateur voyait donc
// TOUS les messages du club à droite, comme s'il les avait écrits. Et un message arrivé par le
// courtier était figé à `canDelete: false`, donc jamais aligné à droite pour son auteur.
describe("alignement — « c'est moi qui parle »", () => {
  const estAMoi = (texte: string) =>
    screen.getByText(texte).closest(".forum-rangee")?.classList.contains("is-mine");

  it("aligne à droite les siens, à gauche ceux des autres", async () => {
    page = {
      messages: [
        msg({ id: "a", body: "Des autres", authorId: "u2" }),
        msg({ id: "b", body: "De moi", authorId: "u1" }),
      ],
      meId: "u1",
      meName: "Thomas",
    };
    rendre();
    await waitFor(() => expect(screen.getByText("De moi")).toBeTruthy());
    expect(estAMoi("De moi")).toBe(true);
    expect(estAMoi("Des autres")).toBe(false);
  });

  it("ne donne PAS à l'admin les messages des autres, malgré son droit de supprimer", async () => {
    page = {
      messages: [msg({ id: "a", body: "Des autres", authorId: "u2" })],
      meId: "chef",
      meName: "Chef",
      admin: true,
    };
    rendre();
    await waitFor(() => expect(screen.getByText("Des autres")).toBeTruthy());
    expect(estAMoi("Des autres")).toBe(false);
    // Il garde bien le bouton : c'est le DROIT qui est admin, pas la paternité.
    expect(screen.getByRole("button", { name: /Supprimer le message/ })).toBeTruthy();
  });

  it("aligne à droite un message de soi arrivé PAR LE COURTIER", async () => {
    rendre();
    await waitFor(() => expect(screen.getByText("Salut")).toBeTruthy());
    act(() => {
      canal.handlers.get("message")?.(
        msg({ id: "direct", body: "Depuis un autre onglet", authorId: "u1" }),
      );
    });
    await waitFor(() => expect(screen.getByText("Depuis un autre onglet")).toBeTruthy());
    expect(estAMoi("Depuis un autre onglet")).toBe(true);
  });
});

// LA STRUCTURE DONT DÉPEND LA CORRECTION DE LA PUCE.
//
// Pico pose `ul li { list-style: square }` — spécificité (0,0,2), qui vise le LI et bat donc
// l'héritage de `list-style: none` posé sur le UL : une puce carrée s'affichait devant chaque
// bulle. La règle corrective est `.forum-list li`. La feuille de style n'est pas chargée en
// test, mais sa CIBLE l'est : si le balisage cesse d'être des `li` dans une `ul.forum-list`,
// la correction ne s'applique plus en silence, et ce test est ce qui le dit.
describe("structure de la liste", () => {
  it("rend chaque message comme un `li` de `ul.forum-list`", async () => {
    rendre();
    await waitFor(() => expect(screen.getByText("Salut")).toBeTruthy());
    const li = screen.getByText("Salut").closest("li");
    expect(li).not.toBeNull();
    expect(li?.parentElement?.tagName).toBe("UL");
    expect(li?.parentElement?.classList.contains("forum-list")).toBe(true);
  });
});

describe("séparateurs de date", () => {
  // DATES LOCALES, SANS `Z`, comme le fait déjà `forum-texte.test.ts`. `memeJour` compare des
  // jours CIVILS LOCAUX : avec des instants UTC, ces trois horodatages tombent le même jour à
  // Honolulu (UTC−10) et le test rendait un séparateur au lieu de deux. Un test qui dépend du
  // fuseau de la machine passe en local et échoue en intégration continue, ou l'inverse.
  it("pose un séparateur par jour, et un seul", async () => {
    page = {
      messages: [
        msg({ id: "a", body: "Hier soir", createdAt: "2026-09-04T18:00:00" }),
        msg({ id: "b", body: "Hier plus tard", createdAt: "2026-09-04T20:00:00" }),
        msg({ id: "c", body: "Ce matin", createdAt: "2026-09-05T09:00:00" }),
      ],
      meId: "u1",
      meName: "Thomas",
    };
    rendre();
    await waitFor(() => expect(screen.getByText("Ce matin")).toBeTruthy());
    expect(document.querySelectorAll(".forum-jour")).toHaveLength(2);
  });
});

describe("les liens dans un message", () => {
  it("rend une adresse cliquable, sans toucher au reste du texte", async () => {
    page = {
      messages: [msg({ body: "Le tournoi c'est sur https://squashnet.fr/x merci" })],
      meId: "u1",
      meName: "Thomas",
    };
    rendre();
    const lien = await screen.findByRole("link");
    expect(lien.getAttribute("href")).toBe("https://squashnet.fr/x");
    expect(lien.getAttribute("rel")).toContain("noopener");
    expect(screen.getByText(/Le tournoi/)).toBeTruthy();
    expect(screen.getByText(/merci/)).toBeTruthy();
  });

  it("ne fabrique aucun lien pour un `javascript:`", async () => {
    page = {
      messages: [msg({ body: "javascript:alert(1)" })],
      meId: "u1",
      meName: "Thomas",
    };
    rendre();
    await waitFor(() => expect(screen.getByText("javascript:alert(1)")).toBeTruthy());
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("la palette d'emoji", () => {
  it("insère À LA POSITION DU CURSEUR, pas en fin de champ", async () => {
    rendre();
    await waitFor(() => expect(screen.getByText("Salut")).toBeTruthy());
    const champ = screen.getByLabelText("Votre message") as HTMLTextAreaElement;
    fireEvent.change(champ, { target: { value: "Bien joue" } });
    champ.setSelectionRange(4, 4); // juste après « Bien »
    fireEvent.click(screen.getByRole("button", { name: "Emoji" }));
    // Des BOUTONS ordinaires, plus un `role="menu"` : ce rôle promettait des flèches
    // directionnelles et un piège de focus que rien n'implémentait.
    fireEvent.click(screen.getByRole("button", { name: "Insérer 🔥" }));
    await waitFor(() => expect(champ.value).toBe("Bien🔥 joue"));
  });
});

// L'APPUI LONG — le geste des messageries. Il n'a aucun équivalent au clavier et ne s'annonce
// à aucun lecteur d'écran : le bouton ⊕ de l'en-tête reste donc, et c'est lui le chemin
// accessible. Ces tests verrouillent les deux, plus les trois gestes qui ne doivent PAS ouvrir
// la palette — un défilement, un appui bref, et un appui posé sur un bouton.
describe("appui long sur une bulle", () => {
  /** La bulle du message `m1`, celle qui porte les gestes. */
  const bulle = () => document.querySelector(".forum-bulle") as HTMLElement;
  const choix = () => document.querySelector(".forum-choix");

  const appuyer = (el: HTMLElement, over: Record<string, unknown> = {}) =>
    fireEvent.pointerDown(el, { pointerType: "touch", clientX: 50, clientY: 50, ...over });

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  it("ouvre la palette de choix après un appui maintenu", async () => {
    rendre();
    await waitFor(() => expect(screen.getByText("Salut")).toBeTruthy());
    expect(choix()).toBeNull();

    appuyer(bulle());
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(choix()).not.toBeNull();
    // Les six réactions de la liste fermée — et RIEN de plus qui prétende en être une : le
    // bouton « Copier » partage leur apparence mais est une ACTION, séparée par un filet.
    expect(
      document.querySelectorAll(".forum-choix-un:not(.forum-choix-copier)"),
    ).toHaveLength(6);
    expect(document.querySelector(".forum-choix-sep")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Copier le message" })).toBeTruthy();
  });

  it("n'ouvre RIEN sur un appui bref — c'est une lecture, pas un geste", async () => {
    rendre();
    await waitFor(() => expect(screen.getByText("Salut")).toBeTruthy());
    appuyer(bulle());
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    fireEvent.pointerUp(bulle());
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(choix()).toBeNull();
  });

  // LE CAS QUI COMPTE LE PLUS : on remonte le fil, le doigt traîne sur une bulle. Ouvrir une
  // palette à chaque défilement rendrait le fil inutilisable au pouce.
  it("n'ouvre RIEN quand le doigt part en défilement", async () => {
    rendre();
    await waitFor(() => expect(screen.getByText("Salut")).toBeTruthy());
    appuyer(bulle());
    fireEvent.pointerMove(bulle(), { clientX: 50, clientY: 130 });
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(choix()).toBeNull();
  });

  // Un appui qui commence SUR un bouton appartient à ce bouton : maintenir « Répondre » ne doit
  // pas ouvrir une palette par-dessus l'action qu'on est en train de déclencher.
  it("n'ouvre RIEN quand l'appui commence sur un bouton", async () => {
    rendre();
    await waitFor(() => expect(screen.getByText("Salut")).toBeTruthy());
    fireEvent.pointerDown(screen.getByRole("button", { name: /Répondre à Gégé/ }), {
      pointerType: "touch",
      clientX: 50,
      clientY: 50,
    });
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(choix()).toBeNull();
  });

  // À la souris, maintenir un clic ne veut rien dire — et l'on empêcherait la sélection d'un
  // texte qu'on est simplement en train de lire.
  it("ne se déclenche pas à la souris", async () => {
    rendre();
    await waitFor(() => expect(screen.getByText("Salut")).toBeTruthy());
    appuyer(bulle(), { pointerType: "mouse" });
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(choix()).toBeNull();
  });

  it("pose la réaction choisie, et referme", async () => {
    rendre();
    await waitFor(() => expect(screen.getByText("Salut")).toBeTruthy());
    appuyer(bulle());
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    fireEvent.click(screen.getByRole("button", { name: "Réagir avec 👍" }));
    await waitFor(() =>
      expect(appels.some((a) => a === "POST /api/forum/m1/reaction")).toBe(true),
    );
    expect(corpsDe("POST", "/reaction")).toEqual({ emoji: "👍" });
    await waitFor(() => expect(choix()).toBeNull());
  });

  it("se referme sur Échap et sur un appui à côté", async () => {
    rendre();
    await waitFor(() => expect(screen.getByText("Salut")).toBeTruthy());

    appuyer(bulle());
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    fireEvent.keyDown(choix() as Element, { key: "Escape" });
    await waitFor(() => expect(choix()).toBeNull());

    appuyer(bulle());
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    fireEvent.pointerDown(document.querySelector(".forum-voile") as Element);
    await waitFor(() => expect(choix()).toBeNull());
  });

  // Le chemin ACCESSIBLE, celui du clavier et du lecteur d'écran. L'appui long ne le remplace
  // pas : il s'y ajoute.
  it("s'ouvre aussi par le bouton ⊕, qui reste le chemin au clavier", async () => {
    rendre();
    await waitFor(() => expect(screen.getByText("Salut")).toBeTruthy());
    const declencheur = screen.getByRole("button", { name: /Réagir au message de Gégé/ });
    expect(declencheur.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(declencheur);
    await waitFor(() => expect(choix()).not.toBeNull());
    expect(
      screen.getByRole("button", { name: /Réagir au message de Gégé/ }).getAttribute("aria-expanded"),
    ).toBe("true");
  });

  // COPIER — la contrepartie de `user-select: none`. Au doigt, on ne peut plus sélectionner le
  // texte d'un message ; cette action rend ce qu'on a retiré, au même geste. Sans elle, le
  // correctif des poignées de sélection serait une perte nette.
  describe("copier le message", () => {
    let copie: string | null;

    beforeEach(() => {
      copie = null;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: vi.fn(async (t: string) => {
            copie = t;
          }),
        },
      });
    });

    it("copie le CORPS du message, et referme", async () => {
      rendre();
      await waitFor(() => expect(screen.getByText("Salut")).toBeTruthy());
      appuyer(bulle());
      await act(async () => {
        vi.advanceTimersByTime(500);
      });
      fireEvent.click(screen.getByRole("button", { name: "Copier le message" }));
      await waitFor(() => expect(copie).toBe("Salut"));
      await waitFor(() => expect(choix()).toBeNull());
      expect(toast).toHaveBeenCalledWith("ok", "Message copié");
    });

    // Ce n'est PAS une réaction : rien ne doit partir au serveur, rien ne doit se poser sur le
    // message. C'est ce que le filet de séparation dit à l'œil, et ce test à la suite.
    it("n'écrit rien au serveur — copier n'est pas réagir", async () => {
      rendre();
      await waitFor(() => expect(screen.getByText("Salut")).toBeTruthy());
      appuyer(bulle());
      await act(async () => {
        vi.advanceTimersByTime(500);
      });
      fireEvent.click(screen.getByRole("button", { name: "Copier le message" }));
      await waitFor(() => expect(copie).toBe("Salut"));
      expect(appels.some((a) => a.includes("/reaction"))).toBe(false);
    });

    // Un bouton qui ne fait rien EN SILENCE laisse croire que la copie a eu lieu, et on s'en
    // aperçoit au moment de coller, ailleurs. Presse-papiers refusé, ou contexte non sécurisé.
    it("le dit quand le presse-papiers refuse, au lieu de se taire", async () => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: vi.fn(async () => {
            throw new Error("NotAllowedError");
          }),
        },
      });
      rendre();
      await waitFor(() => expect(screen.getByText("Salut")).toBeTruthy());
      appuyer(bulle());
      await act(async () => {
        vi.advanceTimersByTime(500);
      });
      fireEvent.click(screen.getByRole("button", { name: "Copier le message" }));
      await waitFor(() => expect(toast).toHaveBeenCalledWith("err", "Copie impossible"));
    });
  });

  // Ce que la palette montre AVANT le clic. Ses boutons basculent : sans cet état, cliquer 👍
  // alors qu'on l'avait déjà mis le retire sans que rien ne l'annonce.
  it("montre ce qu'on a déjà posé, et dit que le clic va le retirer", async () => {
    page = {
      messages: [msg()],
      meId: "u1",
      meName: "Thomas",
      reactions: { m1: [{ emoji: "👍", users: [{ id: "u1", name: "Thomas" }] }] },
    };
    rendre();
    await waitFor(() => expect(screen.getByText("Salut")).toBeTruthy());
    appuyer(bulle());
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    const deja = screen.getByRole("button", { name: "Retirer 👍" });
    expect(deja.getAttribute("aria-pressed")).toBe("true");
    expect(deja.className).toContain("is-mienne");
    expect(screen.getByRole("button", { name: "Réagir avec 💪" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });
});

describe("les réactions", () => {
  // LA STRUCTURE, et non l'apparence : les pastilles sont HORS de la bulle, sœurs du message et
  // non ses enfants. C'est ce qui permet au CSS de les poser à cheval sur son bord bas, et ce
  // qui les distingue du message — une réaction le commente, elle n'en fait pas partie. Dedans,
  // elles se lisaient comme une dernière ligne écrite par l'auteur.
  it("pose les pastilles À CÔTÉ de la bulle, jamais dedans", async () => {
    page = {
      messages: [msg()],
      meId: "u1",
      meName: "Thomas",
      reactions: { m1: [{ emoji: "👍", users: [{ id: "u2", name: "Gégé" }] }] },
    };
    rendre();
    await waitFor(() => expect(screen.getByText("Salut")).toBeTruthy());
    const reacs = document.querySelector(".forum-reacs") as HTMLElement;
    expect(reacs).not.toBeNull();
    expect(reacs.closest(".forum-msg")).toBeNull();
    expect(reacs.parentElement?.classList.contains("forum-bulle")).toBe(true);
    // La classe qui réserve, en CSS, la place prise en dehors de la bulle.
    expect(document.querySelector(".forum-ligne")?.classList.contains("a-reac")).toBe(true);
  });

  it("ne réserve aucune place quand il n'y a aucune réaction", async () => {
    rendre();
    await waitFor(() => expect(screen.getByText("Salut")).toBeTruthy());
    expect(document.querySelector(".forum-reacs")).toBeNull();
    expect(document.querySelector(".forum-ligne")?.classList.contains("a-reac")).toBe(false);
  });

  it("affiche le décompte et met en avant la sienne", async () => {
    page = {
      messages: [msg()],
      meId: "u1",
      meName: "Thomas",
      reactions: {
        m1: [
          { emoji: "👍", users: [{ id: "u1", name: "Thomas" }, { id: "u2", name: "Gégé" }] },
          { emoji: "💪", users: [{ id: "u2", name: "Gégé" }] },
        ],
      },
    };
    rendre();
    const pouce = await screen.findByRole("button", { name: /👍 2/ });
    expect(pouce.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /💪 1/ }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  // Le delta diffusé doit pouvoir être rejoué : il arrive après l'affichage optimiste.
  it("applique un delta reçu du courtier sans compter double", async () => {
    page = {
      messages: [msg()],
      meId: "u1",
      meName: "Thomas",
      reactions: { m1: [{ emoji: "👍", users: [{ id: "u2", name: "Gégé" }] }] },
    };
    rendre();
    await screen.findByRole("button", { name: /👍 1/ });
    const delta = { messageId: "m1", emoji: "👍", userId: "u3", userName: "Léa", on: true };
    act(() => canal.handlers.get("reaction")?.(delta));
    await waitFor(() => expect(screen.getByRole("button", { name: /👍 2/ })).toBeTruthy());
    act(() => canal.handlers.get("reaction")?.(delta)); // rejoué : rien ne doit bouger
    await waitFor(() => expect(screen.getByRole("button", { name: /👍 2/ })).toBeTruthy());
  });

  it("retire la pastille quand la dernière réaction s'en va", async () => {
    page = {
      messages: [msg()],
      meId: "u1",
      meName: "Thomas",
      reactions: { m1: [{ emoji: "🎾", users: [{ id: "u2", name: "Gégé" }] }] },
    };
    rendre();
    await screen.findByRole("button", { name: /🎾 1/ });
    act(() =>
      canal.handlers
        .get("reaction")
        ?.({ messageId: "m1", emoji: "🎾", userId: "u2", userName: "Gégé", on: false }),
    );
    await waitFor(() => expect(screen.queryByRole("button", { name: /🎾 1/ })).toBeNull());
  });
});

describe("le sondage", () => {
  const sondage = {
    id: "p1",
    messageId: "m1",
    closedAt: null,
    options: [
      {
        id: "o1",
        label: "Jeudi",
        voters: [{ id: "u1", name: "Thomas" }, { id: "u2", name: "Gégé" }],
      },
      { id: "o2", label: "Vendredi", voters: [{ id: "u1", name: "Thomas" }] },
      { id: "o3", label: "Samedi", voters: [] },
    ],
  };

  // LE PIÈGE DU CHOIX MULTIPLE : le total des voix dépasse le nombre de votants. L'écran doit
  // dire les deux, sans quoi « 3 voix » pour 2 personnes passe pour une erreur de comptage.
  it("distingue les votants des voix", async () => {
    page = { messages: [msg()], meId: "u1", meName: "Thomas", polls: { m1: sondage } };
    rendre();
    await waitFor(() => expect(screen.getByText(/2 votants · 3 voix/)).toBeTruthy());
  });

  it("montre ce que l'on a coché", async () => {
    page = { messages: [msg()], meId: "u1", meName: "Thomas", polls: { m1: sondage } };
    rendre();
    const jeudi = await screen.findByRole("button", { name: /Jeudi/ });
    expect(jeudi.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /Samedi/ }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("nomme les votants d'une option, parce que le vote n'est pas secret", async () => {
    page = { messages: [msg()], meId: "u1", meName: "Thomas", polls: { m1: sondage } };
    rendre();
    const jeudi = await screen.findByRole("button", { name: /Jeudi/ });
    expect(jeudi.getAttribute("title")).toBe("Thomas, Gégé");
  });

  // L'INVARIANT N°1 DU CHOIX MULTIPLE, et le seul endroit où il se vérifie côté client. La
  // fixture a déjà « Jeudi » coché par u1 : cocher « Samedi » doit envoyer LES DEUX. N'envoyer
  // que l'option qui vient de changer effacerait le vote précédent, puisque la route REMPLACE.
  it("envoie l'ENSEMBLE des cases cochées, pas la seule qui vient de changer", async () => {
    page = { messages: [msg()], meId: "u1", meName: "Thomas", polls: { m1: sondage } };
    rendre();
    fireEvent.click(await screen.findByRole("button", { name: /Samedi/ }));
    await waitFor(() =>
      expect(appels.some((a) => a === "POST /api/forum/poll/p1/vote")).toBe(true),
    );
    // u1 avait déjà « Jeudi » (o1) et « Vendredi » (o2) : cocher « Samedi » doit envoyer LES
    // TROIS, et non le seul o3.
    const envoye = corpsDe("POST", "/vote")?.optionIds as string[];
    expect([...envoye].sort()).toEqual(["o1", "o2", "o3"]);
  });

  // Décocher est le geste symétrique : la case retirée ne doit PAS repartir dans la liste.
  it("retire la case décochée de l'ensemble envoyé", async () => {
    page = { messages: [msg()], meId: "u1", meName: "Thomas", polls: { m1: sondage } };
    rendre();
    fireEvent.click(await screen.findByRole("button", { name: /Jeudi/ }));
    await waitFor(() =>
      expect(appels.some((a) => a === "POST /api/forum/poll/p1/vote")).toBe(true),
    );
    // « Jeudi » retiré, « Vendredi » conservé : c'est bien l'ensemble qui part, amputé d'une
    // case, et non un différentiel.
    expect(corpsDe("POST", "/vote")?.optionIds).toEqual(["o2"]);
  });

  it("interdit le vote sur un sondage clos", async () => {
    page = {
      messages: [msg()],
      meId: "u1",
      meName: "Thomas",
      polls: { m1: { ...sondage, closedAt: "2026-09-05T20:00:00.000Z" } },
    };
    rendre();
    const jeudi = await screen.findByRole("button", { name: /Jeudi/ });
    expect((jeudi as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/clos/)).toBeTruthy();
  });
});

describe("la citation", () => {
  it("montre l'auteur et l'extrait de ce à quoi on répond", async () => {
    page = {
      messages: [
        msg({
          id: "b",
          body: "Je prends une place",
          replyToId: "a",
          replyToAuthor: "Gégé",
          replyToExcerpt: "Covoit jeudi : 4 places",
        }),
      ],
      meId: "u1",
      meName: "Thomas",
    };
    rendre();
    await waitFor(() => expect(screen.getByText("Covoit jeudi : 4 places")).toBeTruthy());
    // L'auteur cité est lu DANS la citation : « Gégé » apparaît aussi comme auteur du
    // message dans d'autres cas, et une recherche globale confondrait les deux.
    const citation = document.querySelector(".forum-citation");
    expect(citation?.querySelector("strong")?.textContent).toBe("Gégé");
  });

  // Ce que la notice promet : effacer son message l'efface PARTOUT. La citation ne survit donc
  // pas à sa cible — ni son texte, ni un « Message supprimé » à sa place. La base ne garde
  // aucune trace (`ON DELETE SET NULL`), l'écran non plus, et les deux chemins s'accordent.
  it("n'affiche aucune citation quand la cible a disparu", async () => {
    page = {
      messages: [msg({ id: "b", body: "Je prends une place", replyToId: null })],
      meId: "u1",
      meName: "Thomas",
    };
    rendre();
    await waitFor(() => expect(screen.getByText("Je prends une place")).toBeTruthy());
    expect(document.querySelector(".forum-citation")).toBeNull();
  });

  // LE DÉFAUT QUE CE TEST VERROUILLE : l'affichage divergeait selon le chemin. En direct le
  // client gardait `replyToId` et affichait « Message supprimé » ; après rechargement la clé
  // arrivait nulle de la base et la citation disparaissait entièrement. Le même geste donnait
  // deux écrans différents selon qu'on avait rafraîchi ou non.
  it("retire la citation entière quand le courtier annonce la suppression de la cible", async () => {
    page = {
      messages: [
        msg({ id: "a", body: "Covoit jeudi" }),
        msg({
          id: "b",
          body: "Je prends une place",
          replyToId: "a",
          replyToAuthor: "Gégé",
          replyToExcerpt: "Covoit jeudi",
        }),
      ],
      meId: "u1",
      meName: "Thomas",
    };
    rendre();
    await waitFor(() => expect(screen.getAllByText("Covoit jeudi")).toHaveLength(2));
    act(() => canal.handlers.get("deleted")?.({ id: "a" }));
    await waitFor(() => expect(document.querySelector(".forum-citation")).toBeNull());
    expect(screen.queryByText("Covoit jeudi")).toBeNull();
    expect(screen.queryByText("Message supprimé")).toBeNull();
    // La réponse, elle, reste : effacer une question n'efface pas la discussion.
    expect(screen.getByText("Je prends une place")).toBeTruthy();
  });

  it("joint la citation à l'envoi après un clic sur « Répondre »", async () => {
    rendre();
    await waitFor(() => expect(screen.getByText("Salut")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Répondre à Gégé/ }));
    await waitFor(() => expect(screen.getByText(/Réponse à/)).toBeTruthy());
    const champ = screen.getByLabelText("Votre message");
    fireEvent.change(champ, { target: { value: "Je viens" } });
    fireEvent.submit(champ.closest("form") as HTMLFormElement);
    await waitFor(() => expect(screen.getByText("Coucou")).toBeTruthy());
    // C'est `replyTo` qui fait la citation : sans cette assertion, le supprimer de l'envoi
    // laissait le test vert et la réponse partait sans rattacher à quoi elle répond.
    expect(corpsDe("POST", "/api/forum")).toEqual({ body: "Je viens", replyTo: "m1" });
    // La barre de citation disparaît une fois le message parti.
    expect(screen.queryByText(/Réponse à/)).toBeNull();
  });
});
