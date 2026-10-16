import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, fireEvent, screen } from "@testing-library/react";
import CaptainSquashnet from "@/components/CaptainSquashnet";

// ============================================================================
//  LA FENÊTRE « ENVOYER SUR SQUASHNET » — deux temps, et des identifiants qui
//  ne survivent pas à la fenêtre.
// ============================================================================

type Envoi = { action: string; login: string; password: string; seen: string | null };
let envois: Envoi[] = [];
let reponses: Array<{ status: number; body: unknown }> = [];

const LIGNES = [
  { ordre: 1, recevant: "PLENAT THOMAS", visiteur: "THUILLIER GUILLAUME", jeux: ["9-11", "3-11", "9-11"] },
];

async function souffle() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  envois = [];
  reponses = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      envois.push(JSON.parse(String(init.body)));
      const r = reponses.shift() ?? { status: 500, body: { error: "imprévu" } };
      return { ok: r.status < 400, status: r.status, json: async () => r.body } as Response;
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

const onSent = vi.fn();

function monte(toast = vi.fn()) {
  onSent.mockClear();
  render(
    <CaptainSquashnet
      fixtureId="f1"
      onClose={vi.fn()}
      onSent={onSent}
      toast={toast}
      onExpired={() => false}
    />,
  );
  const login = screen.getByLabelText("Identifiant squashnet") as HTMLInputElement;
  const mdp = screen.getByLabelText("Mot de passe squashnet") as HTMLInputElement;
  fireEvent.change(login, { target: { value: "thomas" } });
  fireEvent.change(mdp, { target: { value: "secret" } });
  return { login, mdp, toast };
}

describe("CaptainSquashnet", () => {
  it("expose des champs que le gestionnaire de mots de passe reconnaît", () => {
    const { login, mdp } = monte();
    expect(login.getAttribute("autocomplete")).toBe("username");
    expect(mdp.getAttribute("autocomplete")).toBe("current-password");
    expect(mdp.type).toBe("password");
    expect(login.closest("form")).toBe(mdp.closest("form"));
  });

  it("prépare, MONTRE, puis envoie ce qui a été montré", async () => {
    const { toast } = monte();
    reponses.push({ status: 200, body: { lignes: LIGNES, seen: "abcd1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Préparer l'envoi" }));
    await souffle();
    expect(envois[0]).toEqual({ action: "preview", login: "thomas", password: "secret", seen: null });
    expect(screen.getByText("PLENAT THOMAS – THUILLIER GUILLAUME")).toBeTruthy();
    expect(screen.getByText("9-11 3-11 9-11")).toBeTruthy();

    expect(onSent).not.toHaveBeenCalled();

    reponses.push({
      status: 200,
      body: { ok: true, lignes: LIGNES, sentAt: "2026-10-16T18:00:00.000Z" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Envoyer sur squashnet" }));
    await souffle();
    expect(envois[1]).toMatchObject({ action: "send", seen: "abcd1234" });
    // L'écran de la rencontre l'apprend, pour dire « envoyé le… » à la place du bouton.
    expect(onSent).toHaveBeenCalledWith("2026-10-16T18:00:00.000Z");
    expect(screen.getByRole("status").textContent).toMatch(/Envoyé, et relu sur squashnet/);
    expect(toast).toHaveBeenCalledWith("ok", "Score envoyé sur squashnet.");
    // Les identifiants ne restent pas à l'écran une fois le travail fait.
    expect(screen.queryByLabelText("Mot de passe squashnet")).toBeNull();
  });

  it("changer d'identifiants après l'aperçu oblige à préparer de nouveau", async () => {
    const { mdp } = monte();
    reponses.push({ status: 200, body: { lignes: LIGNES, seen: "abcd1234" } });
    fireEvent.click(screen.getByRole("button", { name: "Préparer l'envoi" }));
    await souffle();
    fireEvent.change(mdp, { target: { value: "autre" } });
    expect(screen.getByRole("button", { name: "Préparer l'envoi" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Envoyer sur squashnet" })).toBeNull();
  });

  it("affiche le refus et chacun de ses motifs", async () => {
    monte();
    reponses.push({
      status: 409,
      body: { error: "L'envoi n'est pas possible tel quel.", problemes: ["Simple n° 2 : Jeronimo n'est pas identifié."] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Préparer l'envoi" }));
    await souffle();
    const alerte = screen.getByRole("alert");
    expect(alerte.textContent).toMatch(/pas possible tel quel/);
    expect(alerte.textContent).toMatch(/Jeronimo n'est pas identifié/);
  });
});
