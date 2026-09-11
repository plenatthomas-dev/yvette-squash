import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import Interclub from "@/components/Interclub";

// LES DEUX MENUS D'EN FACE — le club adverse, et ses joueurs.
//
// CE QU'ILS RÉSOLVENT. Le nom d'un adversaire était un champ de texte, recopié à la main un soir
// de rencontre sur un téléphone. « Détry » un mois, « detry » le suivant : le rapprochement
// fédéral échouait sur un accent, et le capitaine se retrouvait devant un rapport qui déclarait
// « introuvable » un joueur parfaitement réel. On ne retape plus ce qu'on connaît déjà.
//
// CE QU'ILS N'INTERDISENT PAS, et c'est aussi important : une poule commence par une première
// rencontre contre un club jamais croisé, dont on ne connaît aucun joueur. La saisie libre reste
// donc atteignable dans les deux menus — sinon la moitié d'une première rencontre serait
// impossible à composer.
//
// L'ORDRE DES SIMPLES VAUT DES DEUX CÔTÉS. Le mieux classé dispute le simple n° 1, en face comme
// chez nous, et une rencontre disputée dans le mauvais ordre est sanctionnable des deux côtés.
// L'écran grise donc ce que le serveur refuserait — mais SEULEMENT quand il sait, c'est-à-dire
// quand une vérification de capitaine a rapproché ces joueurs de la fédération.

type Envoi = { url: string; methode: string; corps: Record<string, unknown> | null };
let envois: Envoi[] = [];

/** Ce que `/api/interclub/opponents` renvoie — surchargé par test. */
let connus: { teams: string[]; players: unknown[] } = { teams: [], players: [] };

const adversaire = (
  name: string,
  clt: string | null = null,
  rangM: number | null = null,
  team = "Massy",
) => ({
  name,
  team,
  fedName: name.toUpperCase(),
  clt,
  rangM,
  licence: null,
  seen: 1,
  source: clt ? ("roster" as const) : ("sheet" as const),
});

const simple = (order: number, awayName: string) => ({
  id: `m${order}`,
  order,
  status: "pending",
  homeUserId: null,
  homeGuestId: null,
  homeDisplayName: "À désigner",
  awayName,
  homeColor: null,
  awayColor: null,
  gamesHome: null,
  gamesAway: null,
  live: null,
  scorerId: null,
  scorerName: null,
  isMine: false,
  scorerStale: false,
  games: [],
});

let matches = [simple(1, "À désigner"), simple(2, "À désigner")];

const FIXTURE = () => ({
  id: "f1",
  date: "2026-09-03",
  time: "20:00",
  venue: null,
  venueAddress: null,
  round: null,
  dateConfirmed: true,
  season: null,
  bestOf: 5,
  matchCount: 2,
  status: "scheduled",
  home: true,
  opponent: "Massy",
  createdById: "u1",
  isCreator: true,
  canDelete: true,
  canEdit: true,
  winGames: 3,
  score: { home: 0, away: 0 },
  outcome: null,
  team: { id: "t1", name: "Équipe 1", captainId: null, captainName: null },
  roster: [{ kind: "member", id: "u1", name: "Thomas", clt: "5A", rangM: 1200 }],
  matches,
});

function reponse(corps: unknown): Response {
  return { ok: true, status: 200, json: async () => corps } as unknown as Response;
}

