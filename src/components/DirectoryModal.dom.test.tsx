import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";
import { DirectoryModal } from "@/components/DirectoryModal";
import { invalidateDirectory } from "@/lib/directoryCache";

// LE FILTRE CLASSEMENT/CATÉGORIE (idée 6d du backlog) — la modale listait déjà `clt`/`cat` par
// membre, sans jamais permettre de restreindre la liste dessus. Ce fichier verrouille trois
// choses qu'un test manuel au clavier ne verrait pas forcément :
//   1. les menus de filtre n'apparaissent QUE s'il y a quelque chose à filtrer ;
//   2. le filtre classement trie par FORCE (`classementPower`), pas alphabétiquement — un tri
//      alpha placerait « 10B » avant « 2A », qui est pourtant le mieux classé des deux ;
//   3. les deux filtres se combinent (ET), comme la recherche par nom déjà en place.

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

beforeEach(() => {
  toast.mockClear();
  invalidateDirectory(); // le cache mémoire de directoryCache survit entre tests sans ça
});

describe("DirectoryModal — filtres classement/catégorie", () => {
  it("n'affiche aucun menu de filtre quand personne n'a de classement ni de catégorie", async () => {
    monte([
      { id: "a", name: "Alice" },
      { id: "b", name: "Bob" },
    ]);
    await souffle();
    expect(screen.queryByLabelText("Filtrer par classement")).toBeNull();
    expect(screen.queryByLabelText("Filtrer par catégorie")).toBeNull();
  });

  it("affiche le menu classement dès qu'un membre en a un, même si personne n'a de catégorie", async () => {
    monte([{ id: "a", name: "Alice", clt: "5A" }]);
    await souffle();
    expect(screen.getByLabelText("Filtrer par classement")).toBeTruthy();
    expect(screen.queryByLabelText("Filtrer par catégorie")).toBeNull();
  });

  it("filtre la liste par classement choisi", async () => {
    monte([
      { id: "a", name: "Alice", clt: "5A" },
      { id: "b", name: "Bob", clt: "4D" },
    ]);
    await souffle();
    fireEvent.change(screen.getByLabelText("Filtrer par classement"), {
      target: { value: "4D" },
    });
    expect(screen.getByText("Bob")).toBeTruthy();
    expect(screen.queryByText("Alice")).toBeNull();
  });

  it("filtre la liste par catégorie choisie", async () => {
    monte([
      { id: "a", name: "Alice", clt: "5A", cat: "+45" },
      { id: "b", name: "Bob", clt: "4D", cat: "Senior" },
    ]);
    await souffle();
    fireEvent.change(screen.getByLabelText("Filtrer par catégorie"), {
      target: { value: "Senior" },
    });
    expect(screen.getByText("Bob")).toBeTruthy();
    expect(screen.queryByText("Alice")).toBeNull();
  });

  it("combine classement ET catégorie, comme la recherche par nom", async () => {
    monte([
      { id: "a", name: "Alice", clt: "5A", cat: "Senior" },
      { id: "b", name: "Bob", clt: "4D", cat: "Senior" },
      { id: "c", name: "Chloé", clt: "4D", cat: "+45" },
    ]);
    await souffle();
    fireEvent.change(screen.getByLabelText("Filtrer par classement"), {
      target: { value: "4D" },
    });
    fireEvent.change(screen.getByLabelText("Filtrer par catégorie"), {
      target: { value: "Senior" },
    });
    expect(screen.getByText("Bob")).toBeTruthy();
    expect(screen.queryByText("Alice")).toBeNull(); // mauvais classement
    expect(screen.queryByText("Chloé")).toBeNull(); // mauvaise catégorie
  });

  it("trie les options de classement par FORCE (classementPower), 1I en tête, NC en dernier", async () => {
    // La liste FFSquash étant fermée (1I, 1N, 2A..5D, NC), un tri alphabétique brut coïnciderait
    // ici avec l'ordre par force — sauf que ce n'était PAS vrai avant que la liste soit fermée
    // (« 10B » triait avant « 2A »). On garde `classementPower` (et non `localeCompare`) : c'est
    // le sens correct, la coïncidence actuelle ne doit pas faire regretter le bon outil.
    monte([
      { id: "a", name: "Alice", clt: "3B" },
      { id: "b", name: "Bob", clt: "1N" },
      { id: "c", name: "Chloé", clt: "NC" },
      { id: "d", name: "Denis", clt: "1I" },
    ]);
    await souffle();
    const select = screen.getByLabelText("Filtrer par classement");
    const labels = within(select)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(labels).toEqual(["Tous les classements", "1I", "1N", "3B", "NC"]);
  });

  it("« Tous les classements » / « Toutes les catégories » revient à la liste complète", async () => {
    monte([
      { id: "a", name: "Alice", clt: "5A" },
      { id: "b", name: "Bob", clt: "4D" },
    ]);
    await souffle();
    const select = screen.getByLabelText("Filtrer par classement");
    fireEvent.change(select, { target: { value: "4D" } });
    expect(screen.queryByText("Alice")).toBeNull();
    fireEvent.change(select, { target: { value: "" } });
    expect(screen.getByText("Alice")).toBeTruthy();
    expect(screen.getByText("Bob")).toBeTruthy();
  });
});
