import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import InterclubScorer from "@/components/InterclubScorer";

// LA CONCURRENCE OPTIMISTE DU MARQUEUR, ET LES DEUX FAÇONS DONT ELLE SE RETOURNAIT CONTRE LUI.
//
// `knownGameCount` protège d'un journal calculé sur un état que la base a dépassé : le marqueur
// annonce le nombre de jeux que le serveur lui avait confirmés, et si la base en a un autre,
// c'est que quelqu'un a écrit entre-temps. La réaction à ce refus est la plus destructrice du
// fichier — `clearLog`, sur la seule copie du match. Elle n'est donc juste que si le refus l'est.
//
// Elle ne l'était pas dans deux cas, tous deux atteignables sans concurrence d'aucune sorte :
//
//   1. DEUX ENVOIS EN VOL. Ils portent le même compte ; le premier à commiter périme l'autre.
//      « Retour » et « Terminer » appellent `finish` sans garde, et `finish` n'annulait qu'un
//      minuteur, pas une requête déjà partie.
//   2. UNE RÉPONSE PERDUE. Le serveur commit, la réponse n'arrive pas ; le marqueur affirme
//      ensuite un compte dépassé de un et se déclare en conflit AVEC LUI-MÊME.
//
// Ces tests lisent donc le CORPS des requêtes et l'état du stockage local, pas l'écran.

const MATCH_ID = "m1";
const ACK_KEY = `ic:ack:${MATCH_ID}`;
const LOG_KEY = `ic:log:${MATCH_ID}`;

/** Un simple dont le serveur a déjà confirmé UN jeu : l'accusé de réception vaut donc 1. */
const MATCH = {
  id: MATCH_ID,
  order: 1,
  homeDisplayName: "Thomas",
  awayName: "Gérard",
  homeColor: null,
  awayColor: null,
  games: [{ number: 1, home: 11, away: 5 }],
  // Aucun jeu en cours côté serveur : ces cas éprouvent le marquage à partir de rien.
  live: null,
};

type Envoi = { url: string; corps: Record<string, unknown> };
let envois: Envoi[] = [];

function reponse(ok: boolean, corps: unknown = {}): Response {
  return { ok, status: ok ? 200 : 500, json: async () => corps } as unknown as Response;
}

async function souffle() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

function monte(onClose = vi.fn()) {
  const rendu = render(
    <InterclubScorer
      fixtureId="f1"
      match={MATCH}
      bestOf={5}
      onClose={onClose}
      onExpired={(status) => status === 401}
      toast={vi.fn()}
    />,
  );
  return { ...rendu, onClose };
}

beforeEach(() => {
  envois = [];
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("InterclubScorer — deux envois ne se croisent jamais", () => {
  it("met le second envoi EN FILE au lieu de le lancer contre le premier", async () => {
    // Le premier envoi reste en vol tant qu'on ne le relâche pas.
    let relacher: (() => void) | null = null;
    const enVol = new Promise<void>((r) => {
      relacher = r;
    });
    let premier = true;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        envois.push({ url: String(url), corps: JSON.parse(String(init?.body)) });
        if (premier) {
          premier = false;
          await enVol;
        }
        return reponse(true);
      }),
    );

    const { getByText } = monte();
    await souffle();

    // Deux appuis coup sur coup sur « Retour » — le double-tap ordinaire, ou « Terminer »
    // suivi de « Retour ». Chacun appelle `finish`, donc `push`.
    fireEvent.click(getByText("← Retour"));
    await souffle();
    fireEvent.click(getByText("← Retour"));
    await souffle();

    // UNE SEULE requête est partie : la seconde attend le verdict de la première.
    expect(envois.length).toBe(1);
    expect(envois[0].corps.knownGameCount).toBe(1);

    // On relâche : la seconde part alors, avec le compte remis à jour par la première.
    await act(async () => {
      relacher?.();
      for (let i = 0; i < 20; i++) await Promise.resolve();
    });

    expect(envois.length).toBe(2);
    expect(envois[1].corps.knownGameCount).toBe(1);
  });
});

