import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";
import { DirectoryModal } from "@/components/DirectoryModal";
import { invalidateDirectory } from "@/lib/directoryCache";

// LE FILTRE PAR ÉQUIPE — et le fait qu'il soit le SEUL.
//
// La modale a porté un temps deux filtres, classement et catégorie d'âge. Ils occupaient une
// ligne entière au-dessus d'une liste dont la recherche par nom fait déjà l'essentiel du
// travail, pour répondre à des questions qu'on ne se pose pas devant un annuaire de club
// (« montre-moi tous les 5A »). Ils ont été remplacés par le seul découpage qui compte ici :
// l'équipe interclub.
//
// Ce fichier verrouille trois choses qu'un essai au clavier ne verrait pas forcément :
//   1. le filtre n'apparaît QUE s'il y a des équipes à filtrer ;
//   2. les équipes sont dérivées des joueurs chargés, pas d'une liste figée — une 3ᵉ équipe
//      doit apparaître sans qu'on touche à ce code ;
//   3. l'annuaire mêle les joueurs SANS COMPTE aux membres, et le filtre les prend comme les
//      autres — c'est le cas d'usage qui a motivé leur entrée dans l'annuaire.

function reponse(corps: unknown): Response {
  return { ok: true, status: 200, json: async () => corps } as unknown as Response;
}

async function souffle() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

const toast = vi.fn();

function monte(members: Array<Record<string, unknown>>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => reponse({ members, groupUrl: null })),
  );
  return render(<DirectoryModal open onClose={() => {}} toast={toast} />);
}

/** Le groupe de boutons du filtre d'équipe, ou `null` s'il n'est pas rendu. */
function filtre() {
  return screen.queryByRole("group", { name: "Filtrer par équipe" });
}

beforeEach(() => {
  toast.mockClear();
  invalidateDirectory(); // le cache mémoire de directoryCache survit entre tests sans ça
});

describe("DirectoryModal — filtre par équipe", () => {
  it("n'affiche aucun filtre quand personne n'est dans une équipe", async () => {
    monte([
      { id: "a", name: "Alice" },
      { id: "b", name: "Bob" },
    ]);
    await souffle();
    expect(filtre()).toBeNull();
  });

  it("ne propose plus de filtrer par classement ni par catégorie", async () => {
    // Ces deux menus ont été retirés : ils coûtaient une ligne d'écran sur un téléphone pour
    // une question qu'on ne pose pas. Le test le dit, faute de quoi les remettre passerait
    // pour un ajout innocent.
    monte([{ id: "a", name: "Alice", clt: "5A", cat: "Senior" }]);
    await souffle();
    expect(screen.queryByLabelText("Filtrer par classement")).toBeNull();
    expect(screen.queryByLabelText("Filtrer par catégorie")).toBeNull();
  });

  it("dérive les équipes des joueurs chargés, dans l'ordre alphabétique", async () => {
    // Pas de liste figée : une 3ᵉ équipe ne coûte qu'une ligne en base et doit apparaître ici
    // sans qu'on touche à ce code.
    monte([
      { id: "a", name: "Alice", team: "Équipe 2" },
      { id: "b", name: "Bob", team: "Équipe 1" },
      { id: "c", name: "Chloé" },
    ]);
    await souffle();
    const boutons = within(filtre() as HTMLElement).getAllByRole("button");
    // Libellé abrégé à l'écran (« Éq. 1 »), nom complet pour les lecteurs d'écran.
    expect(boutons.map((b) => b.textContent)).toEqual(["Tous", "Éq. 1Équipe 1", "Éq. 2Équipe 2"]);
  });

  it("filtre la liste sur l'équipe choisie, et « Tous » revient à la liste complète", async () => {
    monte([
      { id: "a", name: "Alice", team: "Équipe 1" },
      { id: "b", name: "Bob", team: "Équipe 2" },
      { id: "c", name: "Chloé" },
    ]);
    await souffle();
    const groupe = filtre() as HTMLElement;
    fireEvent.click(within(groupe).getByRole("button", { name: "Équipe 1" }));
    expect(screen.getByText("Alice")).toBeTruthy();
    expect(screen.queryByText("Bob")).toBeNull();
    // Un joueur sans équipe n'appartient à aucune : il sort dès qu'on en choisit une.
    expect(screen.queryByText("Chloé")).toBeNull();

    fireEvent.click(within(groupe).getByRole("button", { name: "Tous" }));
    expect(screen.getByText("Alice")).toBeTruthy();
    expect(screen.getByText("Bob")).toBeTruthy();
    expect(screen.getByText("Chloé")).toBeTruthy();
  });

  it("marque l'équipe active, « Tous » l'étant au départ", async () => {
    monte([{ id: "a", name: "Alice", team: "Équipe 1" }]);
    await souffle();
    const groupe = filtre() as HTMLElement;
    const tous = within(groupe).getByRole("button", { name: "Tous" });
    const eq1 = within(groupe).getByRole("button", { name: "Équipe 1" });
    expect(tous.getAttribute("aria-pressed")).toBe("true");
    expect(eq1.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(eq1);
    expect(tous.getAttribute("aria-pressed")).toBe("false");
    expect(eq1.getAttribute("aria-pressed")).toBe("true");
  });

  it("se combine à la recherche par nom, sans l'annuler", async () => {
    monte([
      { id: "a", name: "Alice", team: "Équipe 1" },
      { id: "b", name: "Amélie", team: "Équipe 2" },
      { id: "c", name: "Bob", team: "Équipe 1" },
    ]);
    await souffle();
    fireEvent.change(screen.getByLabelText("Rechercher un membre"), { target: { value: "a" } });
    fireEvent.click(
      within(filtre() as HTMLElement).getByRole("button", { name: "Équipe 1" }),
    );
    expect(screen.getByText("Alice")).toBeTruthy();
    expect(screen.queryByText("Amélie")).toBeNull(); // bonne recherche, mauvaise équipe
    expect(screen.queryByText("Bob")).toBeNull(); // bonne équipe, mauvaise recherche
  });

  it("traite un joueur SANS COMPTE comme les autres — c'est le cas qui a motivé le filtre", async () => {
    // Un joueur d'une équipe interclub qui n'a pas l'appli figure à l'annuaire pour être
    // TROUVÉ : le filtrer hors de son équipe le rendrait à nouveau introuvable.
    monte([
      { id: "a", kind: "member", name: "Alice", team: "Équipe 1" },
      { id: "guest:g1", kind: "guest", name: "Paul Hors-Appli", team: "Équipe 1", clt: "5A" },
    ]);
    await souffle();
    fireEvent.click(
      within(filtre() as HTMLElement).getByRole("button", { name: "Équipe 1" }),
    );
    expect(screen.getByText("Paul Hors-Appli")).toBeTruthy();
    expect(screen.getByText("Alice")).toBeTruthy();
  });
});
