import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import InterclubTeamSheet, { posteCourt } from "@/components/InterclubTeamSheet";
import { ficheEquipe, ficheJoueur } from "@/lib/interclub-team-sheet";
import { parsePool } from "@/lib/squashnet/pool";
import { parseTeamRoster } from "@/lib/squashnet/roster";
import { parsePlayer } from "@/lib/squashnet/player";

// LA FICHE D'UNE ÉQUIPE DE LA POULE, À L'ÉCRAN — le parcours de l'appli Squash App :
// Squash in Issy → J1 → Rafik Kadi → retour → Effectif. Les charges servies sont celles que la
// route assemblerait sur les vrais fragments du 2026-10-18.
//
// Ce qu'on tient : une pile de vues dans UNE modale (la flèche remonte d'un cran), aucune
// requête au retour sur une vue déjà lue, et la relecture en arrière-plan quand `stale`.

const lire = (f: string) => readFileSync(join(process.cwd(), "src/lib/squashnet/__fixtures__", f), "utf8");
const pool = parsePool(lire("poule-2027-h4-poule-b.html"));
const issy = parseTeamRoster(lire("equipe-2027-176169-aqissy.html"), "176169");
const kadi = parsePlayer(lire("joueur-2027-644801-fiche.html"), "644801");
const now = new Date("2026-10-18T20:00:00Z");

const ficheIssy = (stale = false) => ({
  ...JSON.parse(
    JSON.stringify(
      ficheEquipe({
        snTeamId: "176169",
        standings: pool.standings,
        standingsAt: now,
        pool: { ties: pool.ties!, fetchedAt: now },
        roster: { players: issy.players, club: issy.club, captain: issy.captain, fetchedAt: now },
        now,
        poolFraisMs: 6 * 3_600_000,
        rosterFraisMs: 7 * 86_400_000,
      }),
    ),
  ),
  stale,
});
const ficheKadi = JSON.parse(
  JSON.stringify(
    ficheJoueur({
      regiid: "644801",
      cached: { player: kadi, fetchedAt: now },
      ties: pool.ties!,
      standings: pool.standings,
      now,
      fraisMs: 6 * 3_600_000,
    }),
  ),
);

let appels: Array<{ url: string; method: string }> = [];
let equipeStale = false;

beforeEach(() => {
  appels = [];
  equipeStale = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      appels.push({ url, method });
      const corps = url.includes("/poule/joueur")
        ? ficheKadi
        : ficheIssy(method === "GET" ? equipeStale : false);
      return new Response(JSON.stringify(corps), { status: 200, headers: { "Content-Type": "application/json" } });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const monter = () =>
  render(<InterclubTeamSheet snTeamId="176169" name="Squash in Issy" onClose={() => {}} onExpired={() => false} />);

describe("InterclubTeamSheet", () => {
  it("rencontres → détail d'une rencontre → joueur → retour, sans relire ce qui est lu", async () => {
    monter();
    const dialog = await screen.findByRole("dialog");

    // Les rencontres de l'équipe, avec leur score.
    const j1 = await within(dialog).findByRole("button", { name: /J1.*Verrieres 5.*Squash in Issy/ });
    expect(j1.textContent).toContain("1–3");
    expect(j1.className).toContain("ic-issue-win");
    // Une rencontre à venir ne s'ouvre pas.
    expect(within(dialog).queryByRole("button", { name: /J3/ })).toBeNull();
    expect(dialog.textContent).toContain("J3");

    // Le détail : les quatre simples, jeu par jeu, et les totaux de Squash App.
    fireEvent.click(j1);
    expect(await within(dialog).findByText("Homme 3")).toBeTruthy();
    expect(dialog.textContent).toContain("20:00 · jeux 6–11 · points 155–166");
    const kadiBtn = within(dialog).getByRole("button", { name: /Kadi Rafik/ });
    expect(kadiBtn.className).toContain("is-winner");

    // Le joueur : ses deux matchs, l'équipe adverse nommée.
    fireEvent.click(kadiBtn);
    await waitFor(() => expect(dialog.textContent).toContain("2 matchs"));
    expect(dialog.textContent).toContain("Bougardier Franck");
    expect(dialog.textContent).toContain("Verrieres 4");
    expect(dialog.textContent).toContain("2 V – 0 D");
    // Son club et son classement actuel en tête, une fois ; son classement du soir sur chaque match.
    expect(dialog.textContent).toContain("RM #4976 · cat. +45 · Squash in Issy");
    expect(dialog.querySelectorAll(".ic-sheet-opp-team")[0]?.textContent?.trim()).toBe("Verrieres 4");
    expect(dialog.textContent).toContain("· classé 5B");

    // Deux retours : la rencontre, puis l'équipe — sans une requête de plus.
    const avant = appels.length;
    fireEvent.click(within(dialog).getByRole("button", { name: "Revenir en arrière" }));
    expect(await within(dialog).findByText("Homme 1")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Revenir en arrière" }));
    expect(await within(dialog).findByRole("button", { name: /J1.*Verrieres 5/ })).toBeTruthy();
    expect(appels.length).toBe(avant);
    expect(within(dialog).queryByRole("button", { name: "Revenir en arrière" })).toBeNull();
  });

  it("l'effectif : trié au rang mixte, chaque inscrit ouvre sa fiche", async () => {
    monter();
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("tab", { name: /Effectif \(6\)/ }));
    const noms = [...dialog.querySelectorAll(".ic-sheet-roster .ic-sheet-name")].map((e) => e.textContent);
    expect(noms[0]).toBe("Renard Nicolas");
    expect(noms).toContain("Kadi Rafik");
    fireEvent.click(within(dialog).getByRole("button", { name: /Kadi Rafik/ }));
    await waitFor(() => expect(dialog.textContent).toContain("2 matchs"));
    // Retour : l'onglet Effectif est resté choisi.
    fireEvent.click(within(dialog).getByRole("button", { name: "Revenir en arrière" }));
    expect(await within(dialog).findByRole("tab", { name: /Effectif/, selected: true })).toBeTruthy();
  });

  it("une fiche à relire s'affiche d'abord, puis se relit en arrière-plan (POST)", async () => {
    equipeStale = true;
    monter();
    await screen.findByRole("button", { name: /J1.*Verrieres 5/ });
    await waitFor(() => expect(appels.some((a) => a.method === "POST")).toBe(true));
    expect(appels[0]).toMatchObject({ method: "GET" });
    expect(appels.filter((a) => a.method === "POST")).toHaveLength(1);
  });

  it("toucher l'adversaire dans une rencontre ouvre SA fiche", async () => {
    monter();
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(await within(dialog).findByRole("button", { name: /J1.*Verrieres 5/ }));
    fireEvent.click(await within(dialog).findByRole("button", { name: "Verrieres 5" }));
    await waitFor(() =>
      expect(appels.some((a) => a.url.includes("snTeamId=176174"))).toBe(true),
    );
  });
});

describe("posteCourt — la position dans l'ordre des simples", () => {
  it("« Homme 3 » → « H3 », « Dame 1 » → « D1 » ; l'inconnu reste tel quel", () => {
    expect(posteCourt("Homme 3")).toBe("H3");
    expect(posteCourt("Dame 1")).toBe("D1");
    expect(posteCourt("Simple mixte")).toBe("Simple mixte");
  });
});