describe("InterclubScorer — on n'affirme que ce qu'on a entendu", () => {
  it("annonce le compte confirmé tant que le serveur répond", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        envois.push({ url: String(url), corps: JSON.parse(String(init?.body)) });
        return reponse(true);
      }),
    );

    const { getByText } = monte();
    await souffle();
    fireEvent.click(getByText("← Retour"));
    await souffle();

    // La garde est bien posée dans le cas ordinaire : le correctif ne l'a pas désarmée.
    expect(envois[0].corps.knownGameCount).toBe(1);
    expect(localStorage.getItem(ACK_KEY)).toBe("1");
  });

  it("passe au DOUTE quand la réponse se perd, et n'annonce alors plus rien", async () => {
    let coupe = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        envois.push({ url: String(url), corps: JSON.parse(String(init?.body)) });
        // Le serveur a commité, mais la réponse n'arrive jamais : `fetch` jette au retour, et
        // rien ici ne distingue ce cas de « la requête n'est jamais partie ».
        if (coupe) throw new Error("réseau coupé");
        return reponse(true);
      }),
    );

    const { getByText } = monte();
    await souffle();
    expect(localStorage.getItem(LOG_KEY)).not.toBeNull();

    fireEvent.click(getByText("← Retour"));
    await souffle();

    // Le doute est noté, et il SURVIT au rechargement : sans cela, refermer puis rouvrir
    // l'appli rejouait la perte à l'identique.
    expect(localStorage.getItem(ACK_KEY)).toBe("?");
    // Et le journal est intact — c'est lui qui contient les points du jeu en cours.
    expect(localStorage.getItem(LOG_KEY)).not.toBeNull();

    // L'envoi suivant n'annonce AUCUN compte : le serveur appliquera sa propre règle, qui
    // laisse croître une liste sans base annoncée et refuse toujours d'en retirer.
    coupe = false;
    fireEvent.click(getByText("← Retour"));
    await souffle();

    expect(envois.length).toBe(2);
    expect("knownGameCount" in envois[1].corps).toBe(false);
    // Le serveur ayant répondu, la certitude revient.
    expect(localStorage.getItem(ACK_KEY)).toBe("1");
  });
});

// LE CONTRE-TEST, ET C'EST LE PLUS IMPORTANT DU FICHIER.
//
// Les deux blocs ci-dessus vérifient que le journal n'est PAS purgé quand le conflit est avec
// soi-même. Pris seuls, ils décriraient aussi bien un marqueur qui ne purge plus jamais rien.
//
// Le correctif affaiblit délibérément la garde — `knownGameCount` devient absent tant que le
// sort du dernier envoi est inconnu — en comptant sur la règle du RÉTRÉCISSEMENT côté serveur
// pour prendre le relais : elle refuse toujours une écriture qui retire des jeux sans dire sur
// quel état elle se fonde. Si ce relais ne fonctionnait pas, la suite ne le dirait pas.
//
// On vérifie donc ici l'inverse exact : quand la divergence est RÉELLE — un capitaine a saisi un
// jeu pendant que le marqueur avait le dos tourné —, le journal doit bien être jeté. C'est la
// moitié destructrice de la garde, et c'est celle qui protège le score partagé.
describe("InterclubScorer — quand la divergence est réelle, le journal se jette", () => {
  function refus(): Response {
    return {
      ok: false,
      status: 409,
      json: async () => ({ error: "Le score a changé ailleurs", code: "stale-games" }),
    } as unknown as Response;
  }

  it("purge le journal et ferme l'écran sur un refus `stale-games`", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => refus()));

    const onClose = vi.fn();
    const { getByText } = monte(onClose);
    await souffle();
    expect(localStorage.getItem(LOG_KEY)).not.toBeNull();

    fireEvent.click(getByText("← Retour"));
    await souffle();

    // Le journal ne décrit plus rien : on le jette, et l'écran se ferme pour que le parent
    // recharge la rencontre depuis le serveur — seule version que tout le monde partage.
    expect(localStorage.getItem(LOG_KEY)).toBeNull();
    expect(localStorage.getItem(ACK_KEY)).toBeNull();
    expect(onClose).toHaveBeenCalled();
  });

  it("le fait AUSSI pendant le doute, la règle du rétrécissement ayant pris le relais", async () => {
    // Premier envoi : la réponse se perd → l'accusé passe au doute, et les envois suivants
    // n'annoncent plus de compte. C'est là que la garde repose entièrement sur le serveur.
    let coupe = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        envois.push({ url: "", corps: JSON.parse(String(init?.body)) });
        if (coupe) throw new Error("réseau coupé");
        return refus();
      }),
    );

    const onClose = vi.fn();
    const { getByText } = monte(onClose);
    await souffle();

    fireEvent.click(getByText("← Retour"));
    await souffle();
    expect(localStorage.getItem(ACK_KEY)).toBe("?");
    expect(localStorage.getItem(LOG_KEY)).not.toBeNull();

    // Second envoi, sans compte annoncé — et le serveur refuse quand même, parce que le journal
    // retirerait des jeux qu'il a. Le marqueur doit obéir à ce refus-là comme à l'autre.
    coupe = false;
    fireEvent.click(getByText("← Retour"));
    await souffle();

    expect("knownGameCount" in envois[1].corps).toBe(false);
    expect(localStorage.getItem(LOG_KEY)).toBeNull();
    expect(onClose).toHaveBeenCalled();
  });
});

