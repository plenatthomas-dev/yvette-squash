import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, screen, fireEvent, waitFor } from "@testing-library/react";
import Tournament, { scorelines, prettyDate, todayISO } from "@/components/Tournament";
import { validScore } from "@/lib/tournament-db";
import { invalidateDirectory } from "@/lib/directoryCache";

// MILLE CENT LIGNES, ZÉRO TEST — et dedans, deux règles que seul un `&&` dans du JSX énonce :
// qui voit le bouton « Générer la phase finale », et qui peut corriger un score déjà saisi.
//
// Ces deux-là doublent une garde du serveur (403/409). C'est exactement pour cela qu'elles
// méritent d'être vérifiées : quand l'écran et le serveur ne s'accordent plus, personne ne
// reçoit d'erreur — on obtient un bouton qui existe et qui échoue, ou une action permise que
// plus rien ne propose. Le premier cas se produit en pleine soirée, devant huit joueurs.
//
// Sous jsdom : le module est un composant client, et ces règles ne vivent que dans son rendu.

// --- Les fonctions pures, désormais exportées --------------------------------

describe("scorelines — les seuls scores qu'un joueur peut cliquer", () => {
  it("bo3 : de 2-0 à 0-2, le vainqueur d'abord", () => {
    expect(scorelines(3)).toEqual([
      [2, 1],
      [2, 0],
      [0, 2],
      [1, 2],
    ]);
  });

  it("bo5 : trois jeux pour gagner, six lignes", () => {
    expect(scorelines(5)).toEqual([
      [3, 2],
      [3, 1],
      [3, 0],
      [0, 3],
      [1, 3],
      [2, 3],
    ]);
  });

  it.each([[3], [5]])(
    "TOUTES les lignes proposées sont acceptées par le serveur (bo%i)",
    (bestOf) => {
      // C'est l'invariant qui compte : l'écran ne propose pas un champ libre mais une liste de
      // boutons, et `validScore` est ce qui les recevra. Une ligne de trop, et le joueur
      // récolte « Score invalide » sur un bouton que l'appli lui a tendu.
      for (const [a, b] of scorelines(bestOf)) {
        expect(validScore(a, b, bestOf), `${a}-${b} en bo${bestOf}`).toBe(true);
      }
    },
  );

  it("ne propose JAMAIS de match nul", () => {
    for (const bestOf of [3, 5]) {
      for (const [a, b] of scorelines(bestOf)) expect(a).not.toBe(b);
    }
  });
});

describe("les dates, et le fuseau qui les décale d'un jour", () => {
  it("prettyDate affiche le jour demandé, y compris à l'ouest de Greenwich", () => {
    // `new Date("2026-11-14")` vaut minuit UTC : à Los Angeles c'est encore le 13 au soir, et
    // la date s'afficherait décalée d'un jour. D'où le `T12:00:00` : midi met la journée
    // entière hors de portée du décalage, dans les deux sens.
    //
    // On déplace donc réellement le fuseau du processus le temps du test — sans quoi cette
    // règle ne serait vérifiée que sous le fuseau de la machine qui lance les tests, c'est-à-
    // dire nulle part de fiable.
    const fuseau = process.env.TZ;
    try {
      for (const tz of ["America/Los_Angeles", "Pacific/Kiritimati"]) {
        process.env.TZ = tz;
        expect(prettyDate("2026-11-14"), tz).toBe("sam. 14 nov.");
        expect(prettyDate("2026-01-01"), tz).toBe("jeu. 1 janv.");
      }
    } finally {
      process.env.TZ = fuseau;
    }
  });

  it("todayISO rend la date LOCALE, même à une heure où l'UTC a changé de jour", () => {
    // 1 h 30 du matin à Paris en été (UTC+2), c'est encore le 13 à 23 h 30 en UTC.
    // `toISOString().slice(0, 10)` daterait donc le tournoi de la VEILLE — et il se rangerait
    // au mauvais endroit dans une liste triée par date, la veille de la soirée.
    //
    // Le fuseau du processus est fixé ici : comparer à `toLocaleDateString` serait recopier
    // l'implémentation, et le test passerait quelle que soit la formule employée.
    const fuseau = process.env.TZ;
    vi.useFakeTimers();
    try {
      process.env.TZ = "Europe/Paris";
      vi.setSystemTime(new Date("2026-07-13T23:30:00Z"));
      expect(todayISO()).toBe("2026-07-14");
    } finally {
      vi.useRealTimers();
      process.env.TZ = fuseau;
    }
  });
});

