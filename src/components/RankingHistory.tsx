"use client";

import { useEffect, useMemo, useState } from "react";
import { Dialog } from "@/components/Dialog";
import { readOk } from "@/lib/apiFetch";
import {
  bandesClassement,
  bornesAvecMarches,
  bornesValeurs,
  chemin,
  couleurDe,
  dernierPoint,
  frontieresClassement,
  moisDansPlage,
  moisLabel,
  ordonnee,
  abscisse,
  progression,
  valeurs,
  type Cadre,
  type HistorySeries,
} from "@/lib/ranking-history";

// ============================================================================
//  LA COURBE DE PROGRESSION — le classement fédéral dans le temps.
//
//  Ce que ça répond, et que rien ne répondait : « est-ce que je progresse ? »,
//  et sa version qui intéresse vraiment un club, « est-ce que je progresse
//  PLUS VITE que lui ? ». L'annuaire donne une photo ; celui-ci donne le film,
//  et met deux films côte à côte.
//
//  TROIS PARTIS PRIS D'ÉCRAN :
//
//   1. RIEN N'EST TRACÉ TANT QUE PERSONNE N'EST CHOISI. Douze courbes par
//      défaut seraient un plat de spaghettis dont on ne tire rien. On ouvre
//      sur soi — le joueur qui regarde — et on ajoute qui l'on veut comparer.
//   2. LES CHIFFRES SONT DANS LA LÉGENDE, PAS SEULEMENT DANS LE DESSIN. Un
//      graphique au doigt, sur un téléphone, ne se survole pas : la dernière
//      valeur et l'évolution sont écrites en toutes lettres sous chaque nom.
//      C'est aussi ce qui rend l'écran lisible sans voir la courbe.
//   3. UN TROU RESTE UN TROU. Un mois non mesuré coupe le trait au lieu d'être
//      enjambé (cf. `chemin`) : la fédération ne publie pas tout le monde tous
//      les mois, et relier par-dessus l'absence inventerait une progression.
//   4. LA COURBE SE LIT SUR UNE RÈGLE GRADUÉE. Derrière les points passent les
//      lignes de passage d'un classement à l'autre (« 5B », « 5A »…), déduites
//      de nos propres mesures (cf. `frontieresClassement`). Sans elles, « 1 800e »
//      ne veut rien dire pour personne ; avec elles, on voit d'un coup d'œil de
//      quel côté de la marche on se trouve, et ce qu'il reste à faire.
//   5. LES ZONES SONT TEINTÉES, EN UNE SEULE COULEUR QUI FONCE. Les classements
//      forment une échelle ; une teinte par échelon (bleu pour 5B, orange pour
//      5A) obligerait à apprendre une légende au lieu de LIRE la pente. Une seule
//      teinte, du plus clair en bas au plus soutenu en haut, se lit sans rien
//      apprendre — et reste derrière les courbes, qui sont la donnée.
//
//  TOUT LE FILTRAGE EST LOCAL. La charge utile est servie d'un coup (cf. la
//  route) : cocher un joueur ou tirer la plage de mois ne redemande rien, et
//  reste donc instantané — ce sont les deux gestes qu'on refait dix fois.
// ============================================================================

type Payload = { months: string[]; series: HistorySeries[] };

/** Le cadre du tracé, en unités de viewBox. La marge gauche loge les valeurs de l'axe. */
const CADRE: Cadre = { w: 320, h: 170, padL: 38, padR: 8, padT: 10, padB: 22 };

/** Combien d'étiquettes de mois au maximum sous l'axe : au-delà, elles se chevauchent. */
const MAX_ETIQUETTES = 5;

/** Combien de joueurs pré-cochés quand on ne reconnaît pas celui qui regarde. */
const DEFAUT_SANS_MOI = 3;

/**
 * Une valeur d'axe, telle qu'on l'écrit.
 *
 * ⚠️ ARRONDI DES DEUX CÔTÉS. Seule la moyenne l'était, et le rang sortait brut : or les
 * graduations valent `min + (max−min)·t` avec `t = 0,5`, donc une plage impaire donnait
 * « #2050.5 » — un rang national n'est pas fractionnaire, et le point décimal anglo-saxon
 * détonnait en plus au milieu d'un écran qui écrit « 3 832 ».
 *
 * Le rang reste SANS séparateur de milliers, contrairement à la moyenne : « #1800 » est un
 * repère qu'on lit comme un identifiant, « 3 832 » une quantité qu'on compare.
 */
