import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import Interclub from "@/components/Interclub";

// LA CORRECTION DE LA FICHE D'UNE RENCONTRE — date, heure, journée, lieu, statut de la date.
//
// `PATCH /api/interclub/[id]` existait, complet et testé, SANS AUCUN APPELANT. L'aperçu du
// calendrier fédéral disait pourtant « à corriger à la main sur la rencontre » quand la ligue
// et la base divergent sur `dateConfirmed` : la doctrine reposait sur un geste impossible.
//
// Ce que ces tests tiennent, et qui ne se relit pas dans le JSX :
//
//  1. ON N'ENVOIE QUE CE QUI A CHANGÉ. La route distingue « champ absent » (on ne touche pas)
//     de « `null` explicite » (on efface) : poster le formulaire entier effacerait le lieu
//     qu'un import vient de renseigner, pour le seul motif qu'on a corrigé l'heure.
//  2. UN REPORT S'ANNONCE AVANT DE S'ÉCRIRE. Changer la date efface les disponibilités déjà
//     recueillies — le découvrir après, c'est le découvrir quand elles sont perdues.
//  3. UNE RENCONTRE COMMENCÉE NE SE DÉPLACE PLUS. Le serveur refuse en 409 ; l'écran le refuse
//     avant, pour ne pas le faire découvrir après ressaisie.

type Envoi = { url: string; methode: string; corps: Record<string, unknown> | null };
let envois: Envoi[] = [];

const FIXTURE = {
  id: "f1",
  date: "2026-09-03",
  time: "20:00",
  venue: "Squash de Massy",
  venueAddress: "12 rue du Stade, 91300 Massy",
  round: "J3",
  dateConfirmed: true,
  season: null,
  bestOf: 5,
  matchCount: 1,
  status: "scheduled",
  home: false,
  opponent: "Massy",
  createdById: "u1",
  isCreator: true,
  canDelete: true,
  canEdit: true,
  winGames: 3,
  score: { home: 0, away: 0 },
  outcome: null,
  team: { id: "t1", name: "Équipe 1", captainId: null, captainName: null },
  roster: [{ kind: "member", id: "u1", name: "Thomas", clt: null, rangM: null }],
  matches: [
    {
      id: "m1",
      order: 1,
      status: "pending",
      homeUserId: "u1",
      homeGuestId: null,
      homeDisplayName: "Thomas",
      awayName: "Jérôme Massy",
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
    },
  ],
};

/** Remplace des champs de `FIXTURE` pour un test précis. */
let surcharge: Record<string, unknown> = {};

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
  surcharge = {};
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
      if (u.includes("/api/interclub/follows")) return reponse({ follows: [], pushReady: false });
      if (u.includes("/availability")) {
        return reponse({
          entries: [],
          counts: { yes: 0, no: 0, maybe: 0, pendingReachable: [], pendingUnreachable: [] },
          matchCount: 4,
          me: "u1",
        });
      }
      if (u.includes("/api/interclub/live")) return reponse({ fixtures: [] });
      if (/\/api\/interclub\/f1$/.test(u)) return reponse({ ...FIXTURE, ...surcharge });
      return reponse({
        teams: [{ id: "t1", name: "Équipe 1" }],
        fixtures: [
          {
            id: "f1",
            date: "2026-09-03",
            opponent: "Massy",
            home: false,
            status: "scheduled",
            score: { home: 0, away: 0 },
            team: { id: "t1", name: "Équipe 1" },
          },
        ],
      });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Ouvre la rencontre, puis le formulaire de correction si le bouton existe. */
async function ouvre(avecFormulaire = true) {
  const r = render(<Interclub toast={vi.fn()} onExpired={() => false} />);
  await souffle();
  fireEvent.click(r.getByText(/Massy/));
  await souffle();
  if (avecFormulaire) {
    fireEvent.click(r.getByRole("button", { name: /Modifier la rencontre/ }));
    await souffle();
  }
  return r;
}

/** Le corps du dernier PATCH sur la RENCONTRE (et non sur l'un de ses simples). */
const dernierPatch = () =>
  envois.filter((e) => e.methode === "PATCH" && /\/api\/interclub\/f1$/.test(e.url)).at(-1)
    ?.corps ?? null;

describe("le droit de corriger", () => {
  it("n'offre RIEN à qui n'a pas le droit — l'écran suit le serveur, il ne devine pas", async () => {
    surcharge = { canEdit: false };
    const r = await ouvre(false);
    expect(r.queryByRole("button", { name: /Modifier la rencontre/ })).toBeNull();
  });
});

