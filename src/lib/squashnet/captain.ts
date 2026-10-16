import { TR, attr, cellules, dateIso, texte, valeur } from "./html";
import { nameKey } from "./roster";
import type { CheckReport } from "../captain-check";

// ============================================================================
//  LA SAISIE DU SCORE CHEZ LA FÉDÉRATION — l'espace capitaine de squashnet.
//
//  Ce module LIT le formulaire de saisie d'une rencontre et CONSTRUIT ce qu'on
//  y enverrait. Il n'envoie rien : le réseau et la session vivent dans
//  `session.ts`, la décision dans la route. PUR, et testé sur des captures
//  réelles (`__fixtures__/capitaine-2027-*`).
//
//  CE QU'ON ENVOIE, C'EST LE RAPPORT DE VÉRIFICATION, et rien d'autre. Le
//  capitaine a relu ce rapport à l'écran — noms fédéraux, jeux point par point.
//  Recalculer l'envoi depuis les simples en base ferait partir chez la ligue
//  autre chose que ce qu'il a validé des yeux.
//
//  ⚠️ CE QUI ENGAGE LE CAPITAINE NE SE DEVINE PAS. Chaque doute — un joueur
//  qu'aucune option ne désigne, deux options qui le désignent, un nombre de
//  simples qui diffère — est un REFUS, nommé, et rien n'est envoyé. La saisie
//  à la main reste toujours possible ; une feuille fausse chez la ligue, elle,
//  se corrige en appelant le capitaine adverse.
//
//  LES CODES D'ACTION (relevés le 16/10/2026, il n'existe pas d'API) :
//    330241 + teamid + roundid  la liste des rencontres du capitaine ;
//    330249 + tieid             le formulaire de saisie ;
//    330250                     son envoi (porté par le formulaire lui-même) ;
//    330253 + tieid             le détail d'une rencontre saisie.
// ============================================================================

export const ACTION_RENCONTRES = "330241";
export const ACTION_FORMULAIRE = "330249";
export const ACTION_DETAIL = "330253";

/**
 * Le formulaire ne se lit plus. Même doctrine que `TieUnreadableError` : un rendu qu'on ne sait
 * plus lire est une PANNE, et on la dit — envoyer quand même, c'est envoyer à l'aveugle.
 */
export class FormulaireIlisible extends Error {
  constructor(raison: string) {
    super("formulaire de saisie squashnet illisible : " + raison);
    this.name = "FormulaireIlisible";
  }
}

/** Une option d'une liste de joueurs du formulaire. */
export interface OptionJoueur {
  /** Identifiant squashnet du joueur — ce que le formulaire envoie. Ni licence, ni rang. */
  id: string;
  /** « PLENAT THOMAS », sans le préfixe « rangM - clt - rang - ». */
  nom: string;
  /** Les deux pseudo-joueurs « ---WO--- » (forfait) : jamais choisis par rapprochement. */
  wo: boolean;
}

/** Une des deux listes de joueurs d'un simple. */
export interface ColonneSimple {
  /** Le nom du champ : `h1_<mid>` (recevant) ou `v1_<mid>` (visiteur). */
  champ: string;
  /** Ce que squashnet a présélectionné — la composition déclarée. */
  choisi: string | null;
  options: OptionJoueur[];
}

/** Un simple du formulaire. */
export interface SimpleSaisie {
  /** Identifiant squashnet du simple (« 2509582 »), suffixe de tous ses champs. */
  mid: string;
  /** « Homme 1 ». */
  libelle: string;
  /** 1..n, lu dans le libellé : c'est lui qui rapproche le simple du nôtre. */
  ordre: number;
  recevant: ColonneSimple;
  visiteur: ColonneSimple;
  /** Les paires de champs de points, jeu par jeu : `[sch1_<mid>, scv1_<mid>]`… */
  jeux: [string, string][];
}

export interface EquipeSaisie {
  /** « Squash de l'Yvette 2 (YVETTE2) ». */
  nom: string;
  /** Le `teamid` squashnet, porté par la case « Forfait » de l'équipe. */
  teamId: string | null;
}