const nombre = (v: number) => `#${Math.round(v)}`;

/**
 * « +128 » / « −40 » / « ±0 ». Le signe dit toujours le PROGRÈS (cf. `progression`).
 *
 * Le cas nul a son écriture à lui : un joueur mesuré deux fois à l'identique affichait « −0 »,
 * qui se lit comme une baisse et n'en est pas une.
 */
const evolution = (v: number) => {
  const n = Math.round(v);
  if (n === 0) return "±0";
  return `${n > 0 ? "+" : "−"}${Math.abs(n).toLocaleString("fr-FR")}`;
};

export function RankingHistory({
  open,
  onClose,
  meName,
}: {
  open: boolean;
  onClose: () => void;
  /** Nom affiché du joueur connecté, pour ouvrir sur SA courbe. */
  meName?: string;
}) {
  const [data, setData] = useState<Payload | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [choisis, setChoisis] = useState<string[]>([]);
  const [depuis, setDepuis] = useState("");
  const [jusqua, setJusqua] = useState("");
  const [q, setQ] = useState("");

  useEffect(() => {
    if (!open) return;
    let annule = false;
    setData(null);
    setErreur(null);
    (async () => {
      try {
        const res = await fetch("/api/rankings/history", { cache: "no-store" });
        const payload = await readOk<Payload>(res);
        if (annule) return;
        setData(payload);
        setDepuis(payload.months[0] ?? "");
        setJusqua(payload.months[payload.months.length - 1] ?? "");
        // Ouvrir sur SOI. À défaut (pseudo différent du nom fédéral, joueur non licencié), sur
        // les joueurs les mieux mesurés : un écran qui s'ouvre vide n'apprend à personne ce
        // qu'il sait faire.
        const moi = meName
          ? payload.series.find((s) => s.name.toLowerCase() === meName.trim().toLowerCase())
          : undefined;
        setChoisis(
          moi
            ? [moi.id]
            : [...payload.series]
                .sort((a, b) => b.points.length - a.points.length)
                .slice(0, DEFAUT_SANS_MOI)
                .map((s) => s.id),
        );
      } catch (e) {
        if (!annule) {
          setData({ months: [], series: [] });
          setErreur((e as Error).message);
        }
      }
    })();
    return () => {
      annule = true;
    };
  }, [open, meName]);

  const months = useMemo(
    () => moisDansPlage(data?.months ?? [], depuis, jusqua),
    [data, depuis, jusqua],
  );
  // Les séries TRACÉES, dans l'ordre où le joueur les a cochées : c'est cet ordre qui fixe la
  // couleur, et une couleur qui change parce qu'on a décoché un voisin rendrait la légende
  // inutilisable au troisième clic.
  const tracees = useMemo(
    () => choisis.flatMap((id) => (data?.series ?? []).filter((s) => s.id === id)),
    [choisis, data],
  );
  // L'échelle BRUTE : le min et le max des courbes affichées. Élargie juste après, et seulement
  // si une marche de classement attend à portée (cf. `bornesAvecMarches`).
  const brutes = useMemo(
    () => bornesValeurs(tracees, months),
    [tracees, months],
  );

  // LES MARCHES DU CLASSEMENT, sur TOUT le corpus reçu — pas sur `tracees`, ni sur `months`.
  // Une frontière est une propriété de l'échelle fédérale, pas de qui l'on regarde : la calculer
  // sur la sélection la ferait bouger à chaque case cochée, et le repère cesserait d'en être un.
  // On la déduit donc du plus grand nombre d'observations disponibles, et une seule fois.
  const frontieres = useMemo(
    () => frontieresClassement(data?.series ?? []),
    [data],
  );

  // L'échelle effective, une fois faite la place à une marche proche. Tout le reste du dessin
  // (courbes, points, graduations) s'appuie dessus, sans quoi les repères et les courbes ne
  // parleraient pas de la même échelle.
  const bornes = useMemo(
    () => (brutes === null ? null : bornesAvecMarches(brutes, frontieres)),
    [brutes, frontieres],
  );

  // Celles qui tombent DANS la fenêtre visible, converties en ordonnées. Une ligne hors bornes
  // serait tracée sur le bord du cadre, où elle se lirait comme une frontière atteinte.
  // Les ZONES à peindre : « je suis dans quoi, là ? », répondu par le fond plutôt que par une
  // étiquette à lire. Dérivées des mêmes frontières, sur la même échelle.
  const bandes = useMemo(
    () => (bornes === null ? [] : bandesClassement(frontieres, bornes)),
    [frontieres, bornes],
  );

  const marches = useMemo(
    () =>
      bornes === null
        ? []
        : frontieres
            .filter((f) => f.valeur >= bornes.min && f.valeur <= bornes.max)
            .map((f) => ({ ...f, y: ordonnee(f.valeur, bornes, CADRE) })),
    [frontieres, bornes],
  );

  const aiguille = q.trim().toLowerCase();
  const listables = (data?.series ?? []).filter((s) => s.name.toLowerCase().includes(aiguille));

  // UNE COURBE À UN POINT N'EST PAS UNE COURBE, et l'écran doit le dire lui-même.
  //
  // Quand l'historique n'a jamais été rempli en arrière — ou qu'il l'a été avant que ces
  // joueurs-là n'existent —, chacun ne porte que la mesure du mois courant, écrite par la passe
  // mensuelle. L'écran affiche alors des points isolés, sans rien qui explique pourquoi : la
  // question « pourquoi n'ai-je pas de données avant janvier ? » se pose devant CET écran, et
  // c'est donc lui qui doit y répondre.
  //
  // Le seuil porte sur la MAJORITÉ, pas sur un joueur : un nouvel inscrit à une seule mesure
  // est normal, tout le club à une seule mesure ne l'est pas.
  const series = data?.series ?? [];
  const seuls = series.filter((s) => s.points.length <= 1).length;
  const presqueVide = series.length >= 3 && seuls > series.length / 2;

  const bascule = (id: string) =>
    setChoisis((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  if (!open) return null;

  // Les étiquettes de mois affichées : la première, la dernière, et de quoi jalonner entre les
  // deux. Toutes les afficher les ferait se chevaucher dès la deuxième saison.
  const pas = Math.max(1, Math.ceil(months.length / MAX_ETIQUETTES));
  const etiquettes = months
    .map((m, i) => ({ m, i }))
    .filter(({ i }) => i % pas === 0 || i === months.length - 1);

  // Trois graduations horizontales : le minimum pour donner une échelle, le maximum avant que
  // le fond ne devienne une grille qui capte plus l'œil que les courbes.
  //
  // ⚠️ UNE SEULE QUAND L'ÉTENDUE EST NULLE, et c'est un cas COURANT, pas une curiosité :
  // un joueur qui n'a qu'une mesure, ou une plage resserrée sur un mois — l'écran a un état
  // dédié pour ça (`presqueVide`). Les trois graduations valaient alors la même chose, donc
  // trois traits et trois étiquettes empilés au même pixel, et surtout trois `<g>` de MÊME
  // CLÉ : React avertit, et se réserve le droit de réutiliser le mauvais nœud. `ordonnee`
  // protège bien du NaN (c'est testé) ; c'est l'appelant qui dédoublonnait.
  const graduations =
    bornes === null
      ? []
      : bornes.max === bornes.min
        ? [{ v: bornes.min, y: ordonnee(bornes.min, bornes, CADRE) }]
        : [0, 0.5, 1].map((t) => {
            const v = bornes.min + (bornes.max - bornes.min) * t;
            return { v, y: ordonnee(v, bornes, CADRE) };
          });

  return (
    <Dialog onClose={onClose} label="Progression du classement" className="rankhist" autoFocus={false}>
      <h3>Progression</h3>

      {/* PLUS DE SÉLECTEUR DE MÉTRIQUE. L'écran offrait au choix « Points » et « Rang » ; les
          deux valent r = 1,000 l'un pour l'autre (cf. l'en-tête de `ranking-history`), donc le
          choix ne portait sur rien — deux vues du même chiffre, dont l'une était en plus
          dessinée à l'envers. Un choix sans conséquence coûte quand même une décision au
          lecteur, à chaque ouverture. */}
      <p className="muted tiny rankhist-aide">
        Rang national toutes catégories&nbsp;: il baisse quand on progresse — la courbe, elle,
        monte toujours dans le bon sens.
      </p>
      {marches.length > 0 && (
        <p className="muted tiny rankhist-aide">
          Les bandes colorées sont les classements, du plus soutenu (le plus fort) au plus
          pâle&nbsp;; les traits marquent le passage de l&apos;un à l&apos;autre, déduit des
          mesures du club.
        </p>
      )}

      {data === null ? (
        <p className="muted tiny">Chargement…</p>
      ) : erreur ? (
        <p className="muted tiny">{erreur}</p>
      ) : data.months.length === 0 ? (
        <p className="muted tiny">
          Aucun historique pour le moment. Il se remplit tout seul à chaque passe mensuelle de
          classement&nbsp;; pour aller chercher les mois passés d&apos;un coup, un administrateur
          peut lancer « Compléter l&apos;historique » depuis l&apos;espace d&apos;administration.
        </p>
      ) : (
        <>
          <div className="rankhist-plage">
            <label>
              <span className="sr-only">Depuis le mois</span>
              <select value={depuis} onChange={(e) => setDepuis(e.target.value)}>
                {data.months.map((m) => (
                  <option key={m} value={m} disabled={!!jusqua && m > jusqua}>
                    {moisLabel(m)}
                  </option>
                ))}
              </select>
            </label>
            <span aria-hidden="true">→</span>
            <label>
              <span className="sr-only">Jusqu&apos;au mois</span>
              <select value={jusqua} onChange={(e) => setJusqua(e.target.value)}>
                {data.months.map((m) => (
                  <option key={m} value={m} disabled={!!depuis && m < depuis}>
                    {moisLabel(m)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {tracees.length === 0 || !bornes ? (
            <p className="muted tiny rankhist-vide">
              {tracees.length === 0
                ? "Choisis au moins un joueur ci-dessous."
                : "Aucune mesure sur cette période pour les joueurs choisis."}
            </p>
          ) : (
            <svg
              className="rankhist-graph"
              viewBox={`0 0 ${CADRE.w} ${CADRE.h}`}
              role="img"
              aria-label={
                `Courbes de rang national ` +
                `entre ${moisLabel(months[0])} et ${moisLabel(months[months.length - 1])}. ` +
                // Les marches sont ANNONCÉES : à la voix, une ligne pointillée n'existe pas, et
                // c'est pourtant elle qui donne son sens à « 1 180 points ».
                (marches.length > 0
                  ? `Lignes de passage de classement affichées : ` +
                    `${marches.map((f) => f.clt).join(", ")}. `
                  : "") +
                `Les valeurs chiffrées sont listées sous le graphique.`
              }
            >
              {/* LES ZONES EN PREMIER, donc tout au fond. `fill-opacity` monte avec la force
                  du classement : une rampe, pas une couleur par catégorie (cf. l'en-tête).
                  Elle est calculée ici plutôt qu'en CSS parce que le nombre de bandes dépend
                  des données — une classe par échelon supposerait de les connaître d'avance.
                  Plafonnée bas : au-delà, le fond se met à concurrencer les courbes. */}
              {bandes.map((b) => {
                const y1 = ordonnee(b.min, bornes, CADRE);
                const y2 = ordonnee(b.max, bornes, CADRE);
                // UNE SEULE BANDE VISIBLE (le cas d'un joueur qui n'a jamais changé de
                // classement) : pas de rampe à lire, donc pas de raison de prendre le ton le
                // plus soutenu. On se pose au milieu — assez pour que la zone existe, pas assez
                // pour qu'elle pèse plus que la courbe qu'elle accompagne.
                const t = b.total <= 1 ? 0.5 : b.rang / (b.total - 1);
                return (
                  <rect
                    key={`bande-${b.clt}`}
                    className="rankhist-bande"
                    x={CADRE.padL}
                    width={CADRE.w - CADRE.padL - CADRE.padR}
                    y={Math.min(y1, y2)}
                    height={Math.abs(y2 - y1)}
                    fillOpacity={0.04 + t * 0.13}
                  />
                );
              })}
              {/* Les marches ensuite, toujours DERRIÈRE les courbes. Une ligne de repère qui
                  masquerait un point de mesure ferait perdre à l'écran ce qu'il est venu
                  montrer. */}
              {marches.map((f) => (
                <g key={`palier-${f.clt}`}>
                  <line
                    className="rankhist-palier"
                    x1={CADRE.padL}
                    x2={CADRE.w - CADRE.padR}
                    y1={f.y}
                    y2={f.y}
                  />
                  {/* L'étiquette DANS le cadre et posée SUR la ligne (`y - 2`), à droite : la
                      marge gauche est déjà prise par les valeurs de l'axe, et un classement
                      écrit sous la ligne se lirait comme appartenant à la zone du dessous. */}
                  <text
                    className="rankhist-palier-txt"
                    x={CADRE.w - CADRE.padR - 2}
                    y={f.y - 2}
                    textAnchor="end"
                  >
                    {f.clt}
                  </text>
                </g>
              ))}
              {/* Clé sur l'INDICE et non sur la valeur : deux graduations peuvent partager la
                  même valeur (étendue nulle), et deux clés identiques laissent React réutiliser
                  le mauvais nœud. L'ordre de cette liste, lui, ne bouge jamais. */}
              {graduations.map((g, gi) => (
                <g key={gi}>
                  <line
                    className="rankhist-grille"
                    x1={CADRE.padL}
                    x2={CADRE.w - CADRE.padR}
                    y1={g.y}
                    y2={g.y}
                  />
                  <text className="rankhist-axe" x={CADRE.padL - 5} y={g.y + 3} textAnchor="end">
                    {nombre(g.v)}
                  </text>
                </g>
              ))}
              {etiquettes.map(({ m, i }) => (
                <text
                  key={m}
                  className="rankhist-axe"
                  x={abscisse(i, months.length, CADRE)}
                  y={CADRE.h - 6}
                  textAnchor={i === 0 ? "start" : i === months.length - 1 ? "end" : "middle"}
                >
                  {moisLabel(m)}
                </text>
              ))}
              {tracees.map((s, idx) => {
                const vals = valeurs(s, months);
                return (
                  <g key={s.id}>
                    <path
                      className="rankhist-trace"
                      d={chemin(vals, bornes, CADRE)}
                      stroke={couleurDe(idx)}
                    />
                    {vals.map((v, i) =>
                      v === null ? null : (
                        <circle
                          key={`${s.id}-${i}`}
                          cx={abscisse(i, months.length, CADRE)}
                          cy={ordonnee(v, bornes, CADRE)}
                          r={2}
                          fill={couleurDe(idx)}
                        />
                      ),
                    )}
                  </g>
                );
              })}
            </svg>
          )}

          {/* La légende PORTE LES CHIFFRES : dernière valeur et évolution sur la plage. C'est ce
              qui rend l'écran utilisable au doigt, où rien ne se survole. */}
          {tracees.length > 0 && (
            <ul className="rankhist-legende">
              {tracees.map((s, idx) => {
                const dernier = dernierPoint(s, months);
                const evo = progression(s, months);
                const v = dernier?.rangM ?? null;
                return (
                  <li key={s.id}>
                    <span
                      className="rankhist-puce"
                      style={{ background: couleurDe(idx) }}
                      aria-hidden="true"
                    />
                    <span className="rankhist-nom">{s.name}</span>
                    {dernier?.clt && <span className="directory-clt">{dernier.clt}</span>}
                    <span className="rankhist-val">{v === null ? "—" : nombre(v)}</span>
                    <span
                      className={
                        "rankhist-evo" + (evo === null ? "" : evo > 0 ? " up" : evo < 0 ? " down" : "")
                      }
                    >
                      {evo === null ? "—" : evolution(evo)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          <input
            type="search"
            className="directory-search"
            placeholder="Ajouter un joueur…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Rechercher un joueur à comparer"
          />
          {presqueVide && (
            <p className="notice info tiny rankhist-indice">
              {seuls} joueur{seuls > 1 ? "s" : ""} sur {series.length} n&apos;
              {seuls > 1 ? "ont" : "a"} qu&apos;une seule mesure&nbsp;: les mois passés n&apos;ont
              pas encore été récupérés pour eux. Un administrateur peut lancer « Compléter
              l&apos;historique » depuis l&apos;espace d&apos;administration.
            </p>
          )}
          <ul className="rankhist-choix">
            {listables.length === 0 ? (
              <li className="muted tiny">Aucun résultat.</li>
            ) : (
              listables.map((s) => (
                <li key={s.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={choisis.includes(s.id)}
                      onChange={() => bascule(s.id)}
                    />
                    <span className="rankhist-nom">{s.name}</span>
                    {s.team && <span className="directory-team">{s.team}</span>}
                    <span className="muted tiny">
                      {s.points.length} mesure{s.points.length > 1 ? "s" : ""}
                    </span>
                  </label>
                </li>
              ))
            )}
          </ul>
        </>
      )}

      <div className="modal-actions">
        <button className="secondary" onClick={onClose}>
          Fermer
        </button>
      </div>
    </Dialog>
  );
}