// L'ADRESSE EST UN ITINÉRAIRE. En déplacement, c'est l'information la plus utile de l'écran,
// et la recopier à la main dans une autre application au volant est le pire moment pour la
// recopier. Une URL https plutôt qu'un schéma propriétaire : `maps:` ne s'ouvre pas sur
// Android, `geo:` pas sur iOS.
describe("le lieu du déplacement", () => {
  it("ouvre l'adresse dans une carte, sans quitter l'appli au retour", async () => {
    const r = await ouvre(false);
    const lien = r.getByRole("link", { name: /12 rue du Stade/ }) as HTMLAnchorElement;
    expect(lien.href).toContain("google.com/maps");
    // Le club hôte ET l'adresse : une rue seule tombe parfois sur la mauvaise commune.
    expect(decodeURIComponent(lien.href)).toContain("Squash de Massy 12 rue du Stade");
    expect(lien.target).toBe("_blank");
    expect(lien.rel).toContain("noopener");
  });

  it("offre l'ajout à l'agenda à TOUT LE MONDE, pas seulement à qui peut corriger", async () => {
    // Emporter la date d'une rencontre n'est pas un droit d'administration : c'est le geste
    // du joueur qui veut la retrouver dans son téléphone.
    surcharge = { canEdit: false };
    const r = await ouvre(false);
    expect(r.getByRole("button", { name: /Agenda/ })).toBeTruthy();
  });
});

describe("on n'envoie que ce qui a changé", () => {
  it("corrige l'heure SEULE, sans emporter le lieu que l'import a renseigné", async () => {
    const r = await ouvre();
    fireEvent.change(r.getByLabelText("Heure"), { target: { value: "20:30" } });
    fireEvent.click(r.getByRole("button", { name: "Enregistrer" }));
    await souffle();
    expect(dernierPatch()).toEqual({ time: "20:30" });
  });

  it("efface un champ vidé — la chaîne vide est un ORDRE, pas une absence", async () => {
    const r = await ouvre();
    fireEvent.change(r.getByLabelText("Club hôte"), { target: { value: "" } });
    fireEvent.click(r.getByRole("button", { name: "Enregistrer" }));
    await souffle();
    expect(dernierPatch()).toEqual({ venue: "" });
  });

  it("envoie le statut de la date TOUT SEUL — c'est le rattrapage que le calendrier réclame", async () => {
    const r = await ouvre();
    fireEvent.click(r.getByLabelText(/Date confirmée par la ligue/));
    fireEvent.click(r.getByRole("button", { name: "Enregistrer" }));
    await souffle();
    expect(dernierPatch()).toEqual({ dateConfirmed: false });
  });

  it("n'enregistre rien quand rien n'a bougé", async () => {
    const r = await ouvre();
    expect((r.getByRole("button", { name: "Enregistrer" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("refuse un adversaire vide, que la route refuserait en 400", async () => {
    const r = await ouvre();
    fireEvent.change(r.getByLabelText("Club adverse"), { target: { value: "  " } });
    expect((r.getByRole("button", { name: "Enregistrer" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});

describe("le report d'une rencontre", () => {
  it("s'annonce avant de s'écrire : le premier clic n'envoie RIEN", async () => {
    const r = await ouvre();
    fireEvent.change(r.getByLabelText("Date"), { target: { value: "2026-09-10" } });
    fireEvent.click(r.getByRole("button", { name: "Enregistrer" }));
    await souffle();
    // Rien n'est parti, et l'écran dit maintenant ce que le report coûte.
    expect(dernierPatch()).toBeNull();
    expect(r.getByText(/efface les disponibilités/)).toBeTruthy();

    fireEvent.click(r.getByRole("button", { name: "Déplacer et prévenir" }));
    await souffle();
    expect(dernierPatch()).toEqual({ date: "2026-09-10" });
  });

  it("ferme la date d'une rencontre COMMENCÉE, et le dit", async () => {
    // Le serveur refuse en 409 ; l'écran refuse avant, pour ne pas le faire découvrir après
    // avoir tout ressaisi. Le reste de la fiche demeure corrigible.
    surcharge = { status: "live" };
    const r = await ouvre();
    expect((r.getByLabelText("Date") as HTMLInputElement).disabled).toBe(true);
    expect(r.getByText(/sa date ne peut plus changer/)).toBeTruthy();

    fireEvent.change(r.getByLabelText("Heure"), { target: { value: "21:00" } });
    fireEvent.click(r.getByRole("button", { name: "Enregistrer" }));
    await souffle();
    expect(dernierPatch()).toEqual({ time: "21:00" });
  });
});