export interface FormulaireSaisie {
  /** Les champs cachés, `ic_csrf` exclu : le jeton appartient à la session, pas au formulaire. */
  caches: Record<string, string>;
  recevant: EquipeSaisie;
  visiteur: EquipeSaisie;
  simples: SimpleSaisie[];
}

// --- Lecture du formulaire --------------------------------------------------

const BALISE_INPUT = /<input\b[^>]*>/gi;
const SELECT = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
const OPTION = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;

/**
 * Le nom d'une option. Le libellé fédéral est « 2384 - 4D - 2251 - PLENAT THOMAS » : rang mixte,
 * classement, rang, puis le nom. Un nom composé garde son trait d'union sans espaces
 * (« GIRARD PIERRE-MARIE »), d'où la coupe sur « - » ENTOURÉ d'espaces, après le troisième.
 */
export function nomOption(libelle: string): string {
  const morceaux = libelle.split(" - ");
  return (morceaux.length >= 4 ? morceaux.slice(3).join(" - ") : libelle).trim();
}

function colonne(selectAttrs: string, selectHtml: string): ColonneSimple {
  const champ = attr(selectAttrs, "name") ?? "";
  const options: OptionJoueur[] = [];
  let choisi: string | null = null;
  OPTION.lastIndex = 0;
  let o: RegExpExecArray | null;
  while ((o = OPTION.exec(selectHtml)) !== null) {
    const id = attr(o[1], "value");
    if (!id) continue;
    const nom = nomOption(texte(o[2]));
    options.push({ id, nom, wo: /---WO---/.test(nom) });
    if (/\sselected\b/i.test(o[1])) choisi = id;
  }
  return { champ, choisi, options };
}

