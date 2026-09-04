"use client";

import { useCallback, useState } from "react";
import { readOk } from "@/lib/apiFetch";
import type { PlayerStatRow } from "@/lib/interclub-stats";

// ============================================================================
//  LE PALMARÈS DES JOUEURS.
//
//  Publiques pour tous les membres, et c'est une décision : ces chiffres sont
//  entièrement déduits des scores de rencontre, déjà visibles de tous. Les
//  réserver au joueur et au capitaine aurait caché un total que chacun peut
//  refaire à la main.
//
//  CHARGÉ À L'OUVERTURE, JAMAIS AVANT. La requête joint les simples et leur jeu
//  par jeu sur toute l'histoire du club : la payer à chaque affichage de
//  l'écran interclub, pour un bloc que personne n'ouvre la plupart du temps,
//  serait un coût permanent au bénéfice d'un usage occasionnel.
// ============================================================================

type Payload = { rows: PlayerStatRow[]; seasons: string[] };

/** « 67 % ». Jamais « 0 % » sur zéro match : voir `winRate` dans interclub-stats.ts. */
const pourcent = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)} %`);

const signe = (n: number) => (n > 0 ? `+${n}` : `${n}`);

export function InterclubStats({
  teamId,
  onExpired,
}: {
  /** L'équipe de l'onglet courant, ou null pour tout le club. */
  teamId: string | null;
  onExpired: (status: number) => boolean;
}) {
  const [data, setData] = useState<Payload | null>(null);
  const [saison, setSaison] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);

  const charge = useCallback(
    async (saisonVoulue: string) => {
      setBusy(true);
      setErreur(null);
      try {
        const qs = new URLSearchParams();
        if (teamId) qs.set("teamId", teamId);
        if (saisonVoulue) qs.set("season", saisonVoulue);
        const res = await fetch(`/api/interclub/stats?${qs}`, { cache: "no-store" });
        if (onExpired(res.status)) return;
        setData(await readOk<Payload>(res));
      } catch {
        // Le silence serait indiscernable d'un club sans aucun match joué.
        setErreur("Statistiques indisponibles pour le moment.");
      } finally {
        setBusy(false);
      }
    },
    [teamId, onExpired],
  );

  return (
    <details
      className="ic-stats"
      onToggle={(ev) => {
        // Au premier dépliage seulement : `data` non nul vaut « déjà chargé ».
        if (ev.currentTarget.open && !data && !busy) void charge(saison);
      }}
    >
      <summary>
        <span className="ic-stats-title">Statistiques des joueurs</span>
        <span className="ic-stats-sub muted tiny">
          {data ? `${data.rows.length} joueur${data.rows.length > 1 ? "s" : ""}` : "à ouvrir"}
        </span>
      </summary>

      {erreur && <p className="muted tiny ic-stats-msg">{erreur}</p>}
      {busy && !data && <p className="muted tiny ic-stats-msg">Chargement…</p>}

      {data && data.seasons.length > 0 && (
        <label className="ic-stats-season">
          <span className="muted tiny">Saison</span>
          <select
            value={saison}
            disabled={busy}
            onChange={(ev) => {
              setSaison(ev.target.value);
              setData(null);
              void charge(ev.target.value);
            }}
          >
            <option value="">Toutes</option>
            {data.seasons.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      )}

      {data && data.rows.length === 0 && (
        <p className="muted tiny ic-stats-msg">
          Aucun match terminé pour l&apos;instant — les statistiques se remplissent au fil des
          soirées marquées.
        </p>
      )}

      {data && data.rows.length > 0 && (
        <div className="ic-stats-scroll">
          <table className="ic-stats-table">
            <thead>
              <tr>
                <th scope="col" className="ic-stats-name">
                  Joueur
                </th>
                <th scope="col" title="Matchs joués">
                  MJ
                </th>
                <th scope="col" title="Victoires">
                  V
                </th>
                <th scope="col" title="Défaites">
                  D
                </th>
                <th scope="col" className="ic-stats-pct">
                  %
                </th>
                <th scope="col" title="Jeux gagnés moins jeux perdus">
                  Jeux
                </th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.key}>
                  <th scope="row" className="ic-stats-name" title={r.name}>
                    {r.name}
                    {/* Un joueur sans compte joue les mêmes matchs et compte pareil ; la
                        mention évite seulement qu'on le cherche dans l'annuaire. */}
                    {!r.isMember && <span className="ic-stats-tag">hors appli</span>}
                  </th>
                  <td>{r.played}</td>
                  <td>{r.won}</td>
                  <td>{r.lost}</td>
                  <td className="ic-stats-pct">{pourcent(r.winRate)}</td>
                  <td
                    title={`${r.games.won} jeux gagnés, ${r.games.lost} perdus${
                      r.rallies
                        ? ` · points ${r.rallies.won}–${r.rallies.lost} (${signe(r.rallies.diff)})`
                        : ""
                    }`}
                  >
                    {signe(r.games.diff)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.rows.length > 0 && (
        <p className="ic-stats-note muted tiny">
          Classé par victoires. Le pourcentage s&apos;affiche mais ne classe pas : un joueur qui
          a gagné son unique match passerait devant celui qui en a gagné neuf sur douze.
        </p>
      )}
    </details>
  );
}
