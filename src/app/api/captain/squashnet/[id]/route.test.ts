import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NextRequest } from "next/server";
import { rapport1893481 } from "@/lib/squashnet/__fixtures__/rapport-2027-1893481";
import type { LigneEnvoi } from "@/lib/squashnet/captain";

// ============================================================================
//  POST /api/captain/squashnet/{id} — préparer, puis envoyer, au nom du capitaine.
//
//  Le réseau squashnet est simulé au niveau de `session.ts` ; la lecture du
//  formulaire, elle, tourne pour de vrai sur la capture de la rencontre 1893481.
// ============================================================================

const fixtures = join(__dirname, "..", "..", "..", "..", "..", "lib", "squashnet", "__fixtures__");
const FORMULAIRE = readFileSync(join(fixtures, "capitaine-2027-1893481-saisie.html"), "utf8");
const RENCONTRES = readFileSync(join(fixtures, "capitaine-2027-176168-rencontres.html"), "utf8");

const MDP = "m0t-de-passe-secret";

const h = vi.hoisted(() => ({
  access: true,
  fixture: null as null | Record<string, unknown>,
  echecs: 0,
  tentatives: [] as unknown[],
  ouvrirSession: vi.fn(),
  posterAjax: vi.fn(),
  posterFormulaire: vi.fn(),
  officialUpdate: vi.fn(),
}));

vi.mock("@/lib/captain-access", () => {
  const ok = { ok: true, session: { userId: "u1" }, teamIds: ["t1"], isAdmin: false };
  const refus = () => ({ ok: false, response: new Response(null, { status: 403 }) });
  return {
    requireCaptain: vi.fn(async () => (h.access ? ok : refus())),
    requireCaptainOf: vi.fn(async () => (h.access ? ok : refus())),
  };
});
vi.mock("@/lib/db", () => ({
  prisma: {
    interclub: { findUnique: vi.fn(async () => h.fixture) },
    interclubOfficial: { update: (...a: unknown[]) => h.officialUpdate(...a) },
    loginAttempt: {
      count: vi.fn(async () => h.echecs),
      create: vi.fn(async (a: unknown) => {
        h.tentatives.push(a);
        return {};
      }),
    },
  },
}));
vi.mock("@/lib/squashnet/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/squashnet/session")>()),
  ouvrirSession: (...a: unknown[]) => h.ouvrirSession(...a),
  posterAjax: (...a: unknown[]) => h.posterAjax(...a),
  posterFormulaire: (...a: unknown[]) => h.posterFormulaire(...a),
}));

import { POST } from "./route";
import { AccesRefuse } from "@/lib/squashnet/session";

const req = (body: unknown) =>
  ({
    json: async () => body,
    headers: new Headers(),
    cookies: { get: () => undefined },
  }) as unknown as NextRequest;
const ctx = { params: Promise.resolve({ id: "f1" }) };
const appel = (body: Record<string, unknown>) =>
  POST(req({ login: "thomas", password: MDP, ...body }), ctx);

/** Le détail que squashnet montrerait après l'envoi de ces lignes. */
const detailDe = (lignes: LigneEnvoi[]) =>
  "<p><span>Saisie le </span><span>16-10-2026 à 10:00</span><span> par PLENAT THOMAS</span></p><table><tbody>" +
  lignes
    .map(
      (l) =>
        `<tr><td data-label="Match">Homme ${l.ordre}</td><td data-label="A">1 - NC - 1 ${l.recevant}</td>` +
        `<td data-label="B">1 - NC - 1 ${l.visiteur}</td><td data-label="Score">${l.jeux.join(" ")}</td></tr>`,
    )
    .join("") +
  "</tbody></table>";