// --- Le rendu : qui voit quoi ------------------------------------------------

type Corps = Record<string, unknown>;

const joueur = (id: string, name: string) => ({ id, name });

/** Un match de poule entre p1 et p2, à jouer. */
const match = (over: Corps = {}) => ({
  id: "m1",
  p1: joueur("p1", "Marc"),
  p2: joueur("p2", "Léa"),
  score1: null,
  score2: null,
  winnerId: null,
  status: "pending",
  terrain: null,
  order: null,
  ...over,
});

const detail = (over: Corps = {}) => ({
  id: "t1",
  name: "Nuit du squash",
  date: "2026-11-14",
  status: "running",
  format: "pools_bracket",
  formatLabel: "2 poules de 4 + tableau final",
  targetMatches: 3,
  bestOf: 3,
  courts: 2,
  isCreator: false,
  isParticipant: true,
  players: [joueur("p1", "Marc"), joueur("p2", "Léa")],
  pools: [{ label: "Poule A", matches: [match()], standings: [] }],
  bracket: null,
  finals: null,
  canGenerateFinals: false,
  champion: null,
  ...over,
});

let reponse: Corps = detail();
/** Les requêtes émises, dans l'ordre — pour vérifier ce qu'un clic envoie vraiment. */
let envois: { url: string; body: unknown }[] = [];

