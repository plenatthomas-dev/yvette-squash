import { describe, it, expect, beforeEach, vi } from "vitest";
import type { PlanningDay } from "./resamania/types";

const h = vi.hoisted(() => ({
  bookings: [] as Array<{ id: string; classEventId: string; user: { contactId: string | null } }>,
  users: [] as Array<{ id: string; contactId: string | null }>,
  externalBookings: false,
  findMany: vi.fn(),
  updateMany: vi.fn(),
  deleteMany: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("./db", () => ({
  prisma: {
    booking: { findMany: h.findMany, updateMany: h.updateMany, upsert: h.upsert },
    attendance: { deleteMany: h.deleteMany },
  },
}));
vi.mock("./planning-annotate", () => ({
  loadAnnotationUsers: vi.fn(async () => h.users),
}));
const getFeaturesMock = vi.hoisted(() => vi.fn());
vi.mock("./features-server", () => ({ getFeatures: getFeaturesMock }));

import { reconcilePlanningWithBookings } from "./booking-reconcile";

const slot = (over: Partial<PlanningDay["slots"][number]> = {}) => ({
  id: "/class_events/1",
  courtId: "/studios/1",
  courtName: "Squash 1",
  startsAt: "2026-07-11T18:00:00.000Z",
  endsAt: "2026-07-11T18:45:00.000Z",
  status: "booked" as const,
  bookable: false,
  remaining: 0,
  bookerContactId: "contact-alice",
  ...over,
});

const planning = (slots: ReturnType<typeof slot>[]): PlanningDay => ({
  date: "2026-07-11",
  clubId: "club-1",
  courts: [],
  slots,
});

beforeEach(() => {
  h.bookings = [];
  h.users = [{ id: "alice", contactId: "contact-alice" }];
  h.externalBookings = false;
  h.findMany.mockReset().mockImplementation(async () => h.bookings);
  h.updateMany.mockReset().mockResolvedValue({});
  h.deleteMany.mockReset().mockResolvedValue({});
  h.upsert.mockReset().mockResolvedValue({});
  getFeaturesMock.mockReset().mockImplementation(async () => ({
    externalBookings: h.externalBookings,
  }));
});

describe("reconcilePlanningWithBookings — marquage « annulé ailleurs »", () => {
  it("marque cancelled une résa connue dont le créneau est redevenu libre", async () => {
    h.bookings = [{ id: "b1", classEventId: "/class_events/1", user: { contactId: "contact-alice" } }];
    await reconcilePlanningWithBookings(planning([slot({ bookable: true, status: "free" })]), "2026-07-11");
    expect(h.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["b1"] } },
      data: { status: "cancelled" },
    });
  });

  it("marque cancelled une résa dont le créneau est pris par quelqu'un d'autre", async () => {
    h.bookings = [{ id: "b1", classEventId: "/class_events/1", user: { contactId: "contact-alice" } }];
    await reconcilePlanningWithBookings(
      planning([slot({ bookerContactId: "contact-bob" })]),
      "2026-07-11",
    );
    expect(h.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["b1"] } },
      data: { status: "cancelled" },
    });
  });

  it("ne touche pas une résa toujours cohérente avec le planning", async () => {
    h.bookings = [{ id: "b1", classEventId: "/class_events/1", user: { contactId: "contact-alice" } }];
    await reconcilePlanningWithBookings(planning([slot()]), "2026-07-11");
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it("purge les présences des créneaux redevenus libres", async () => {
    await reconcilePlanningWithBookings(planning([slot({ bookable: true, status: "free" })]), "2026-07-11");
    expect(h.deleteMany).toHaveBeenCalledWith({ where: { classEventId: { in: ["/class_events/1"] } } });
  });
});

describe("reconcilePlanningWithBookings — détection résas ResaMania (flag externalBookings)", () => {
  it("ne crée rien si le flag est désactivé", async () => {
    h.externalBookings = false;
    await reconcilePlanningWithBookings(planning([slot()]), "2026-07-11");
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("crée une ligne source « resamania » pour un membre connu sans résa active", async () => {
    h.externalBookings = true;
    await reconcilePlanningWithBookings(planning([slot()]), "2026-07-11");
    expect(h.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_classEventId: { userId: "alice", classEventId: "/class_events/1" } },
        create: expect.objectContaining({ userId: "alice", source: "resamania", status: "booked" }),
      }),
    );
  });

  it("ne crée rien pour un créneau déjà couvert par une résa active", async () => {
    h.externalBookings = true;
    h.bookings = [{ id: "b1", classEventId: "/class_events/1", user: { contactId: "contact-alice" } }];
    await reconcilePlanningWithBookings(planning([slot()]), "2026-07-11");
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("ne crée rien si le réservataire n'est pas un membre connu", async () => {
    h.externalBookings = true;
    await reconcilePlanningWithBookings(
      planning([slot({ bookerContactId: "contact-inconnu" })]),
      "2026-07-11",
    );
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("ne crée rien pour un créneau libre ou sans booker résolu", async () => {
    h.externalBookings = true;
    await reconcilePlanningWithBookings(
      planning([slot({ bookable: true, status: "free", bookerContactId: null })]),
      "2026-07-11",
    );
    expect(h.upsert).not.toHaveBeenCalled();
  });
});

describe("reconcilePlanningWithBookings — coût sur une base Neon qui dort", () => {
  it("journée entièrement connue ⇒ ne consulte MÊME PAS le flag (aucune requête de plus)", async () => {
    // Cas courant : chaque créneau pris a déjà sa ligne. La détection n'a rien à faire, et
    // ne doit donc rien demander à la base — ni le flag, ni la liste des membres.
    h.externalBookings = true;
    h.bookings = [{ id: "b1", classEventId: "/class_events/1", user: { contactId: "contact-alice" } }];
    await reconcilePlanningWithBookings(planning([slot()]), "2026-07-11");
    expect(getFeaturesMock).not.toHaveBeenCalled();
    expect(h.upsert).not.toHaveBeenCalled();
  });

  it("journée sans créneau pris ⇒ idem, rien n'est consulté", async () => {
    h.externalBookings = true;
    await reconcilePlanningWithBookings(
      planning([slot({ bookable: true, status: "free", bookerContactId: null })]),
      "2026-07-11",
    );
    expect(getFeaturesMock).not.toHaveBeenCalled();
  });

  it("créneau inconnu ⇒ là seulement le flag est lu", async () => {
    h.externalBookings = false;
    await reconcilePlanningWithBookings(planning([slot()]), "2026-07-11");
    expect(getFeaturesMock).toHaveBeenCalledTimes(1);
    expect(h.upsert).not.toHaveBeenCalled(); // flag OFF → on s'arrête là
  });
});