beforeEach(() => {
  h.access = true;
  h.echecs = 0;
  h.tentatives = [];
  h.fixture = {
    teamId: "t1",
    snTieId: "1893481",
    team: { snTeamId: "176168", snRoundId: "383987" },
    official: { checkJson: JSON.stringify(rapport1893481()) },
    matches: [1, 2, 3, 4].map(() => ({ status: "done", updatedAt: new Date("2026-10-15T21:00:00Z") })),
  };
  h.ouvrirSession.mockReset().mockResolvedValue({ cookies: new Map() });
  h.posterAjax.mockReset().mockImplementation(async (_s: unknown, p: { ic_a: string }) =>
    p.ic_a === "330249" ? FORMULAIRE : "",
  );
  h.posterFormulaire.mockReset().mockResolvedValue("");
  h.officialUpdate.mockReset().mockResolvedValue({});
});

describe("avant squashnet", () => {
  it("403 pour qui n'est pas capitaine de l'équipe", async () => {
    h.access = false;
    expect((await appel({ action: "preview" })).status).toBe(403);
    expect(h.ouvrirSession).not.toHaveBeenCalled();
  });

  it("400 sans identifiants", async () => {
    expect((await POST(req({ action: "preview", login: "thomas" }), ctx)).status).toBe(400);
  });

  it("409 sans rapport de vérification", async () => {
    h.fixture!.official = null;
    const res = await appel({ action: "preview" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Vérifie d'abord la rencontre.");
  });

  it("409 quand le relevé a bougé APRÈS la vérification — on n'envoie pas un rapport périmé", async () => {
    (h.fixture!.matches as { updatedAt: Date }[])[2].updatedAt = new Date("2026-10-16T09:00:00Z");
    const res = await appel({ action: "preview" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/revérifie/);
    expect(h.ouvrirSession).not.toHaveBeenCalled();
  });

  it("409 tant qu'un simple n'est pas terminé", async () => {
    (h.fixture!.matches as { status: string }[])[0].status = "live";
    expect((await appel({ action: "preview" })).status).toBe(409);
  });

  it("429 après trois refus de squashnet, sans même s'y connecter", async () => {
    h.echecs = 3;
    expect((await appel({ action: "preview" })).status).toBe(429);
    expect(h.ouvrirSession).not.toHaveBeenCalled();
  });
});

describe("preview", () => {
  it("montre ce qui partira et son empreinte, sans RIEN envoyer", async () => {
    const res = await appel({ action: "preview" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const data = await res.json();
    expect(data.lignes[0]).toEqual({
      ordre: 1,
      recevant: "PLENAT THOMAS",
      visiteur: "THUILLIER GUILLAUME",
      jeux: ["9-11", "3-11", "9-11"],
    });
    expect(data.seen).toMatch(/^[0-9a-f]{8}$/);
    expect(h.ouvrirSession).toHaveBeenCalledWith("thomas", MDP);
    expect(h.posterFormulaire).not.toHaveBeenCalled();
    // Rien de la requête ne revient au client.
    expect(JSON.stringify(data)).not.toContain(MDP);
  });

  it("dit pourquoi la saisie n'est pas ouverte, d'après la liste squashnet", async () => {
    h.posterAjax.mockImplementation(async (_s: unknown, p: { ic_a: string }) =>
      p.ic_a === "330241" ? RENCONTRES.replace("tie-state-100", "tie-state-101").replace(/data-ic_a="330249"[^>]*>/, ">") : "<div>rien</div>",
    );
    const res = await appel({ action: "preview" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/déjà saisie sur squashnet/);
  });

  it("transmet les refus de construction, un par ligne", async () => {
    const rap = rapport1893481();
    rap.players[1] = { ...rap.players[1], fedName: "INCONNU JEAN" };
    h.fixture!.official = { checkJson: JSON.stringify(rap) };
    const res = await appel({ action: "preview" });
    expect(res.status).toBe(409);
    expect((await res.json()).problemes).toEqual([
      "Simple n° 1 : INCONNU JEAN ne figure pas parmi les joueurs de Verrieres 3 (VERR3) sur squashnet.",
    ]);
  });
});

describe("send", () => {
  beforeEach(() => vi.stubEnv("VERCEL_ENV", "production"));
  afterEach(() => vi.unstubAllEnvs());

  async function apercu() {
    return (await (await appel({ action: "preview" })).json()) as { lignes: LigneEnvoi[]; seen: string };
  }

  it("⚠️ n'envoie RIEN hors production — squashnet, lui, est toujours le vrai", async () => {
    const { seen } = await apercu();
    vi.stubEnv("VERCEL_ENV", "preview");
    const res = await appel({ action: "send", seen });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/seul l'aperçu est possible/);
    expect(h.posterFormulaire).not.toHaveBeenCalled();
  });

  it("REFUSE d'envoyer autre chose que ce qui a été montré", async () => {
    const res = await appel({ action: "send", seen: "00000000" });
    expect(res.status).toBe(409);
    expect(h.posterFormulaire).not.toHaveBeenCalled();
  });

  it("envoie, relit le détail, et confirme quand squashnet affiche ce qui est parti", async () => {
    const { lignes, seen } = await apercu();
    h.posterAjax.mockImplementation(async (_s: unknown, p: { ic_a: string }) =>
      p.ic_a === "330249" ? FORMULAIRE : p.ic_a === "330253" ? detailDe(lignes) : "",
    );
    const res = await appel({ action: "send", seen });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ ok: true, lignes, saisiePar: "PLENAT THOMAS", sentAt: expect.any(String) });
    // La date d'envoi est gardée, pour que rouvrir la rencontre dise « envoyé le… ».
    expect(h.officialUpdate).toHaveBeenCalledWith({
      where: { interclubId: "f1" },
      data: { sentAt: new Date(data.sentAt) },
    });
    const champs = h.posterFormulaire.mock.calls[0][1] as Record<string, string>;
    expect(champs).toMatchObject({ ic_a: "330250", tieid: "1893481", h1_2509582: "648361", scv1_2509582: "11" });
  });

  it("502 et les écarts quand le détail squashnet ne montre pas ce qui est parti", async () => {
    const { lignes, seen } = await apercu();
    h.posterAjax.mockImplementation(async (_s: unknown, p: { ic_a: string }) =>
      p.ic_a === "330249" ? FORMULAIRE : p.ic_a === "330253" ? detailDe(lignes.slice(1)) : "",
    );
    h.posterFormulaire.mockResolvedValue("<div class='invalid-feedback'>Joueur trop fort</div>");
    const res = await appel({ action: "send", seen });
    expect(res.status).toBe(502);
    const data = await res.json();
    expect(data.problemes).toEqual(["Simple n° 1 : absent du détail squashnet."]);
    expect(data.reponse).toBe("Joueur trop fort");
    // Ce que squashnet n'affiche pas n'est pas « envoyé ».
    expect(h.officialUpdate).not.toHaveBeenCalled();
  });

  it("une trace d'envoi impossible à écrire ne fait pas croire à un échec", async () => {
    const { lignes, seen } = await apercu();
    h.posterAjax.mockImplementation(async (_s: unknown, p: { ic_a: string }) =>
      p.ic_a === "330249" ? FORMULAIRE : p.ic_a === "330253" ? detailDe(lignes) : "",
    );
    h.officialUpdate.mockRejectedValue(new Error("Neon injoignable"));
    const res = await appel({ action: "send", seen });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});

describe("refus de squashnet", () => {
  it("compte l'échec sous des clés préfixées, et répond 403 — jamais 401", async () => {
    h.posterAjax.mockRejectedValue(new AccesRefuse());
    const res = await appel({ action: "preview" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/identifiant ou mot de passe incorrect/);
    expect(h.tentatives).toEqual([{ data: { ip: "squashnet:local", identifier: "squashnet:u1" } }]);
  });

  it("une panne réseau ne cite rien de la requête", async () => {
    h.ouvrirSession.mockRejectedValue(new Error(`fetch failed for thomas:${MDP}`));
    const res = await appel({ action: "preview" });
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain(MDP);
  });
});
