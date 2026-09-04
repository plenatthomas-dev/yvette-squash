import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, within } from "@testing-library/react";
import { InterclubAvailability } from "./InterclubAvailability";

// ============================================================================
//  « QUI PEUT VENIR ? » — CE QUE CET ÉCRAN DOIT TENIR
//
//  Le bloc a deux propriétés qui ne se déduisent d'aucun rendu, et que seule
//  une vérification comme celle-ci empêche de perdre au prochain remaniement :
//
//   1. RÉPONDRE POUR SOI ET RÉPONDRE POUR UN AUTRE NE S'ÉCRIVENT PAS PAREIL.
//      Sa propre réponse ne porte NI `userId` NI `guestId` ; celle d'un
//      coéquipier porte le sien. Envoyer son propre identifiant marcherait
//      côté serveur — et transformerait chaque réponse en relais, donc
//      afficherait « relayé par Thomas » à Thomas.
//   2. ÉCRASER UNE RÉPONSE DE PREMIÈRE MAIN SE CONFIRME. Le 409 n'est pas une
//      erreur : c'est une question. Le traiter comme une panne ferait croire à
//      un bug, et le passer sous silence ferait disparaître un « non » assumé.
// ============================================================================

const fetchMock = vi.fn();

/** Réponse JSON minimale, façon `fetch`. */
function json(corps: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => corps } as unknown as Response;
}

type Entree = {
  key: string;
  name: string;
  isMember: boolean;
  status: "yes" | "no" | "maybe" | null;
  comment: string | null;
  relayedBy: string | null;
  reachable: boolean;
};

function entree(over: Partial<Entree> & { key: string; name: string }): Entree {
  return {
    isMember: true,
    status: null,
    comment: null,
    relayedBy: null,
    reachable: true,
    ...over,
  };
}

/** Le décompte, calculé comme le serveur le fait (`tally`), pour ne pas le figer à la main. */
function corps(entries: Entree[], matchCount = 4, me = "u1") {
  return {
    entries,
    counts: {
      yes: entries.filter((e) => e.status === "yes").length,
      no: entries.filter((e) => e.status === "no").length,
      maybe: entries.filter((e) => e.status === "maybe").length,
      pendingReachable: entries.filter((e) => !e.status && e.reachable),
      pendingUnreachable: entries.filter((e) => !e.status && !e.reachable),
    },
    matchCount,
    me,
  };
}

async function souffle() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

const toast = vi.fn();

/** Monte le bloc sur une rencontre, la liste étant servie par le GET initial. */
async function monte(entries: Entree[], matchCount = 4) {
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (!init || init.method !== "PUT") return json(corps(entries, matchCount));
    return json(corps(entries, matchCount));
  });
  render(<InterclubAvailability fixtureId="f1" toast={toast} onExpired={() => false} />);
  await souffle();
}

/** Les corps des PUT envoyés à l'API, décodés. */
function puts(): Array<Record<string, unknown>> {
  return fetchMock.mock.calls
    .filter((c) => c[1]?.method === "PUT")
    .map((c) => JSON.parse(c[1].body as string));
}

/** Le groupe de boutons d'une personne — c'est par son libellé accessible qu'on le trouve. */
const boutonsDe = (nom: string) => screen.getByRole("group", { name: `Disponibilité de ${nom}` });