/** Lit le formulaire « Saisir les résultats » (`ic_a=330249`). Jette `FormulaireIlisible`. */
export function parseFormulaireSaisie(html: string): FormulaireSaisie {
  const form = /<form\b[^>]*\bid=["']frmResults["'][^>]*>([\s\S]*?)<\/form>/i.exec(html);
  if (!form) throw new FormulaireIlisible("pas de formulaire de saisie dans la réponse");
  const corps = form[1];

  const caches: Record<string, string> = {};
  const forfaits: (string | null)[] = [];
  for (const balise of corps.match(BALISE_INPUT) ?? []) {
    const nom = attr(balise, "name");
    if (!nom) continue;
    if ((attr(balise, "type") ?? "").toLowerCase() === "hidden" && nom !== "ic_csrf") {
      caches[nom] = attr(balise, "value") ?? "";
    }
    // Les DEUX cases « Forfait » s'appellent `woh` — seule `data-teamid` dit de quelle équipe.
    if (nom === "woh") forfaits.push(attr(balise, "data-teamid"));
  }
  if (!caches.ic_a || !caches.tieid) throw new FormulaireIlisible("champs cachés absents");

  const noms = [...corps.matchAll(/<h4[^>]*>([\s\S]*?)<\/h4>/gi)].map((m) => texte(m[1]));
  if (noms.length < 2 || forfaits.length < 2) {
    throw new FormulaireIlisible("les deux équipes ne sont pas identifiables");
  }

  const simples: SimpleSaisie[] = [];
  TR.lastIndex = 0;
  let tr: RegExpExecArray | null;
  while ((tr = TR.exec(corps)) !== null) {
    const ligne = tr[1];
    const selects = [...ligne.matchAll(SELECT)];
    if (selects.length === 0) continue;
    const libelle = texte(/<td[^>]*>([\s\S]*?)<\/td>/i.exec(ligne)?.[1] ?? "");
    const ordre = Number(/(\d+)\s*$/.exec(libelle)?.[1] ?? NaN);
    const h = selects.find((s) => /^h1_\d+$/.test(attr(s[1], "name") ?? ""));
    const v = selects.find((s) => /^v1_\d+$/.test(attr(s[1], "name") ?? ""));
    if (!h || !v || !Number.isInteger(ordre)) {
      throw new FormulaireIlisible(`ligne « ${libelle} » sans ses deux listes de joueurs`);
    }
    const recevant = colonne(h[1], h[2]);
    const visiteur = colonne(v[1], v[2]);
    const mid = recevant.champ.slice(3);
    if (visiteur.champ.slice(3) !== mid) throw new FormulaireIlisible(`simple ${libelle} incohérent`);
    const jeux: [string, string][] = [];
    for (let n = 1; ligne.includes(`name="sch${n}_${mid}"`) || ligne.includes(`name='sch${n}_${mid}'`); n++) {
      jeux.push([`sch${n}_${mid}`, `scv${n}_${mid}`]);
    }
    if (jeux.length < 3) throw new FormulaireIlisible(`simple ${libelle} sans cases de points`);
    simples.push({ mid, libelle, ordre, recevant, visiteur, jeux });
  }
  if (simples.length === 0) throw new FormulaireIlisible("aucun simple dans le formulaire");

  return {
    caches,
    recevant: { nom: noms[0], teamId: forfaits[0] },
    visiteur: { nom: noms[1], teamId: forfaits[1] },
    simples,
  };
}

// --- Construction de l'envoi -----------------------------------------------

/** Un simple tel qu'il sera envoyé — et tel qu'on l'affiche avant d'envoyer. */
export interface LigneEnvoi {
  ordre: number;
  recevant: string;
  visiteur: string;
  /** Les jeux du point de vue du RECEVANT, comme squashnet les affiche : « 11-9 ». */
  jeux: string[];
}

export interface Envoi {
  /** Tout ce qui part, `ic_csrf` excepté (ajouté par la session). */
  champs: Record<string, string>;
  lignes: LigneEnvoi[];
  nousRecevons: boolean;
}

export type Construction = { ok: true; envoi: Envoi } | { ok: false; problemes: string[] };

/**
 * Traduit le rapport vérifié en champs du formulaire.
 *
 * ⚠️ « HOME » DANS LE RAPPORT, C'EST NOUS — pas le recevant. L'appli range toujours notre joueur
 * en `home` (`InterclubMatch.homeDisplayName`), qu'on reçoive ou qu'on se déplace. Le formulaire,
 * lui, met le RECEVANT à gauche (`h1_`, `sch`). Notre colonne se reconnaît donc au `teamid` de
 * l'équipe, jamais à `Interclub.home` : se tromper croiserait les deux équipes et inverserait
 * chaque jeu — un 3-0 gagné partirait en 0-3 perdu.
 */
export function construireEnvoi(
  form: FormulaireSaisie,
  rapport: CheckReport,
  notreTeamId: string,
): Construction {
  const problemes: string[] = [];
  const nousRecevons =
    form.recevant.teamId === notreTeamId
      ? true
      : form.visiteur.teamId === notreTeamId
        ? false
        : null;
  if (nousRecevons === null) {
    return {
      ok: false,
      problemes: [
        `Ce formulaire oppose ${form.recevant.nom} à ${form.visiteur.nom} : aucune des deux n'est notre équipe.`,
      ],
    };
  }
  const notreNom = nousRecevons ? form.recevant.nom : form.visiteur.nom;
  const leurNom = nousRecevons ? form.visiteur.nom : form.recevant.nom;

  if (form.simples.length !== rapport.scores.length) {
    problemes.push(
      `squashnet attend ${form.simples.length} simples, la rencontre en compte ${rapport.scores.length}.`,
    );
  }

  const champs: Record<string, string> = { ...form.caches, msg: "" };
  const lignes: LigneEnvoi[] = [];

  for (const s of [...rapport.scores].sort((a, b) => a.order - b.order)) {
    const simple = form.simples.find((x) => x.ordre === s.order);
    if (!simple) {
      problemes.push(`Simple n° ${s.order} : absent du formulaire squashnet.`);
      continue;
    }
    if (!s.ok) {
      problemes.push(`Simple n° ${s.order} : ${s.problem ?? "score incohérent"}.`);
      continue;
    }
    if (s.games.length > simple.jeux.length) {
      problemes.push(`Simple n° ${s.order} : ${s.games.length} jeux, le formulaire n'en prend que ${simple.jeux.length}.`);
      continue;
    }

    const nôtre = nousRecevons ? simple.recevant : simple.visiteur;
    const leur = nousRecevons ? simple.visiteur : simple.recevant;
    const choix = new Map<ColonneSimple, OptionJoueur>();
    for (const [side, col, equipe] of [
      ["home", nôtre, notreNom],
      ["away", leur, leurNom],
    ] as const) {
      const p = rapport.players.find((x) => x.order === s.order && x.side === side);
      if (!p?.fedName) {
        problemes.push(
          `Simple n° ${s.order} : ${p?.name ?? "un joueur"} n'est pas identifié chez la fédération — règle-le dans la vérification.`,
        );
        continue;
      }
      const cle = nameKey(p.fedName);
      const trouves = col.options.filter((o) => !o.wo && nameKey(o.nom) === cle);
      if (trouves.length !== 1) {
        problemes.push(
          trouves.length === 0
            ? `Simple n° ${s.order} : ${p.fedName} ne figure pas parmi les joueurs de ${equipe} sur squashnet.`
            : `Simple n° ${s.order} : plusieurs joueurs de ${equipe} s'appellent ${p.fedName} sur squashnet.`,
        );
        continue;
      }
      choix.set(col, trouves[0]);
    }
    const r = choix.get(simple.recevant);
    const v = choix.get(simple.visiteur);
    if (!r || !v) continue;

    champs[simple.recevant.champ] = r.id;
    champs[simple.visiteur.champ] = v.id;
    // Les jeux du point de vue du RECEVANT. Les cases au-delà du dernier jeu partent VIDES :
    // c'est ce que le formulaire envoie pour un simple gagné en trois jeux.
    const jeux = s.games.map((g) => (nousRecevons ? [g.home, g.away] : [g.away, g.home]));
    simple.jeux.forEach(([ch, cv], i) => {
      champs[ch] = jeux[i] ? String(jeux[i][0]) : "";
      champs[cv] = jeux[i] ? String(jeux[i][1]) : "";
    });
    lignes.push({ ordre: s.order, recevant: r.nom, visiteur: v.nom, jeux: jeux.map(([a, b]) => `${a}-${b}`) });
  }

  return problemes.length > 0
    ? { ok: false, problemes }
    : { ok: true, envoi: { champs, lignes, nousRecevons } };
}

/**
 * L'empreinte de ce qui partira — le garde « on n'envoie que ce qu'on a montré », comme
 * `calendarFingerprint` pour l'import du calendrier. FNV-1a sur une forme canonique (clés
 * triées) : rien de secret à protéger, seulement une égalité à constater, et le module reste
 * sans dépendance à `node:crypto` — l'écran en importe les types.
 */
export function empreinteEnvoi(champs: Record<string, string>): string {
  const canon = Object.keys(champs)
    .sort()
    .map((k) => `${k}=${champs[k]}`)
    .join("&");
  let h = 0x811c9dc5;
  for (let i = 0; i < canon.length; i++) {
    h ^= canon.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// --- Relecture après envoi ----------------------------------------------------

export interface LigneDetail {
  ordre: number;
  recevant: string;
  visiteur: string;
  jeux: string[];
}

export interface DetailRencontre {
  saisiePar: string | null;
  confirmeePar: string | null;
  lignes: LigneDetail[];
}

const COLONNES_FIXES = new Set(["Match", "Score", "Matchs", "Jeux", "Points"]);

/**
 * Le détail d'une rencontre saisie (`ic_a=330253`).
 *
 * Les deux colonnes de joueurs sont intitulées du NOM DE CHAQUE ÉQUIPE — des données, pas un
 * vocabulaire fixe (même piège que la feuille publique, cf. `tie.ts`). On les reconnaît donc par
 * élimination des colonnes fixes, dans l'ordre de la page : le recevant d'abord, comme dans le
 * formulaire. Le nom d'un joueur y est précédé de « rangM - clt - rang » SANS tiret final.
 */
export function parseDetailRencontre(html: string): DetailRencontre {
  const paragraphes = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => texte(m[1]));
  const par = (mot: string) =>
    paragraphes.map((p) => new RegExp(`^${mot} le .* par (.+)$`).exec(p)?.[1].trim()).find(Boolean) ??
    null;

  const lignes: LigneDetail[] = [];
  TR.lastIndex = 0;
  let tr: RegExpExecArray | null;
  while ((tr = TR.exec(html)) !== null) {
    const cs = cellules(tr[1]);
    if (cs.length === 0) continue;
    const joueurs = cs.filter((c) => !COLONNES_FIXES.has(c.label));
    const ordre = Number(/(\d+)\s*$/.exec(valeur(cs, "Match"))?.[1] ?? NaN);
    if (joueurs.length !== 2 || !Number.isInteger(ordre)) continue;
    const nom = (c: (typeof cs)[number]) => texte(c.html).replace(/^\d+\s*-\s*\S+\s*-\s*\d+\s+/, "");
    lignes.push({
      ordre,
      recevant: nom(joueurs[0]),
      visiteur: nom(joueurs[1]),
      jeux: valeur(cs, "Score").split(/\s+/).filter(Boolean),
    });
  }
  return { saisiePar: par("Saisie"), confirmeePar: par("Confirmée"), lignes };
}

/** Ce que squashnet affiche et qui diffère de ce qu'on a envoyé. Vide = conforme. */
export function ecartsApresEnvoi(envoi: Envoi, detail: DetailRencontre): string[] {
  const ecarts: string[] = [];
  for (const l of envoi.lignes) {
    const d = detail.lignes.find((x) => x.ordre === l.ordre);
    if (!d) {
      ecarts.push(`Simple n° ${l.ordre} : absent du détail squashnet.`);
      continue;
    }
    if (nameKey(d.recevant) !== nameKey(l.recevant) || nameKey(d.visiteur) !== nameKey(l.visiteur)) {
      ecarts.push(
        `Simple n° ${l.ordre} : squashnet affiche ${d.recevant} – ${d.visiteur}, on a envoyé ${l.recevant} – ${l.visiteur}.`,
      );
    }
    if (d.jeux.join(" ") !== l.jeux.join(" ")) {
      ecarts.push(
        `Simple n° ${l.ordre} : squashnet affiche ${d.jeux.join(" ") || "aucun jeu"}, on a envoyé ${l.jeux.join(" ")}.`,
      );
    }
  }
  return ecarts;
}

// --- La liste des rencontres du capitaine -----------------------------------

export type EtatRencontre = "non-jouee" | "saisie" | "validee" | "controlee" | "inconnu";

export interface LigneRencontre {
  tieid: string | null;
  date: string | null;
  adversaire: string;
  etat: EtatRencontre;
  /** L'action « Saisir les résultats » est-elle proposée ? */
  saisieOuverte: boolean;
}

const ETATS: Record<string, EtatRencontre> = {
  "100": "non-jouee",
  "101": "saisie",
  "102": "validee",
  "103": "controlee",
};

/** La liste des rencontres de l'espace capitaine (`ic_a=330241`). */
export function parseRencontresCapitaine(html: string): LigneRencontre[] {
  const out: LigneRencontre[] = [];
  TR.lastIndex = 0;
  let tr: RegExpExecArray | null;
  while ((tr = TR.exec(html)) !== null) {
    const cs = cellules(tr[1]);
    if (cs.length === 0) continue;
    const dateHtml = cs.find((c) => c.label === "Date")?.html ?? "";
    const actions = cs.find((c) => c.label === "Action")?.html ?? "";
    out.push({
      tieid: /data-tieid=["'](\d+)["']/.exec(actions)?.[1] ?? null,
      date: dateIso(texte(dateHtml)),
      adversaire: valeur(cs, "Adversaire"),
      etat: ETATS[/tie-state-(\d+)/.exec(dateHtml)?.[1] ?? ""] ?? "inconnu",
      saisieOuverte: new RegExp(`data-ic_a=["']${ACTION_FORMULAIRE}["']`).test(actions),
    });
  }
  return out;
}

/** Pourquoi squashnet ne propose pas le formulaire de cette rencontre — en clair. */
export function raisonFermeture(ligne: LigneRencontre | undefined): string {
  if (!ligne) return "Cette rencontre n'apparaît pas dans ton espace capitaine squashnet.";
  switch (ligne.etat) {
    case "saisie":
      return "La rencontre est déjà saisie sur squashnet : elle attend la confirmation de l'autre capitaine.";
    case "validee":
    case "controlee":
      return "La rencontre est déjà validée sur squashnet.";
    default:
      return "La saisie n'est pas ouverte : squashnet l'ouvre le jour de la rencontre, pour 5 jours.";
  }
}