async function souffle() {
  await act(async () => {
    for (let i = 0; i < 25; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  envois = [];
  connus = { teams: [], players: [] };
  matches = [simple(1, "À désigner"), simple(2, "À désigner")];
  localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      envois.push({
        url: u,
        methode: init?.method ?? "GET",
        corps: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (u.includes("/api/interclub/opponents")) return reponse(connus);
      if (u.includes("/api/interclub/follows")) return reponse({ follows: [], pushReady: false });
      if (u.includes("/availability")) {
        return reponse({
          entries: [],
          counts: { yes: 0, no: 0, maybe: 0, pendingReachable: [], pendingUnreachable: [] },
          matchCount: 2,
          me: "u1",
        });
      }
      if (u.includes("/api/interclub/live")) return reponse({ fixtures: [] });
      if (/\/api\/interclub\/f1$/.test(u)) return reponse(FIXTURE());
      return reponse({
        teams: [{ id: "t1", name: "Équipe 1" }],
        fixtures: [
          {
            id: "f1",
            date: "2026-09-03",
            opponent: "Massy",
            home: true,
            status: "scheduled",
            score: { home: 0, away: 0 },
            team: { id: "t1", name: "Équipe 1" },
          },
        ],
      });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

/** Monte la vue et ouvre le formulaire du simple n° `n`. */
async function ouvreSimple(n = 1) {
  const r = render(<Interclub toast={vi.fn()} onExpired={() => false} />);
  await souffle();
  fireEvent.click(r.getByText(/Massy/));
  await souffle();
  fireEvent.click(r.getAllByText(/^Simple /)[n - 1]);
  await souffle();
  return r;
}

/** Le `<select>` (ou l'`<input>`) porté par un champ, désigné par son intitulé. */
function champ(r: ReturnType<typeof render>, intitule: string) {
  return r.getByText(intitule).closest("label")!.querySelector("select, input")!;
}

/** Les options d'un `<select>`, dans l'ordre. */
const options = (el: Element) => [...el.querySelectorAll("option")] as HTMLOptionElement[];

/** L'option qui rouvre la saisie libre — trouvée par son libellé, jamais par sa valeur. */
const optionAutre = (el: Element, libelle: RegExp) =>
  options(el).find((o) => libelle.test(o.textContent ?? ""))!;

describe("Menu du club adverse (nouvelle rencontre)", () => {
  /** Monte la vue et ouvre le formulaire de création. */
  async function ouvreCreation() {
    const r = render(<Interclub toast={vi.fn()} onExpired={() => false} />);
    await souffle();
    fireEvent.click(r.getByText(/Nouvelle rencontre/));
    await souffle();
    return r;
  }

  it("propose les clubs déjà rencontrés plutôt qu'un champ à retaper", async () => {
    connus = { teams: ["Chaville 4", "Massy"], players: [] };
    const r = await ouvreCreation();
    const el = champ(r, "Club adverse");
    expect(el.tagName).toBe("SELECT");
    expect(options(el).map((o) => o.textContent)).toEqual([
      "Chaville 4",
      "Massy",
      "— un autre club —",
    ]);
    expect((el as HTMLSelectElement).value).toBe("Chaville 4");
  });

  // Une poule commence contre des clubs jamais croisés : sans champ libre, la toute première
  // rencontre de la saison serait impossible à inscrire.
  it("reste un champ libre tant qu'aucun club n'a été rencontré", async () => {
    connus = { teams: [], players: [] };
    const r = await ouvreCreation();
    expect(champ(r, "Club adverse").tagName).toBe("INPUT");
  });

  it("rouvre la saisie libre, et sait revenir à la liste", async () => {
    connus = { teams: ["Massy"], players: [] };
    const r = await ouvreCreation();
    const el = champ(r, "Club adverse");
    fireEvent.change(el, { target: { value: optionAutre(el, /un autre club/).value } });
    await souffle();
    const libre = champ(r, "Club adverse") as HTMLInputElement;
    expect(libre.tagName).toBe("INPUT");
    // Le nom est effacé, pas conservé : on vient précisément de dire « ce n'est pas lui ».
    expect(libre.value).toBe("");
    fireEvent.click(r.getByText(/Revenir à la liste/));
    await souffle();
    expect((champ(r, "Club adverse") as HTMLSelectElement).value).toBe("Massy");
  });
});

describe("Menu des joueurs adverses (composition d'un simple)", () => {
  it("propose les joueurs déjà rencontrés DANS CE CLUB, et pas ceux d'un autre", async () => {
    connus = {
      teams: ["Massy", "Chaville 4"],
      players: [adversaire("Paul Martin"), adversaire("Zoé Chaville", null, null, "Chaville 4")],
    };
    const r = await ouvreSimple(1);
    const noms = options(champ(r, "Adversaire")).map((o) => o.textContent ?? "");
    expect(noms.some((n) => n.startsWith("Paul Martin"))).toBe(true);
    expect(noms.join(" ")).not.toContain("Zoé Chaville");
  });

  it("affiche le classement et le rang, les deux critères qui décident de l'ordre", async () => {
    connus = { teams: ["Massy"], players: [adversaire("Paul Martin", "4D", 2318)] };
    const r = await ouvreSimple(1);
    expect(champ(r, "Adversaire").textContent).toContain("Paul Martin (4D #2318)");
  });

  // LA RÈGLE DU CLUB, APPLIQUÉE EN FACE : le mieux classé dispute le simple n° 1. Bloqué DÈS LA
  // DÉSIGNATION, pas à la vérification du capitaine la veille de la feuille de match — la
  // rencontre est alors jouée, et il n'y a plus rien à corriger.
  it("grise un adversaire mieux classé que celui qui tient déjà un simple antérieur", async () => {
    connus = {
      teams: ["Massy"],
      players: [adversaire("Paul Martin", "5A", 2000), adversaire("Luc Bernard", "4A", 100)],
    };
    matches = [simple(1, "Paul Martin"), simple(2, "À désigner")];
    const r = await ouvreSimple(2);
    const bernard = options(champ(r, "Adversaire")).find((o) =>
      (o.textContent ?? "").startsWith("Luc Bernard"),
    )!;
    expect(bernard.disabled).toBe(true);
    expect(bernard.textContent).toContain("hors ordre de classement");
  });

  it("laisse choisir le même joueur sur le simple qui lui revient", async () => {
    connus = {
      teams: ["Massy"],
      players: [adversaire("Paul Martin", "5A", 2000), adversaire("Luc Bernard", "4A", 100)],
    };
    matches = [simple(1, "Luc Bernard"), simple(2, "À désigner")];
    const r = await ouvreSimple(2);
    const martin = options(champ(r, "Adversaire")).find((o) =>
      (o.textContent ?? "").startsWith("Paul Martin"),
    )!;
    expect(martin.disabled).toBe(false);
  });

  // ⚠️ LA DIFFÉRENCE IRRÉDUCTIBLE AVEC NOTRE CAMP. Chez nous, un joueur sans classement est
  // grisé — un admin peut le renseigner. En face, on ne peut rien renseigner du tout : griser
  // rendrait incomposable toute rencontre contre un club dont aucun capitaine n'a encore vérifié
  // les joueurs. On ne refuse que ce qu'on sait.
  it("ne grise personne tant qu'aucun classement adverse n'est connu", async () => {
    // AUCUN adversaire n'est aligné : le seul motif de grisage possible serait le classement,
    // et c'est bien ce que ce test isole. (La règle « un adversaire, un simple » a son propre
    // test juste en dessous — mêler les deux masquerait celui qu'on croit vérifier.)
    connus = { teams: ["Massy"], players: [adversaire("Paul Martin"), adversaire("Luc Bernard")] };
    matches = [simple(1, "À désigner"), simple(2, "À désigner")];
    const r = await ouvreSimple(2);
    for (const o of options(champ(r, "Adversaire"))) expect(o.disabled).toBe(false);
  });

  // ⚠️ LA MÊME RÈGLE QUE POUR NOUS, et elle ne demande AUCUN classement : c'est la seule des
  // deux qui vaille dès la première rencontre contre un club inconnu.
  it("grise un adversaire qui dispute déjà un autre simple, et dit lequel", async () => {
    connus = { teams: ["Massy"], players: [adversaire("Paul Martin"), adversaire("Luc Bernard")] };
    matches = [simple(1, "Paul Martin"), simple(2, "À désigner")];
    const r = await ouvreSimple(2);
    const martin = options(champ(r, "Adversaire")).find((o) =>
      (o.textContent ?? "").startsWith("Paul Martin"),
    )!;
    expect(martin.disabled).toBe(true);
    expect(martin.textContent).toContain("joue déjà le match n° 1");
    // L'autre reste choisissable : on ne grise que le doublon.
    const bernard = options(champ(r, "Adversaire")).find((o) =>
      (o.textContent ?? "").startsWith("Luc Bernard"),
    )!;
    expect(bernard.disabled).toBe(false);
  });

  it("laisse RE-choisir celui que CE simple retient déjà — sinon on ne peut plus revenir", async () => {
    connus = { teams: ["Massy"], players: [adversaire("Paul Martin")] };
    matches = [simple(1, "Paul Martin"), simple(2, "À désigner")];
    const r = await ouvreSimple(1);
    const martin = options(champ(r, "Adversaire")).find((o) =>
      (o.textContent ?? "").startsWith("Paul Martin"),
    )!;
    expect(martin.disabled).toBe(false);
  });

  it("voit le doublon malgré l'ordre des mots — c'est la faute la plus probable", async () => {
    // La ligue écrit « POPULU AXEL », le capitaine tape « Axel Populu ». Une comparaison
    // littérale laisserait passer le doublon précisément là où il a le plus de chances de
    // naître : un nom saisi deux fois, de deux façons.
    connus = { teams: ["Massy"], players: [adversaire("POPULU AXEL")] };
    matches = [simple(1, "Axel Populu"), simple(2, "À désigner")];
    const r = await ouvreSimple(2);
    const populu = options(champ(r, "Adversaire")).find((o) =>
      (o.textContent ?? "").startsWith("POPULU AXEL"),
    )!;
    expect(populu.disabled).toBe(true);
  });

  it("reste un champ libre pour un club dont on ne connaît personne", async () => {
    connus = { teams: [], players: [] };
    const r = await ouvreSimple(1);
    expect(champ(r, "Adversaire").tagName).toBe("INPUT");
  });

  // Un nom saisi AVANT que la liste n'existe ne doit pas disparaître de son propre champ parce
  // qu'il ne figure dans aucune entrée.
  it("garde en saisie libre un nom déjà posé qui n'est dans aucune entrée", async () => {
    connus = { teams: ["Massy"], players: [adversaire("Paul Martin")] };
    matches = [simple(1, "Un Nom D'Avant"), simple(2, "À désigner")];
    const r = await ouvreSimple(1);
    const el = champ(r, "Adversaire") as HTMLInputElement;
    expect(el.tagName).toBe("INPUT");
    expect(el.value).toBe("Un Nom D'Avant");
  });

  it("envoie le nom choisi dans le menu", async () => {
    connus = { teams: ["Massy"], players: [adversaire("Paul Martin", "4D", 2318)] };
    const r = await ouvreSimple(1);
    fireEvent.change(champ(r, "Adversaire"), { target: { value: "Paul Martin" } });
    await souffle();
    fireEvent.click(r.getByText(/^Enregistrer$/));
    await souffle();
    const envoi = envois.find((e) => e.methode === "PATCH" && e.url.includes("/matches/"));
    expect(envoi?.corps).toMatchObject({ awayName: "Paul Martin" });
  });

  it("ne charge la liste qu'UNE fois pour toute la vue, pas à chaque rencontre ouverte", async () => {
    connus = { teams: ["Massy"], players: [adversaire("Paul Martin")] };
    await ouvreSimple(1);
    expect(envois.filter((e) => e.url.includes("/api/interclub/opponents"))).toHaveLength(1);
  });

  // Le menu est un CONFORT de saisie, pas une donnée dont l'écran dépend : une réponse d'un
  // autre format ferait tomber toute la vue interclub s'il n'y avait pas de garde de forme.
  it("survit à une réponse d'un format inattendu", async () => {
    connus = { ancien: "format" } as unknown as typeof connus;
    const r = await ouvreSimple(1);
    expect(champ(r, "Adversaire").tagName).toBe("INPUT");
  });
});