beforeEach(() => {
  fetchMock.mockReset();
  toast.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("bloc de disponibilité — lire l'état de l'équipe", () => {
  it("présente les trois réponses comme une ÉCHELLE, du oui au non", async () => {
    // L'ordre de déclaration des statuts suit la fréquence attendue, pas la lecture. Rendus
    // tels quels, ils donnaient « Dispo · Pas dispo · Incertain » — le milieu après la fin.
    await monte([entree({ key: "u1", name: "Thomas" })]);

    const libelles = within(boutonsDe("Thomas"))
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(libelles).toEqual(["Dispo", "Incertain", "Pas dispo"]);
  });

  it("compte en SIMPLES COUVERTS et s'alarme quand il en manque", async () => {
    // La question du capitaine n'est pas « combien ont répondu » mais « ai-je quatre joueurs ».
    // Les incertains sont dits à PART : les additionner ferait taire l'alerte quand elle sert.
    await monte([
      entree({ key: "u1", name: "Thomas", status: "yes" }),
      entree({ key: "u2", name: "Alice", status: "yes" }),
      entree({ key: "u3", name: "Bruno", status: "maybe" }),
    ]);

    expect(screen.getByText(/2\/4 dispo/)).toBeTruthy();
    expect(screen.getByText(/1 incertain/)).toBeTruthy();
    expect(screen.getByText(/2\/4 dispo/).className).toContain("is-short");
  });

  it("ne s'alarme plus dès que les simples sont couverts", async () => {
    await monte(
      [
        entree({ key: "u1", name: "Thomas", status: "yes" }),
        entree({ key: "u2", name: "Alice", status: "yes" }),
      ],
      2,
    );
    expect(screen.getByText(/2\/2 dispo/).className).not.toContain("is-short");
  });

  it("affiche la PROVENANCE d'une réponse relayée, et rien sur une réponse directe", async () => {
    // « il a dit oui » et « on a dit qu'il dirait oui » ne sont pas la même information : les
    // confondre fait venir trois joueurs pour quatre simples.
    await monte([
      entree({ key: "u1", name: "Thomas", status: "yes" }),
      entree({ key: "u2", name: "Alice", status: "yes", relayedBy: "Thomas" }),
    ]);

    expect(screen.getByText(/relayé par Thomas/)).toBeTruthy();
    expect(screen.getAllByText(/relayé par/)).toHaveLength(1);
  });

  it("regroupe les sans-réponse SANS NOTIFICATION dans la liste d'appels", async () => {
    // Ceux-là ne recevront aucune relance : les mêler aux autres silencieux ferait attendre
    // une réponse qui ne viendra jamais.
    await monte([
      entree({ key: "u2", name: "Alice", reachable: true }),
      entree({ key: "guest:g1", name: "Xavier", isMember: false, reachable: false }),
    ]);

    const appel = screen.getByText(/Sans réponse et sans notification/);
    expect(appel.textContent).toContain("Xavier");
    expect(appel.textContent).not.toContain("Alice");
  });

  it("DIT pourquoi il n'y a rien, quand on n'est pas de cette équipe", async () => {
    // Le bloc ne rendait rien du tout sur un 403 : un membre d'une autre équipe, ou un admin
    // rattaché à aucune, voyait un espace vide et sans un mot. On cherche alors la panne dans
    // le code alors qu'il n'y a qu'une règle — et une règle tue ressemble à un bug.
    fetchMock.mockImplementation(async () => json({ error: "Réservé aux joueurs de cette équipe" }, 403));
    render(<InterclubAvailability fixtureId="f1" toast={toast} onExpired={() => false} />);
    await souffle();

    expect(screen.getByText(/réservées aux joueurs de cette équipe/i)).toBeTruthy();
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("ne montre pas de liste d'appels quand tout le monde est joignable", async () => {
    await monte([entree({ key: "u2", name: "Alice", reachable: true })]);
    expect(screen.queryByText(/Sans réponse et sans notification/)).toBeNull();
  });
});

describe("bloc de disponibilité — répondre", () => {
  it("envoie sa PROPRE réponse sans identifiant de sujet", async () => {
    // Le sujet implicite, c'est soi. Envoyer son propre `userId` marcherait côté serveur et
    // ferait passer chaque réponse pour un relais — donc « relayé par Thomas » affiché à Thomas.
    await monte([entree({ key: "u1", name: "Thomas" })]);

    await act(async () => {
      fireEvent.click(within(boutonsDe("Thomas")).getByRole("button", { name: "Dispo" }));
      await souffle();
    });

    expect(puts()).toEqual([{ status: "yes" }]);
  });

  it("envoie l'identifiant du COÉQUIPIER quand on répond pour lui", async () => {
    await monte([
      entree({ key: "u1", name: "Thomas" }),
      entree({ key: "u2", name: "Alice" }),
    ]);

    await act(async () => {
      fireEvent.click(within(boutonsDe("Alice")).getByRole("button", { name: "Pas dispo" }));
      await souffle();
    });

    expect(puts()).toEqual([{ status: "no", userId: "u2" }]);
  });

  it("envoie un guestId pour un joueur SANS COMPTE, jamais un userId", async () => {
    // C'est la moitié du roster dans certains clubs : sans ce chemin, l'outil ne sert à rien
    // pour eux et le capitaine retourne sur WhatsApp.
    await monte([entree({ key: "guest:g1", name: "Xavier", isMember: false, reachable: false })]);

    await act(async () => {
      fireEvent.click(within(boutonsDe("Xavier")).getByRole("button", { name: "Incertain" }));
      await souffle();
    });

    expect(puts()).toEqual([{ status: "maybe", guestId: "g1" }]);
  });

  it("marque le choix retenu par aria-pressed, et lui seul", async () => {
    await monte([entree({ key: "u1", name: "Thomas", status: "maybe" })]);

    const presses = within(boutonsDe("Thomas"))
      .getAllByRole("button")
      .filter((b) => b.getAttribute("aria-pressed") === "true")
      .map((b) => b.textContent);
    expect(presses).toEqual(["Incertain"]);
  });

  it("garde le repère « moi » même si la réponse du serveur omet `me`", async () => {
    // Le défaut qui a motivé ce test : le PUT ne rendait pas `me`, et l'écran remplaçant tout
    // son état par ce corps, plus aucune ligne n'était la mienne après la première réponse — le
    // lien « Ajouter une précision » disparaissait. Le serveur le rend désormais des deux
    // côtés ; cette vérification est la ceinture, sur un PUT qui l'omettrait quand même.
    const entries = [entree({ key: "u1", name: "Thomas" })];
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init || init.method !== "PUT") return json(corps(entries));
      const { me: _sans, ...ampute } = corps(entries);
      return json(ampute);
    });
    render(<InterclubAvailability fixtureId="f1" toast={toast} onExpired={() => false} />);
    await souffle();

    await act(async () => {
      fireEvent.click(within(boutonsDe("Thomas")).getByRole("button", { name: "Dispo" }));
      await souffle();
    });

    expect(screen.getAllByRole("button", { name: /précision/i })).toHaveLength(1);
  });

  it("n'offre la précision libre QUE pour soi", async () => {
    // Le commentaire est une parole à la première personne, lue par toute l'équipe. L'écrire
    // au nom d'un autre est un pas de plus que consigner sa disponibilité.
    await monte([
      entree({ key: "u1", name: "Thomas" }),
      entree({ key: "u2", name: "Alice" }),
    ]);

    expect(screen.getAllByRole("button", { name: /précision/i })).toHaveLength(1);
  });

  it("joint la précision à la réponse déjà posée", async () => {
    await monte([entree({ key: "u1", name: "Thomas", status: "yes" })]);

    fireEvent.click(screen.getByRole("button", { name: /Ajouter une précision/i }));
    fireEvent.change(screen.getByLabelText("Précision sur ma disponibilité"), {
      target: { value: "pas avant 20h30" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
      await souffle();
    });

    expect(puts()).toEqual([{ status: "yes", comment: "pas avant 20h30" }]);
  });
});

describe("bloc de disponibilité — écraser une réponse de première main", () => {
  /** Le serveur refuse d'abord (409), puis accepte la même réponse confirmée. */
  async function monteAvecConflit() {
    const entries = [
      entree({ key: "u1", name: "Thomas" }),
      entree({ key: "u2", name: "Alice", status: "no" }),
    ];
    let refuse = true;
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init || init.method !== "PUT") return json(corps(entries));
      if (refuse) {
        refuse = false;
        return json({ existing: { status: "no", updatedAt: "2026-10-01T10:00:00.000Z" } }, 409);
      }
      return json(corps(entries));
    });
    render(<InterclubAvailability fixtureId="f1" toast={toast} onExpired={() => false} />);
    await souffle();
  }

  it("DEMANDE au lieu de refuser, en montrant ce qu'on remplace", async () => {
    // Un refus sec ferait croire à une panne. Ce qu'il faut montrer, c'est la réponse
    // existante — c'est elle qui permet de décider.
    await monteAvecConflit();

    await act(async () => {
      fireEvent.click(within(boutonsDe("Alice")).getByRole("button", { name: "Dispo" }));
      await souffle();
    });

    const dialogue = screen.getByRole("alertdialog", { name: /Confirmer le remplacement/i });
    expect(dialogue.textContent).toContain("Alice");
    expect(dialogue.textContent).toContain("Pas dispo");
    expect(dialogue.textContent).toContain("Dispo");
    expect(toast).not.toHaveBeenCalled(); // 409 n'est pas une erreur : c'est une question
  });

  it("ne renvoie la réponse qu'AVEC confirmOverride, une fois confirmée", async () => {
    await monteAvecConflit();

    await act(async () => {
      fireEvent.click(within(boutonsDe("Alice")).getByRole("button", { name: "Dispo" }));
      await souffle();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remplacer" }));
      await souffle();
    });

    expect(puts()).toEqual([
      { status: "yes", userId: "u2" },
      { status: "yes", userId: "u2", confirmOverride: true },
    ]);
  });

  it("n'écrit rien du tout si on annule", async () => {
    await monteAvecConflit();

    await act(async () => {
      fireEvent.click(within(boutonsDe("Alice")).getByRole("button", { name: "Dispo" }));
      await souffle();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Annuler" }));
      await souffle();
    });

    expect(puts()).toHaveLength(1); // la tentative refusée, et rien après
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});