describe("InterclubScorer — reprendre un match entamé sur un autre appareil", () => {
  // LE DÉFAUT. On marque le premier jeu jusqu'à 7-7, on revient au tableau. On rouvre la fiche
  // sur un autre appareil — ou avec un autre compte : la fiche affiche bien 7-7, elle lit
  // l'instantané du serveur. Le marquage, lui, ne le lisait pas, et repartait de 0-0. Sept
  // échanges perdus, sans un mot à l'écran, et rien pour les retrouver.
  //
  // L'instantané ARRIVAIT pourtant : `serializeInterclub` le rend depuis toujours, le parent le
  // passait dans l'objet du match. C'est le type d'entrée du marqueur qui ne le déclarait pas,
  // et l'amorçage qui n'en tenait donc aucun compte.

  const enCours = {
    ...MATCH,
    id: "m-reprise",
    games: [] as { number: number; home: number; away: number }[],
    live: { current: { home: 7, away: 7 }, serving: "away" as const, servingBox: "left" as const },
  };

  it("affiche le jeu en cours du serveur, journal local vide", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reponse(true)));
    const { container } = render(
      <InterclubScorer
        fixtureId="f1"
        match={enCours}
        bestOf={5}
        onClose={vi.fn()}
        onExpired={(status) => status === 401}
        toast={vi.fn()}
      />,
    );
    await souffle();

    const points = [...container.querySelectorAll(".ics-points")].map((e) => e.textContent);
    expect(points).toEqual(["7", "7"]);
  });

  it("reprend au point suivant, sans recommencer le jeu", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reponse(true)));
    const { container } = render(
      <InterclubScorer
        fixtureId="f1"
        match={{ ...enCours, id: "m-reprise-2" }}
        bestOf={5}
        onClose={vi.fn()}
        onExpired={(status) => status === 401}
        toast={vi.fn()}
      />,
    );
    await souffle();

    // Le côté domicile marque : 8-7, et non 1-0.
    await act(async () => {
      fireEvent.click(container.querySelectorAll(".ics-side")[0]);
      await souffle();
    });
    const points = [...container.querySelectorAll(".ics-points")].map((e) => e.textContent);
    expect(points).toEqual(["8", "7"]);
  });

  it("le journal LOCAL reste prioritaire — il est plus frais que l'instantané", async () => {
    // Le marqueur qui reprend sur SON téléphone a le journal complet, points compris. Le
    // laisser écraser par l'instantané ferait perdre les points postérieurs au dernier envoi,
    // c'est-à-dire jusqu'à cinq secondes de jeu.
    localStorage.setItem(
      "ic:log:m-reprise-3",
      JSON.stringify([
        { t: "serve", side: "home", box: "right" },
        { t: "point", side: "home" },
        { t: "point", side: "home" },
      ]),
    );
    vi.stubGlobal("fetch", vi.fn(async () => reponse(true)));
    const { container } = render(
      <InterclubScorer
        fixtureId="f1"
        match={{ ...enCours, id: "m-reprise-3" }}
        bestOf={5}
        onClose={vi.fn()}
        onExpired={(status) => status === 401}
        toast={vi.fn()}
      />,
    );
    await souffle();

    const points = [...container.querySelectorAll(".ics-points")].map((e) => e.textContent);
    expect(points).toEqual(["2", "0"]);
  });
});
