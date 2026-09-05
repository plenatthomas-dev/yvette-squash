import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, within } from "@testing-library/react";
import Admin from "./page";

// LA STRUCTURE DE LA PAGE /admin, et rien d'autre.
//
// Cette page n'avait aucun test, et elle alignait SEPT cartes identiques dans une seule coulée
// masonry : même encadré, même titre, aucun regroupement. Rien ne distinguait le bouton qui
// ferme l'appli à tout le club de celui qui corrige l'orthographe d'un roster, et sept `<h2>`
// à plat ne disaient rien de leur parenté à qui navigue au lecteur d'écran.
//
// Les cartes se rangent désormais en trois groupes, chacun marqué par un filet dont la couleur
// répond à « qui verra ce réglage ». Ce fichier tient CE contrat — l'appartenance d'un outil à
// son groupe et la hiérarchie des titres —, pas l'apparence : le pixel se vérifie à l'œil dans
// les trois thèmes, un test ne saurait le faire.

const fetchMock = vi.fn();

const h = vi.hoisted(() => ({
  features: { emailLogin: true, ranking: true, interclub: true },
}));

vi.mock("@/components/FeatureProvider", () => ({ useFeatures: () => h.features }));
// Le panneau des fonctions parle au serveur pour son propre compte : on le remplace par sa
// coquille, son contenu n'étant pas le sujet ici. Son TITRE reste, puisque c'est lui qu'on
// cherche dans le groupe.
vi.mock("@/components/FeatureFlagsPanel", () => ({
  default: () => (
    <section>
      <h3 className="adm-carte-titre">Fonctions de l&apos;appli</h3>
    </section>
  ),
}));
vi.mock("@/components/AnnouncementBanner", () => ({ recheckBanner: vi.fn() }));

/** Réponse JSON minimale, façon `fetch`. */
function json(corps: unknown) {
  return { ok: true, status: 200, json: async () => corps } as unknown as Response;
}

const dashboard = {
  members: 142,
  disabledMembers: 2,
  recentLogins: 38,
  activeSessions: 12,
  resaSessions: 4,
  activeAlerts: 0,
  pendingRequests: 1,
  blockedEmails: 3,
  bookingsApp: 20,
  bookingsResa: 5,
  externalDetection: true,
  crons: [],
};

async function souffle() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });
}

/** Monte la page, les cinq requêtes du montage servies par URL. */
async function monte() {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/admin/requests")) return json({ requests: [] });
    if (url.startsWith("/api/banner")) return json({ banner: null });
    if (url.startsWith("/api/admin/block")) return json({ enabled: false, message: "" });
    if (url.startsWith("/api/admin/dashboard")) return json(dashboard);
    if (url.startsWith("/api/admin/interclub-teams"))
      return json({ teams: [], members: [], guests: [] });
    return json({});
  });
  render(<Admin />);
  await souffle();
}

/** Le groupe portant ce nom, comme région nommée par son `<h2>`. */
const groupe = (nom: RegExp) => screen.getByRole("region", { name: nom });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  h.features = { emailLogin: true, ranking: true, interclub: true };
});

describe("/admin — les options sont rangées en groupes", () => {
  it("rend les trois groupes, chacun nommé par sa portée", async () => {
    // Le nom accessible du groupe porte le libellé ET ce que le filet colore : la couleur ne
    // doit jamais rester seule à dire ce qu'un réglage touche.
    await monte();
    expect(groupe(/Accès et fonctions/)).toBeTruthy();
    expect(groupe(/Diffusion/)).toBeTruthy();
    expect(groupe(/Interclub/)).toBeTruthy();
    expect(groupe(/Accès et fonctions/).textContent).toContain("tout de suite");
    expect(groupe(/Diffusion/).textContent).toContain("ne se reprend pas");
  });

  it("met chaque outil dans le groupe qui dit sa portée", async () => {
    // LE CAS QUI TOMBE si l'on déplace une carte par mégarde. Le classement n'est pas
    // esthétique : « Blocage » et « Fonctions » retirent quelque chose à tout le monde, les
    // deux blocs de Diffusion partent vers les membres sans retour possible.
    await monte();

    const acces = within(groupe(/Accès et fonctions/));
    expect(acces.getByRole("heading", { name: /Blocage de l'appli/ })).toBeTruthy();
    expect(acces.getByRole("heading", { name: /Fonctions de l'appli/ })).toBeTruthy();

    const diffusion = within(groupe(/Diffusion/));
    expect(diffusion.getByRole("heading", { name: /Annonce à tous les membres/ })).toBeTruthy();
    expect(diffusion.getByRole("heading", { name: /Bannière d'annonce/ })).toBeTruthy();

    const inter = within(groupe(/Interclub/));
    expect(inter.getByRole("heading", { name: /Équipes interclub/ })).toBeTruthy();
    expect(inter.getByRole("heading", { name: /Classement squashnet/ })).toBeTruthy();
  });

  it("descend les titres d'outils en h3, sous le h2 de leur groupe", async () => {
    // La hiérarchie est le vrai correctif : sept `<h2>` à plat ne disaient rien de leur
    // parenté. Les `<h2>` restants sont les trois groupes plus les deux blocs hors groupe
    // (tableau de bord, demandes), qui ne sont pas des réglages.
    await monte();
    const h2 = screen.getAllByRole("heading", { level: 2 }).map((e) => e.textContent ?? "");
    expect(h2.filter((t) => /Tableau de bord|Demandes en attente/.test(t))).toHaveLength(2);
    expect(h2.filter((t) => /Accès et fonctions|Diffusion|Interclub/.test(t))).toHaveLength(3);
    expect(h2).toHaveLength(5);

    const h3 = screen.getAllByRole("heading", { level: 3 }).map((e) => e.textContent ?? "");
    expect(h3).toContain("Blocage de l'appli");
    expect(h3).toContain("Bannière d'annonce");
  });

  it("n'affiche pas un groupe entier quand sa fonction est coupée", async () => {
    // `interclub` et `ranking` gouvernent les deux cartes du groupe Interclub. Le groupe se
    // vide alors — un en-tête coloré au-dessus du vide serait pire que rien.
    h.features = { emailLogin: true, ranking: false, interclub: false };
    await monte();
    expect(screen.queryByRole("heading", { name: /Équipes interclub/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: /Classement squashnet/ })).toBeNull();
  });

  it("garde le panneau des fonctions quand la connexion email est coupée", async () => {
    // LE GARDE-FOU DE LA PAGE, documenté en commentaire et éprouvé nulle part jusqu'ici : sans
    // lui, couper « email seul » verrouillerait l'admin hors du seul écran permettant de le
    // rallumer. Le repli n'a ni groupe ni filet — il n'y a plus qu'une chose à faire.
    h.features = { emailLogin: false, ranking: true, interclub: true };
    await monte();
    expect(screen.getByRole("heading", { name: /Fonctions de l'appli/ })).toBeTruthy();
    expect(screen.queryByRole("region", { name: /Diffusion/ })).toBeNull();
  });

  it("laisse les liens vers les autres pages hors des groupes", async () => {
    // Ce ne sont pas des options : leur donner une carte et un filet ferait croire qu'on
    // règle quelque chose en cliquant.
    await monte();
    const nav = screen.getByRole("navigation", { name: /Autres pages/ });
    expect(within(nav).getByRole("link", { name: /Gérer les membres/ })).toBeTruthy();
    expect(within(nav).getByRole("link", { name: /Tricounts/ })).toBeTruthy();
  });
});