function fauxFetch(input: RequestInfo | URL, init?: RequestInit) {
  const url = String(input);
  envois.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
  const corps = url.endsWith("/api/tournaments")
    ? { tournaments: [{ id: "t1", name: "Nuit du squash", date: "2026-11-14", status: "running", format: "pools_bracket", playerCount: 8 }] }
    : init?.method === "PATCH"
      ? { ok: true }
      : reponse;
  return Promise.resolve(
    new Response(JSON.stringify(corps), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

const props = { toast: () => {}, onExpired: () => false };

/** Monte l'écran, ouvre le tournoi, et rend la main une fois le détail affiché. */
async function ouvrir(d: Corps) {
  reponse = d;
  render(<Tournament {...props} />);
  const item = await screen.findByText("Nuit du squash");
  await act(async () => {
    fireEvent.click(item);
  });
  // « Formule : … » n'existe que dans le panneau de détail : c'est le signal que le second
  // aller-retour est arrivé et que le rendu qu'on va inspecter est celui du tournoi ouvert.
  await waitFor(() => expect(screen.getByText(/Formule :/)).toBeTruthy());
}

beforeEach(() => {
  envois = [];
  vi.stubGlobal("fetch", fauxFetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("« Générer la phase finale » — un bouton pour une seule personne", () => {
  it("le créateur le voit quand les poules sont finies", async () => {
    await ouvrir(detail({ isCreator: true, canGenerateFinals: true }));
    expect(screen.getByText(/Générer la phase finale/)).toBeTruthy();
  });

  it("un participant ne le voit PAS — on lui dit qui doit cliquer", async () => {
    // Le serveur refuserait en 403 ; ce qu'on vérifie ici, c'est qu'on ne lui tend pas un
    // bouton condamné, et qu'on lui explique l'attente au lieu de ne rien afficher.
    await ouvrir(detail({ isCreator: false, canGenerateFinals: true }));
    expect(screen.queryByText(/Générer la phase finale/)).toBeNull();
    expect(screen.getByText(/le créateur doit lancer la phase finale/i)).toBeTruthy();
  });

  it.each([
    ["le créateur", true],
    ["un participant", false],
  ])("%s ne voit RIEN tant qu'un match de poule reste à jouer", async (_qui, isCreator) => {
    // `canGenerateFinals` est calculé par le serveur : l'écran ne fait que le relayer. Le
    // proposer plus tôt figerait des classements de poules provisoires.
    //
    // Les deux rôles sont éprouvés : la phrase d'attente est gardée par `canGenerateFinals`
    // ET par `!isCreator`, et n'éprouver que le créateur laisserait la première garde tomber
    // sans bruit — le participant lirait « poules terminées » dès la première minute.
    await ouvrir(detail({ isCreator, canGenerateFinals: false }));
    expect(screen.queryByText(/Générer la phase finale/)).toBeNull();
    expect(screen.queryByText(/le créateur doit lancer/i)).toBeNull();
  });
});

describe("saisir un score — qui a le droit, et sur quel match", () => {
  it("un participant voit les quatre boutons de score d'un match à jouer", async () => {
    await ouvrir(detail());
    expect(screen.getByText("2–0")).toBeTruthy();
    expect(screen.getByText("0–2")).toBeTruthy();
    // Le libellé accessible nomme les deux joueurs dans le bon ordre.
    expect(screen.getByLabelText("Marc 2 - 0 Léa")).toBeTruthy();
  });

  it("un spectateur (ni participant ni créateur) n'en voit aucun", async () => {
    await ouvrir(detail({ isParticipant: false, isCreator: false }));
    expect(screen.queryByText("2–0")).toBeNull();
    expect(screen.queryByText(/Corriger/)).toBeNull();
  });

  it("bo5 : six boutons, jusqu'à 3–2", async () => {
    await ouvrir(detail({ bestOf: 5 }));
    expect(screen.getByText("3–0")).toBeTruthy();
    expect(screen.getByText("3–2")).toBeTruthy();
    expect(screen.queryByText("2–0")).toBeNull();
  });

  it("un match DÉJÀ SAISI ne se re-saisit pas — le participant voit le score, pas des boutons", async () => {
    const joue = match({ status: "done", score1: 2, score2: 0, winnerId: "p1" });
    await ouvrir(detail({ pools: [{ label: "Poule A", matches: [joue], standings: [] }] }));
    expect(screen.getByText("2–0")).toBeTruthy(); // le score affiché…
    expect(screen.queryByLabelText(/Marc 2 - 0 Léa/)).toBeNull(); // …mais pas le bouton
    expect(screen.queryByText(/Corriger/)).toBeNull();
  });

  it("le créateur, lui, se voit proposer « Corriger »", async () => {
    const joue = match({ status: "done", score1: 2, score2: 0, winnerId: "p1" });
    await ouvrir(
      detail({ isCreator: true, pools: [{ label: "Poule A", matches: [joue], standings: [] }] }),
    );
    expect(screen.getByText(/Corriger/)).toBeTruthy();
    // Tant qu'il n'a pas cliqué, aucun bouton de score : la correction est un geste délibéré.
    expect(screen.queryByLabelText(/Marc 2 - 0 Léa/)).toBeNull();
  });

  it("le clic sur « Corriger » ré-ouvre les scores, avec une porte de sortie", async () => {
    const joue = match({ status: "done", score1: 2, score2: 0, winnerId: "p1" });
    await ouvrir(
      detail({ isCreator: true, pools: [{ label: "Poule A", matches: [joue], standings: [] }] }),
    );
    await act(async () => {
      fireEvent.click(screen.getByText(/Corriger/));
    });
    expect(screen.getByLabelText("Marc 2 - 0 Léa")).toBeTruthy();
    // « Annuler » n'apparaît QUE sur un match déjà joué : sur un match neuf, il n'y aurait
    // rien à annuler, et le bouton laisserait croire qu'on peut effacer une saisie.
    expect(screen.getByText("Annuler")).toBeTruthy();
  });

  it("aucun bouton sur un « bye » : ce n'est pas un match", async () => {
    // Ce qui l'interdit ici, c'est l'adversaire manquant, pas le statut : un bye a toujours un
    // camp vide (`isBye` exige un seed négatif, et un seed négatif devient `null` —
    // `tournament.test.ts` en fait un invariant). Élargir le statut accepté ne rouvrirait donc
    // rien : la garde `!m.p1 || !m.p2` retient déjà tout. On l'écrit pour qu'on ne croie pas
    // le contraire couvert.
    const bye = match({ status: "bye", p2: null });
    await ouvrir(
      detail({ isCreator: true, pools: [{ label: "Poule A", matches: [bye], standings: [] }] }),
    );
    expect(screen.getByText(/passe \(bye\)/)).toBeTruthy();
    expect(screen.queryByText("2–0")).toBeNull();
  });

  it("aucun bouton tant que l'adversaire n'est pas connu", async () => {
    // Dans un tableau, le second participant se résout quand le match précédent est joué.
    const enAttente = match({ p2: null });
    await ouvrir(
      detail({ isCreator: true, pools: [{ label: "Poule A", matches: [enAttente], standings: [] }] }),
    );
    expect(screen.queryByText("2–0")).toBeNull();
  });

  it("cliquer un score envoie EXACTEMENT ce que le bouton affiche", async () => {
    await ouvrir(detail());
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Marc 0 - 2 Léa"));
    });
    const patch = envois.find((e) => e.url.includes("/matches/"));
    expect(patch?.url).toContain("/api/tournaments/t1/matches/m1");
    expect(patch?.body).toEqual({ score1: 0, score2: 2 });
  });
});

describe("« Prochains matchs » — ce que la liste laisse passer", () => {
  const programme = (...ms: Corps[]) => ({
    label: "Poule A",
    matches: ms.map((m, i) => match({ id: `m${i}`, ...m })),
    standings: [],
  });

  /** Les lignes de la section, dans l'ordre où l'écran les donne. */
  const annonces = () =>
    [...document.querySelectorAll(".trn-schedule li")].map((li) => li.textContent ?? "");

  it("annonce un match à jouer avec son terrain", async () => {
    await ouvrir(detail({ pools: [programme({ order: 1, terrain: "Terrain 2" })] }));
    expect(screen.getByText(/Prochains matchs/)).toBeTruthy();
    expect(annonces()).toEqual(["Terrain 2Marc vs Léa"]);
  });

  it("annonce dans l'ORDRE DE PASSAGE, pas dans l'ordre reçu", async () => {
    // C'est tout l'objet de la section : la lire de haut en bas doit donner la soirée. Servie
    // dans l'ordre de la base, elle enverrait les joueurs sur le terrain à contretemps.
    await ouvrir(
      detail({
        pools: [
          programme(
            { order: 3, p1: joueur("a", "Anna"), p2: joueur("b", "Bob") },
            { order: 1, p1: joueur("c", "Chloé"), p2: joueur("d", "Dan") },
            { order: 2, p1: joueur("e", "Elias"), p2: joueur("f", "Fanny") },
          ),
        ],
      }),
    );
    expect(annonces()).toEqual(["Chloé vs Dan", "Elias vs Fanny", "Anna vs Bob"]);
  });

  it("s'arrête à six : c'est un prochain, pas un programme complet", async () => {
    // Au-delà, la liste pousse le reste de l'écran hors de vue sur un téléphone, alors que les
    // matchs 7 et suivants ne seront pas appelés avant longtemps.
    const huit = Array.from({ length: 8 }, (_, i) => ({
      order: i + 1,
      p1: joueur(`x${i}`, `J${i}`),
      p2: joueur(`y${i}`, "Léa"),
    }));
    await ouvrir(detail({ pools: [programme(...huit)] }));
    expect(annonces()).toHaveLength(6);
    expect(annonces()[5]).toContain("J5");
  });

  it.each([
    ["il n'a pas d'ordre de passage", { order: null }],
    ["il est déjà joué", { order: 1, status: "done", score1: 2, score2: 0, winnerId: "p1" }],
    ["l'adversaire n'est pas connu", { order: 1, p2: null }],
    ["c'est un bye", { order: 1, status: "bye" }],
  ])("n'annonce rien quand %s", async (_cas, m) => {
    // La section entière disparaît : une liste « Prochains matchs » vide vaudrait moins que
    // pas de liste du tout, et un match sans adversaire ne peut pas être appelé au micro.
    await ouvrir(detail({ pools: [programme(m as Corps)] }));
    expect(screen.queryByText(/Prochains matchs/)).toBeNull();
  });
});

// --- Assistant de création — choix des joueurs et têtes de série ------------
//
// L'écran affichait le nom des membres au choix des participants, jamais leur classement — il
// fallait ouvrir l'annuaire à côté pour composer un tournoi équilibré. Et le pré-remplissage des
// têtes de série triait par RANG MIXTE squashnet (`byRank`, celui de l'annuaire), pas par
// CLASSEMENT fédéral : correct tant que tout le monde a un rang connu, mais un membre dont le
// classement vient d'une correction admin (`interclubCltOverride`, sans rapprochement squashnet)
// n'a pas de rang du tout — `byRank` le reléguait en fin de liste par ordre alphabétique, sans
// tenir compte de son classement pourtant connu.

describe("Assistant de création — le classement, du choix des joueurs aux têtes de série", () => {
  // 6 = MIN_PLAYERS : le strict nécessaire pour que « Suivant » ne soit pas désactivé.
  const MEMBRES = [
    { id: "u-zoe", name: "Zoé", clt: "3B", rangM: 50 },
    { id: "u-albert", name: "Albert", clt: "4D", rangM: 300 },
    // Même classement, rangM différent : Chloé (rang meilleur) doit passer avant Benoît.
    { id: "u-benoit", name: "Benoît", clt: "5A", rangM: 500 },
    { id: "u-chloe", name: "Chloé", clt: "5A", rangM: 200 },
    // Classement inconnu (jamais rapproché, aucune correction admin) : départagés par nom.
    { id: "u-eve", name: "Eve", clt: null, rangM: null },
    { id: "u-denis", name: "Denis", clt: null, rangM: null },
  ];

  beforeEach(() => {
    invalidateDirectory();
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      const url = String(input);
      const corps = url.endsWith("/api/tournaments")
        ? { tournaments: [] }
        : url.endsWith("/api/directory")
          ? { members: MEMBRES, groupUrl: null }
          : {};
      return Promise.resolve(
        new Response(JSON.stringify(corps), { status: 200, headers: { "Content-Type": "application/json" } }),
      );
    });
  });

  async function ouvrirAssistant() {
    render(<Tournament {...props} />);
    await act(async () => {
      fireEvent.click(await screen.findByText("➕ Nouveau tournoi"));
    });
    await waitFor(() => expect(screen.getByText(/Choisis les joueurs/)).toBeTruthy());
  }

  it("montre le classement de chaque membre dès le choix des joueurs, pas seulement aux têtes de série", async () => {
    await ouvrirAssistant();
    expect(screen.getByText("4D")).toBeTruthy();
    expect(screen.getByText("3B")).toBeTruthy();
    // Benoît ET Chloé sont tous deux « 5A ».
    expect(screen.getAllByText("5A")).toHaveLength(2);
  });

  it("n'affiche aucun badge pour un membre au classement inconnu", async () => {
    await ouvrirAssistant();
    const label = screen.getByText("Eve").closest("label");
    expect(label?.querySelector(".directory-clt")).toBeNull();
  });

  it("pré-remplit les têtes de série par CLASSEMENT d'abord, rang mixte en départage ensuite", async () => {
    await ouvrirAssistant();
    for (const m of MEMBRES) {
      fireEvent.click(screen.getByText(m.name));
    }
    await act(async () => {
      fireEvent.click(screen.getByText("Suivant"));
    });
    const noms = Array.from(document.querySelectorAll(".trn-seed-name")).map((el) => el.textContent);
    // Zoé (3B) > Albert (4D) > Chloé (5A-200) > Benoît (5A-500) > Denis/Eve (inconnu, alpha).
    expect(noms).toEqual(["Zoé", "Albert", "Chloé", "Benoît", "Denis", "Eve"]);
  });
});
