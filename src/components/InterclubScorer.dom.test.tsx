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

// ============================================================================
//  LE BORD DU TERRAIN — quatre défauts qu'aucun test ne voyait parce qu'ils ne
//  tiennent ni au score ni au réseau, mais au GESTE.
//
//  Ils ont tous la même signature : l'appli fonctionne parfaitement, et le
//  marqueur abandonne quand même au milieu du deuxième jeu.
// ============================================================================

/** Un match VIERGE : c'est le seul état où l'on désigne le premier serveur. */
const MATCH_VIERGE = { ...MATCH, games: [], live: null };

function monteVierge(over: Record<string, unknown> = {}) {
  return render(
    <InterclubScorer
      fixtureId="f1"
      match={{ ...MATCH_VIERGE, ...over }}
      bestOf={5}
      onClose={vi.fn()}
      onExpired={(status) => status === 401}
      toast={vi.fn()}
    />,
  );
}

describe("InterclubScorer — le premier serveur se corrige", () => {
  it("⚠️ « Annuler » défait le CHOIX DU PREMIER SERVEUR", async () => {
    // LE DÉFAUT. La garde était `events.length <= 1` : sur un match vierge, le « Qui engage ? »
    // pose l'événement n° 1 et il devenait indéfaisable. Un appui de travers condamnait
    // l'indicateur de service pour tout le match — et marquer un point puis l'annuler ne
    // rattrapait rien, puisqu'on retombait à 1.
    vi.stubGlobal("fetch", vi.fn(async () => reponse(true)));
    const { getByText, queryByText } = monteVierge();
    await souffle();

    expect(getByText(/Qui engage/)).toBeTruthy();
    fireEvent.click(getByText("Thomas · gauche"));
    await souffle();
    // Le panneau a disparu : le serveur est désigné.
    expect(queryByText(/Qui engage/)).toBeNull();

    const annuler = getByText("↶ Annuler") as HTMLButtonElement;
    expect(annuler.disabled).toBe(false);
    fireEvent.click(annuler);
    await souffle();

    // On peut rechoisir : c'est tout ce qu'on demandait.
    expect(getByText(/Qui engage/)).toBeTruthy();
  });

  it("reste inerte quand il n'y a vraiment rien à annuler", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reponse(true)));
    const { getByText } = monteVierge();
    await souffle();
    expect((getByText("↶ Annuler") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("InterclubScorer — balle de jeu et balle de match", () => {
  /**
   * Amène le jeu à `h`-`a`.
   *
   * ⚠️ IL FAUT RÉPONDRE AU CARRÉ DE SERVICE. À chaque reprise de service, l'écran réclame le
   * carré et IGNORE les appuis tant qu'on ne l'a pas donné (`applyPoint` ne devine pas un
   * serveur). Une aide qui tape dix fois d'affilée n'enregistre donc qu'un seul point après un
   * changement de main — et l'essai mesure alors 10-1 en croyant mesurer 10-10.
   */
  async function jusqua(ecran: ReturnType<typeof monteVierge>, h: number, a: number) {
    const tape = async (qui: string) => {
      // Le carré peut être réclamé AVANT le premier appui : un match repris s'arrête juste
      // après un jeu gagné, donc en attente du carré du jeu suivant. Sans ce dégagement, le
      // tout premier appui de l'essai est avalé et il en manque un à l'arrivée.
      await degage();
      fireEvent.click(ecran.getByLabelText(`Point pour ${qui}`));
      await souffle();
      await degage();
    };
    const degage = async () => {
      const carre = ecran.queryByText("Carré gauche");
      if (carre) {
        fireEvent.click(carre);
        await souffle();
      }
      // La pause entre deux jeux bloque aussi les appuis : on la passe, comme le ferait le
      // marqueur qui enchaîne.
      const reprendre = ecran.queryByText("Reprendre maintenant");
      if (reprendre) {
        fireEvent.click(reprendre);
        await souffle();
      }
    };
    for (let i = 0; i < h; i++) await tape("Thomas");
    for (let i = 0; i < a; i++) await tape("Gérard");
  }

  it("annonce la balle de jeu à un point du jeu, et pas avant", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reponse(true)));
    const ecran = monteVierge();
    await souffle();
    fireEvent.click(ecran.getByText("Thomas · gauche"));
    await souffle();

    await jusqua(ecran, 9, 0);
    expect(ecran.queryByText("balle de jeu")).toBeNull();

    await jusqua(ecran, 1, 0); // 10-0
    expect(ecran.getByText("balle de jeu")).toBeTruthy();
  });

  it("⚠️ se TAIT à 10-10 — 11-10 ne gagne pas le jeu", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reponse(true)));
    const ecran = monteVierge();
    await souffle();
    fireEvent.click(ecran.getByText("Thomas · gauche"));
    await souffle();
    await jusqua(ecran, 10, 10);
    expect(ecran.queryByText("balle de jeu")).toBeNull();
    expect(ecran.queryByText("balle de match")).toBeNull();
  });

  it("dit « balle de match » quand c'est le dernier jeu qui manque", async () => {
    // Deux jeux déjà gagnés au meilleur des cinq : le troisième est décisif.
    vi.stubGlobal("fetch", vi.fn(async () => reponse(true)));
    const ecran = monteVierge({
      games: [
        { number: 1, home: 11, away: 2 },
        { number: 2, home: 11, away: 3 },
      ],
    });
    await souffle();
    await jusqua(ecran, 10, 0);
    expect(ecran.getByText("balle de match")).toBeTruthy();
    expect(ecran.queryByText("balle de jeu")).toBeNull();
  });
});

