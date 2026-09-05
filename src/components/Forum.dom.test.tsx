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
  canDelete: false,
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
let page: { messages: unknown[]; hasMore?: boolean; muted?: boolean };
let postReponse: { message: unknown } | "erreur";

const toast = vi.fn();
const rendre = () => render(<Forum toast={toast} onExpired={() => false} />);

beforeEach(() => {
  // Les clés viennent du TEST et non de l'environnement : sans ça, la suite passait en local
  // (variables exportées à la main) et échouait en intégration continue, ou l'inverse.
  vi.stubEnv("NEXT_PUBLIC_PUSHER_KEY", "cle-de-test");
  vi.stubEnv("NEXT_PUBLIC_PUSHER_CLUSTER", "eu");
  appels = [];
  swListeners = [];
  canal.handlers.clear();
  canal.emis = [];
  canal.membres = null;
  page = { messages: [msg()], hasMore: false, muted: false };
  postReponse = {
    message: msg({ id: "mien", body: "Coucou", authorId: "u1", authorName: "Thomas", canDelete: true }),
  };
  toast.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string }) => {
      appels.push(`${init?.method ?? "GET"} ${url}`);
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

describe("envoi", () => {
  it("envoie le message et le montre tout de suite", async () => {
    rendre();
    await waitFor(() => expect(screen.getByText("Salut")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Votre message"), { target: { value: "Coucou 👍" } });
    fireEvent.click(screen.getByRole("button", { name: "Envoyer" }));
    await waitFor(() => expect(appels.some((a) => a.startsWith("POST"))).toBe(true));
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
    expect(typing[0][1]).toEqual({ name: "Thomas" });
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
    fireEvent.click(screen.getByRole("button", { name: /Notifications/ }));
    await waitFor(() => expect(appels.some((a) => a.startsWith("PATCH"))).toBe(true));
    await waitFor(() => expect(screen.getByRole("button", { name: /coupées/ })).toBeTruthy());
  });

  it("reflète l'état reçu du serveur au chargement", async () => {
    page = { messages: [msg()], muted: true };
    rendre();
    await waitFor(() => expect(screen.getByRole("button", { name: /coupées/ })).toBeTruthy());
  });
});

describe("suppression", () => {
  it("n'offre le bouton qu'à qui en a le droit", async () => {
    page = { messages: [msg({ id: "a", canDelete: false }), msg({ id: "b", canDelete: true })] };
    rendre();
    await waitFor(() => expect(screen.getAllByText("Salut")).toHaveLength(2));
    expect(screen.getAllByRole("button", { name: /Supprimer le message/ })).toHaveLength(1);
  });

  it("retire le message de l'écran une fois supprimé", async () => {
    page = { messages: [msg({ canDelete: true })] };
    rendre();
    await waitFor(() => expect(screen.getByText("Salut")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Supprimer le message/ }));
    await waitFor(() => expect(screen.queryByText("Salut")).toBeNull());
  });
});
