"use client";

import { useEffect, useMemo, useState } from "react";
import { Dialog } from "@/components/Dialog";
import { readOk } from "@/lib/apiFetch";
import {
  bornesValeurs,
  chemin,
  couleurDe,
  dernierPoint,
  moisDansPlage,
  moisLabel,
  ordonnee,
  abscisse,
  progression,
  valeurs,
  type Cadre,
  type HistorySeries,
  type Metrique,
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

const nombre = (v: number, metrique: Metrique) =>
  metrique === "mean" ? Math.round(v).toLocaleString("fr-FR") : `#${v}`;

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
  const [metrique, setMetrique] = useState<Metrique>("mean");
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
  const bornes = useMemo(
    () => bornesValeurs(tracees, months, metrique),
    [tracees, months, metrique],
  );

  const aiguille = q.trim().toLowerCase();
  const listables = (data?.series ?? []).filter((s) => s.name.toLowerCase().includes(aiguille));

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
  const graduations = bornes
    ? [0, 0.5, 1].map((t) => {
        const v = bornes.min + (bornes.max - bornes.min) * t;
        return { v, y: ordonnee(v, bornes, metrique, CADRE) };
      })
    : [];

  return (
    <Dialog onClose={onClose} label="Progression du classement" className="rankhist" autoFocus={false}>
      <h3>Progression</h3>

      {/* La métrique EN PREMIER : elle change ce que la courbe veut dire, donc elle se décide
          avant de regarder. Même vocabulaire segmenté que le tri de l'annuaire. */}
      <div className="directory-sort" role="group" aria-label="Valeur à tracer">
        <button type="button" aria-pressed={metrique === "mean"} onClick={() => setMetrique("mean")}>
          Points
        </button>
        <button
          type="button"
          aria-pressed={metrique === "rangM"}
          onClick={() => setMetrique("rangM")}
        >
          Rang
        </button>
      </div>
      <p className="muted tiny rankhist-aide">
        {metrique === "mean"
          ? "Moyenne de points de la fédération : elle monte quand on progresse."
          : "Rang national toutes catégories : il baisse quand on progresse — la courbe, elle, monte toujours dans le bon sens."}
      </p>

      {data === null ? (
        <p className="muted tiny">Chargement…</p>
      ) : erreur ? (
        <p className="muted tiny">{erreur}</p>
      ) : data.months.length === 0 ? (
        <p className="muted tiny">
          Aucun historique pour le moment. Il se remplit à chaque passe mensuelle de classement —
          et rétroactivement avec <code>npm run rankings:backfill</code>.
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
                `Courbes de ${metrique === "mean" ? "moyenne de points" : "rang national"} ` +
                `entre ${moisLabel(months[0])} et ${moisLabel(months[months.length - 1])}. ` +
                `Les valeurs chiffrées sont listées sous le graphique.`
              }
            >
              {graduations.map((g) => (
                <g key={g.v}>
                  <line
                    className="rankhist-grille"
                    x1={CADRE.padL}
                    x2={CADRE.w - CADRE.padR}
                    y1={g.y}
                    y2={g.y}
                  />
                  <text className="rankhist-axe" x={CADRE.padL - 5} y={g.y + 3} textAnchor="end">
                    {nombre(g.v, metrique)}
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
                const vals = valeurs(s, months, metrique);
                return (
                  <g key={s.id}>
                    <path
                      className="rankhist-trace"
                      d={chemin(vals, bornes, metrique, CADRE)}
                      stroke={couleurDe(idx)}
                    />
                    {vals.map((v, i) =>
                      v === null ? null : (
                        <circle
                          key={`${s.id}-${i}`}
                          cx={abscisse(i, months.length, CADRE)}
                          cy={ordonnee(v, bornes, metrique, CADRE)}
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
                const evo = progression(s, months, metrique);
                const v = dernier?.[metrique] ?? null;
                return (
                  <li key={s.id}>
                    <span
                      className="rankhist-puce"
                      style={{ background: couleurDe(idx) }}
                      aria-hidden="true"
                    />
                    <span className="rankhist-nom">{s.name}</span>
                    {dernier?.clt && <span className="directory-clt">{dernier.clt}</span>}
                    <span className="rankhist-val">{v === null ? "—" : nombre(v, metrique)}</span>
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