describe("InterclubScorer — les gestes qu'on fait sans regarder", () => {
  it("vibre brièvement sur un point, et double sur une fin de jeu", async () => {
    // Le marquage est le seul écran qu'on utilise sans le regarder : on tape, et on regarde
    // le court. La vibration est la seule confirmation qui n'oblige pas à lever les yeux.
    const vibrate = vi.fn();
    vi.stubGlobal("navigator", { ...navigator, vibrate });
    vi.stubGlobal("fetch", vi.fn(async () => reponse(true)));
    const { getByText, getByLabelText } = monteVierge();
    await souffle();
    fireEvent.click(getByText("Thomas · gauche"));
    await souffle();

    fireEvent.click(getByLabelText("Point pour Thomas"));
    await souffle();
    expect(vibrate).toHaveBeenLastCalledWith(12);

    for (let i = 0; i < 10; i++) fireEvent.click(getByLabelText("Point pour Thomas"));
    await souffle();
    expect(vibrate).toHaveBeenLastCalledWith([14, 60, 14]);
  });

  it("ne jette pas quand le navigateur ne vibre pas", async () => {
    // iOS ne connaît pas l'API. Le marquage doit fonctionner exactement pareil.
    vi.stubGlobal("navigator", { ...navigator, vibrate: undefined });
    vi.stubGlobal("fetch", vi.fn(async () => reponse(true)));
    const { getByText, getByLabelText } = monteVierge();
    await souffle();
    fireEvent.click(getByText("Thomas · gauche"));
    await souffle();
    expect(() => fireEvent.click(getByLabelText("Point pour Thomas"))).not.toThrow();
  });

  it("⚠️ garde l'écran allumé, et le relâche en partant", async () => {
    // Un téléphone posé au bord du court se verrouille au bout de trente secondes : le
    // marqueur le déverrouille entre chaque échange, et abandonne.
    const release = vi.fn(async () => {});
    const request = vi.fn(async () => ({ release, released: false }));
    vi.stubGlobal("navigator", { ...navigator, wakeLock: { request } });
    vi.stubGlobal("fetch", vi.fn(async () => reponse(true)));

    const { unmount } = monteVierge();
    await souffle();
    expect(request).toHaveBeenCalledWith("screen");

    unmount();
    await souffle();
    expect(release).toHaveBeenCalled();
  });
});
