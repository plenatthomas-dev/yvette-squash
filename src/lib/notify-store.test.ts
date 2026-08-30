import { describe, it, expect, beforeEach, vi } from "vitest";

// LE JOURNAL DE LA CLOCHE, QUI N'AVAIT JAMAIS ÉTÉ EXÉCUTÉ.
//
// `recordNotifications` est mocké dans TOUS les tests qui le croisent (`push.test.ts`,
// `push-config.test.ts`) : ils vérifient que le transport l'appelle, jamais ce qu'il fait. Or
// c'est le REPLI du push — ce qui reste consultable quand la notification système n'arrive pas
// (permission refusée, iPhone hors écran d'accueil, appareil éteint). Un journal qui n'écrit
// pas ne se voit nulle part : il ne casse rien, il manque.
//
// Ce fichier mesure ce qui se décide dans le code ; ce que la clause `WHERE` supprime vraiment
// se mesure sur une vraie base, dans `notify-store.pg.test.ts`.

const h = vi.hoisted(() => ({
  createMany: vi.fn(async (_a: unknown) => ({ count: 0 })),
  deleteMany: vi.fn(async (_a: unknown) => ({ count: 0 })),
}));

vi.mock("./db", () => ({
  prisma: { appNotification: { createMany: h.createMany, deleteMany: h.deleteMany } },
}));

import { recordNotifications } from "./notify-store";
import { NOTIFICATION_RETENTION_DAYS } from "./notifications-shared";

/** Les lignes passées au `createMany` du dernier appel. */
function ecrites() {
  const arg = h.createMany.mock.calls.at(-1)?.[0] as { data: Record<string, unknown>[] };
  return arg.data;
}

beforeEach(() => {
  h.createMany.mockClear();
  h.deleteMany.mockClear();
});

const notif = { title: "Rencontre terminée", body: "Équipe 1 3 – 1 Massy" };

describe("recordNotifications", () => {
  it("écrit une ligne par membre, EN UNE SEULE requête", async () => {
    // Une écriture par destinataire multiplierait par le nombre d'abonnés le coût d'une
    // notification, sur le chemin chaud d'une soirée.
    await recordNotifications(["u1", "u2", "u3"], notif);
    expect(h.createMany).toHaveBeenCalledTimes(1);
    expect(ecrites().map((l) => l.userId)).toEqual(["u1", "u2", "u3"]);
  });

  it("dédoublonne les destinataires", async () => {
    // Un membre peut être visé deux fois par le même envoi (abonné à l'équipe ET joueur du
    // match). Deux lignes identiques dans la cloche se lisent comme deux événements.
    await recordNotifications(["u1", "u2", "u1", "u1"], notif);
    expect(ecrites().map((l) => l.userId)).toEqual(["u1", "u2"]);
  });

  it("ne touche PAS la base quand la liste est vide", async () => {
    // Une notification sans destinataire est un cas courant : personne n'est abonné à ce
    // niveau. Elle ne doit pas coûter une requête, encore moins une purge.
    await recordNotifications([], notif);
    expect(h.createMany).not.toHaveBeenCalled();
    expect(h.deleteMany).not.toHaveBeenCalled();
  });

  it("tronque le titre à 120 et le corps à 500", async () => {
    await recordNotifications(["u1"], { title: "T".repeat(200), body: "B".repeat(700) });
    const [ligne] = ecrites();
    expect((ligne.title as string).length).toBe(120);
    expect((ligne.body as string).length).toBe(500);
  });

  it("écrit `null`, et non `undefined`, pour une url ou un tag absents", async () => {
    // Prisma traite `undefined` comme « ne pas écrire cette colonne » : sur un `createMany`,
    // la nuance est sans effet ici, mais elle ne l'est pas partout, et la ligne doit dire
    // explicitement qu'il n'y a pas d'url.
    await recordNotifications(["u1"], notif);
    const [ligne] = ecrites();
    expect(ligne.url).toBeNull();
    expect(ligne.tag).toBeNull();
  });

  it("purge au-delà de 30 jours, et SEULEMENT les membres qu'on vient d'écrire", async () => {
    const avant = Date.now();
    await recordNotifications(["u1", "u2"], notif);
    const apres = Date.now();

    const where = (h.deleteMany.mock.calls.at(-1)?.[0] as { where: Record<string, never> }).where;
    expect(where).toMatchObject({ userId: { in: ["u1", "u2"] } });

    // La borne est calculée à l'appel : on l'encadre plutôt que de la comparer à une date
    // figée, qui ferait un test dépendant de l'horloge.
    const cutoff = (where as unknown as { createdAt: { lt: Date } }).createdAt.lt;
    const jours = NOTIFICATION_RETENTION_DAYS * 86_400_000;
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(avant - jours);
    expect(cutoff.getTime()).toBeLessThanOrEqual(apres - jours);
  });

  it("NE JETTE JAMAIS : le journal ne doit pas faire échouer l'envoi qui l'a déclenché", async () => {
    // C'est la promesse qui compte le plus, et la plus facile à casser sans s'en apercevoir :
    // ce module est appelé depuis le transport, lui-même appelé depuis la saisie d'un score.
    // Une exception ici ferait échouer un point marqué au bord du terrain.
    h.createMany.mockRejectedValueOnce(new Error("base injoignable"));
    await expect(recordNotifications(["u1"], notif)).resolves.toBeUndefined();

    h.deleteMany.mockRejectedValueOnce(new Error("purge impossible"));
    await expect(recordNotifications(["u1"], notif)).resolves.toBeUndefined();
  });
});
