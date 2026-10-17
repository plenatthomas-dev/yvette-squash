import { describe, it, expect, beforeEach, vi } from "vitest";
import type { NextRequest } from "next/server";
import { ResaRefreshTransientError } from "@/lib/resamania/errors";

// CRON KEEP-ALIVE DES DÉLÉGATIONS — une panne ResaMania n'est pas une délégation cassée.
//
// Depuis f44b690, `getResaTokenForUser` LÈVE sur une panne passagère (au lieu de supprimer la
// session et rendre null). Deux régressions à verrouiller :
//  - l'exception interrompait toute la boucle : les délégants suivants n'étaient plus
//    rafraîchis, alors que ce rafraîchissement est la raison d'être du cron ;
//  - et il ne faut SURTOUT PAS la traiter comme un `null` : la notification « ta délégation ne
//    fonctionne plus, reconnecte-toi » sur une simple panne était le faux positif d'avant.

const h = vi.hoisted(() => ({
  delegators: [] as Array<{ delegatorId: string }>,
  tokenFor: vi.fn(),
  pushToUser: vi.fn(),
  recordCronRun: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    delegation: {
      // 1er appel : délégants actifs ; 2e appel : délégations expirées à notifier (aucune ici).
      findMany: vi.fn(async (args: { distinct?: unknown }) => (args.distinct ? h.delegators : [])),
      update: vi.fn(),
    },
  },
}));
vi.mock("@/lib/session", () => ({ getResaTokenForUser: h.tokenFor }));
vi.mock("@/lib/cron-auth", () => ({ cronAuthorized: () => true }));
vi.mock("@/lib/cron-run", () => ({ recordCronRun: h.recordCronRun }));
vi.mock("@/lib/push", () => ({ pushToUser: h.pushToUser }));

import { GET } from "./route";

const req = () => ({}) as NextRequest;

beforeEach(() => {
  h.delegators = [{ delegatorId: "d-panne" }, { delegatorId: "d-ok" }, { delegatorId: "d-mort" }];
  // Rejet construit À L'APPEL (et non `mockRejectedValue`), comme ailleurs dans le dépôt.
  h.tokenFor.mockReset().mockImplementation((id: string) => {
    if (id === "d-panne") return Promise.reject(new ResaRefreshTransientError("ResaMania indisponible"));
    if (id === "d-mort") return Promise.resolve(null); // jeton vraiment irrécupérable
    return Promise.resolve({ accessToken: "frais" });
  });
  h.pushToUser.mockReset().mockResolvedValue(1);
  h.recordCronRun.mockReset();
});

describe("GET /api/cron/keep-alive-delegations — panne passagère", () => {
  it("saute le délégant en panne SANS le notifier, continue la boucle, compte « reporté »", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await GET(req());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      delegators: 3,
      refreshed: 1,
      failed: 1,
      reportes: 1,
      ended: 0,
    });
    // Les trois délégants ont été visités : la panne du premier n'a pas arrêté la boucle.
    expect(h.tokenFor).toHaveBeenCalledTimes(3);
    // Seul le délégant au jeton VRAIMENT mort est prévenu ; jamais celui en panne passagère.
    const notifies = h.pushToUser.mock.calls.map((c) => c[0]);
    expect(notifies).toEqual(["d-mort"]);
    expect(h.recordCronRun).toHaveBeenCalledWith(
      "keep-alive-delegations",
      true,
      "1 ok, 1 KO, 1 reporté(s), 0 finie(s)",
    );
  });

  it("erreur non passagère (base…) : pas de notification non plus, boucle poursuivie", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.tokenFor.mockImplementation((id: string) =>
      id === "d-panne"
        ? Promise.reject(new Error("Can't reach database server"))
        : Promise.resolve({ accessToken: "frais" }),
    );

    const res = await GET(req());

    expect(await res.json()).toMatchObject({ refreshed: 2, failed: 0, reportes: 1 });
    expect(h.pushToUser).not.toHaveBeenCalled();
  });
});
