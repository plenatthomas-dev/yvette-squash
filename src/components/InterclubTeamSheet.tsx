"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { Dialog } from "@/components/Dialog";
import { readOk } from "@/lib/apiFetch";
import { nomLisible } from "@/lib/nom-lisible";
import { jeuxDuScore, totauxDesScores } from "@/lib/interclub-score";
import type { PlayerSheet, SheetTeamRef, TeamSheet } from "@/lib/interclub-team-sheet";
import type { PlayerStatRow } from "@/lib/interclub-stats";
import type { PoolTie } from "@/lib/squashnet/pool";
import type { TiePlayer } from "@/lib/squashnet/tie";

// ============================================================================
//  LA FICHE D'UNE ÉQUIPE DE LA POULE — et ce qu'on atteint depuis elle.
//
//  On touche une équipe du classement : ses rencontres et leurs scores. On touche
//  une rencontre : ses quatre simples, jeu par jeu. « Effectif » : ses inscrits.
//  On touche un joueur : ses matchs. Le modèle est celui de l'appli Squash App,
//  que les joueurs du club connaissent.
//
//  UNE SEULE MODALE, ET UNE PILE DE VUES. Empiler des modales ferait fermer quatre
//  fenêtres pour revenir au classement ; ici la flèche de l'en-tête remonte d'un
//  cran, la croix referme tout. Une vue déjà chargée ne se recharge pas au retour.
//
//  AFFICHER D'ABORD, RELIRE ENSUITE. `GET` rend tout de suite ce que la base sait ;
//  s'il répond `stale`, un `POST` va chercher chez la ligue ce qui a vieilli, et la
//  vue se met à jour sous les yeux. Personne n'attend devant un écran vide une
//  requête que l'on peut faire en arrière-plan.
// ============================================================================

type Vue =
  | { kind: "team"; snTeamId: string; name: string; tab: "ties" | "roster" }
  | { kind: "tie"; tie: PoolTie; teams: SheetTeamRef[]; focus: string | null }
  | { kind: "player"; regiid: string; name: string };

/** « 2026-10-08 » → « jeu. 8 oct. » — même format que la liste des rencontres. */
function jour(iso: string | null): string {
  if (!iso) return "date à fixer";
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
}

/** « 18 oct., 22:04 » — de quand date ce qu'on affiche. */
function releve(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", {
    timeZone: "Europe/Paris",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const rangCourt = (n: number) => (n === 1 ? "1er" : `${n}e`);
const pluriel = (n: number, mot: string) => `${n} ${mot}${n > 1 ? "s" : ""}`;

/** L'issue d'une rencontre JOUÉE, vue de l'équipe `focus`. */
function issue(t: PoolTie, focus: string | null): "win" | "loss" | "draw" | null {
  if (t.scoreHome === null || t.scoreAway === null || !focus) return null;
  const [nous, eux] = t.homeCode === focus ? [t.scoreHome, t.scoreAway] : [t.scoreAway, t.scoreHome];
  return nous > eux ? "win" : nous < eux ? "loss" : "draw";
}

/**
 * Lire une fiche : `GET`, puis `POST` si elle est à relire. Le cache vit dans la modale, pour
 * qu'un retour en arrière n'émette aucune requête.
 */
function useFiche<T extends { stale: boolean }>(
  url: string,
  cache: Map<string, unknown>,
  onExpired: (status: number) => boolean,
): { data: T | null; erreur: string | null; relecture: boolean } {
  const [data, setData] = useState<T | null>(() => (cache.get(url) as T | undefined) ?? null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [relecture, setRelecture] = useState(false);

  useEffect(() => {
    let vivant = true;
    const deja = cache.get(url) as T | undefined;
    if (deja && !deja.stale) return;
    (async () => {
      let lu = deja ?? null;
      if (!lu) {
        try {
          const res = await fetch(url, { cache: "no-store" });
          if (onExpired(res.status)) return;
          lu = await readOk<T>(res);
          if (!vivant) return;
          cache.set(url, lu);
          setData(lu);
        } catch {
          if (vivant) setErreur("Fiche indisponible pour le moment. Réessaie dans un instant.");
          return;
        }
      }
      if (!lu.stale) return;
      setRelecture(true);
      try {
        const res = await fetch(url, { method: "POST", cache: "no-store" });
        if (onExpired(res.status)) return;
        const frais = await readOk<T>(res);
        // `stale` retombe à faux même si la ligue n'a pas répondu : la relecture a été tentée,
        // elle ne doit pas repartir à chaque retour sur cette vue.
        const vu = { ...frais, stale: false };
        cache.set(url, vu);
        if (vivant) setData(vu);
      } catch {
        /* On garde ce qu'on a : la date de relevé, affichée en pied, dit son âge. */
      } finally {
        if (vivant) setRelecture(false);
      }
    })();
    return () => {
      vivant = false;
    };
  }, [url, cache, onExpired]);

  return { data, erreur, relecture };
}

// ---------------------------------------------------------------------------
//  Morceaux communs.
// ---------------------------------------------------------------------------

/** « Morel Stanislas · 4D · 2128 » — le classement d'un soir, au rang mixte. */
function Joueur({ p, gagne, onOpen }: { p: TiePlayer | null; gagne: boolean; onOpen: (p: TiePlayer) => void }) {
  if (!p) return <span className="ic-sheet-who muted">—</span>;
  const nom = nomLisible(p.name);
  const contenu = (
    <>
      <span className="ic-sheet-name">{nom}</span>
      {(p.clt || p.rangM) && (
        <span
          className="ic-sheet-clt"
          title={`Classement ${p.clt ?? "?"}${p.rangM ? `, rang mixte ${p.rangM}` : ""}`}
        >
          {[p.clt, p.rangM].filter(Boolean).join(" · ")}
        </span>
      )}
    </>
  );
  const classe = `ic-sheet-who${gagne ? " is-winner" : ""}`;
  return p.regiid ? (
    <button type="button" className={`${classe} ic-sheet-link`} onClick={() => onOpen(p)}>
      {contenu}
    </button>
  ) : (
    <span className={classe}>{contenu}</span>
  );
}

/** Un match dans une liste : date, adversaire et son équipe, issue, score. */
export interface MatchItem {
  key: string;
  date: string | null;
  won: boolean | null;
  opponentName: string | null;
  opponentClt: string | null;
  opponentTeam: string | null;
  /** Ce qui situe le match chez le joueur : son équipe, l'intitulé du simple. */
  context: string | null;
  /** De SON point de vue. */
  score: string | null;
}

function MatchList({ items }: { items: MatchItem[] }) {
  if (items.length === 0) {
    return <p className="muted tiny ic-sheet-msg">Aucun match joué pour l&apos;instant.</p>;
  }
  return (
    <ul className="ic-sheet-matches">
      {items.map((m) => {
        const jeux = jeuxDuScore(m.score);
        return (
          <li
            key={m.key}
            className={`ic-sheet-match${m.won === true ? " ic-issue-win" : m.won === false ? " ic-issue-loss" : ""}`}
          >
            <span className="ic-sheet-match-head">
              <span className="ic-date">{jour(m.date)}</span>
              {m.won !== null && (
                <span className="ic-sheet-result">{m.won ? "Gagné" : "Perdu"}</span>
              )}
            </span>
            <span className="ic-sheet-match-main">
              <span className="ic-sheet-opp">
                <span className="ic-vs-word">contre </span>
                <strong>{m.opponentName ?? "?"}</strong>
                {m.opponentClt && <span className="ic-sheet-clt"> {m.opponentClt}</span>}
                {m.opponentTeam && <span className="ic-sheet-opp-team">{m.opponentTeam}</span>}
              </span>
              {m.score && (
                <span className="ic-sheet-match-score" aria-label={`Score : ${m.score}`}>
                  {jeux
                    ? jeux.map(([a, b], i) => (
                        <span key={i} className={a > b ? "is-won" : undefined}>
                          {a}-{b}
                        </span>
                      ))
                    : m.score}
                </span>
              )}
            </span>
            {m.context && <span className="ic-sheet-context muted">{m.context}</span>}
          </li>
        );
      })}
    </ul>
  );
}

/** « 7 matchs · 5 V – 2 D » — la même ligne que le tableau des statistiques. */
function Bilan({ won, lost }: { won: number; lost: number }) {
  return (
    <p className="ic-sheet-record">
      <strong>{pluriel(won + lost, "match")}</strong>
      <span className="ic-vs-word"> · </span>
      {won} V – {lost} D
    </p>
  );
}

/** L'en-tête collant : retour, titre, croix. */
function Entete({
  titre,
  onBack,
  onClose,
  titreRef,
}: {
  titre: ReactNode;
  onBack: (() => void) | null;
  onClose: () => void;
  titreRef?: Ref<HTMLHeadingElement>;
}) {
  return (
    <div className="settings-head ic-detail-head ic-sheet-head">
      {onBack && (
        <button
          type="button"
          className="secondary settings-close ic-sheet-back"
          onClick={onBack}
          aria-label="Revenir en arrière"
          title="Retour"
        >
          ‹
        </button>
      )}
      <h3 ref={titreRef} tabIndex={-1}>
        {titre}
      </h3>
      <button
        type="button"
        className="secondary settings-close"
        onClick={onClose}
        aria-label="Fermer la fiche"
        title="Fermer"
      >
        ✕
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
//  Les trois vues.
// ---------------------------------------------------------------------------

function VueEquipe({
  vue,
  cache,
  onExpired,
  onTab,
  push,
}: {
  vue: Extract<Vue, { kind: "team" }>;
  cache: Map<string, unknown>;
  onExpired: (status: number) => boolean;
  onTab: (tab: "ties" | "roster") => void;
  push: (v: Vue) => void;
}) {
  const { data, erreur, relecture } = useFiche<TeamSheet>(
    `/api/interclub/poule/equipe?snTeamId=${encodeURIComponent(vue.snTeamId)}`,
    cache,
    onExpired,
  );
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const ordre = ["ties", "roster"] as const;

  if (erreur) return <p className="muted tiny ic-sheet-msg">{erreur}</p>;
  if (!data) return <p className="muted tiny ic-sheet-msg">Chargement…</p>;

  const { team, ties, roster } = data;
  const nuls = team.drawWon + team.drawLost;
  const onKeyDown = (e: KeyboardEvent, i: number) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const j = i === 0 ? 1 : 0;
    onTab(ordre[j]);
    tabs.current[j]?.focus();
  };

  return (
    <>
      <p className="ic-sheet-sum">
        <span className="ic-standings-rank">{rangCourt(team.rank)}</span>
        <span className="muted">
          {team.points} pts · {team.won} V{nuls > 0 ? ` · ${nuls} N` : ""} · {team.lost} D
          {team.code ? ` · ${team.code}` : ""}
        </span>
      </p>

      <div className="ic-tabs ic-sheet-tabs" role="tablist" aria-label="Rencontres ou effectif">
        {ordre.map((t, i) => (
          <button
            key={t}
            type="button"
            role="tab"
            id={`ic-sheet-tab-${t}`}
            aria-selected={vue.tab === t}
            aria-controls="ic-sheet-panel"
            tabIndex={vue.tab === t ? 0 : -1}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            className={`ic-tab${vue.tab === t ? " is-on" : ""}`}
            onClick={() => onTab(t)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {t === "ties" ? "Rencontres" : `Effectif${roster ? ` (${roster.length})` : ""}`}
          </button>
        ))}
      </div>

      <div id="ic-sheet-panel" role="tabpanel" aria-labelledby={`ic-sheet-tab-${vue.tab}`}>
        {vue.tab === "ties" ? (
          ties.length === 0 ? (
            <p className="muted tiny ic-sheet-msg">
              {relecture ? "Lecture des rencontres chez la ligue…" : "Aucune rencontre publiée pour l'instant."}
            </p>
          ) : (
            <ul className="ic-list ic-sheet-ties">
              {ties.map((t) => {
                const i = issue(t, team.code);
                const jouee = t.scoreHome !== null && t.scoreAway !== null;
                const contenu = (
                  <>
                    <span className="ic-row-head">
                      <span className="ic-date">
                        <span className="ic-round">{t.round}</span>
                        {t.dateConfirmed ? jour(t.date) : "date à fixer"}
                      </span>
                      {!jouee && <span className="ic-status">À venir</span>}
                    </span>
                    <span className="ic-row-main">
                      <span className="ic-opponent ic-sheet-pair">
                        <span className={t.homeCode === team.code ? "is-focus" : undefined}>{t.homeName}</span>
                        <span className="ic-vs-word"> reçoit </span>
                        <span className={t.awayCode === team.code ? "is-focus" : undefined}>{t.awayName}</span>
                      </span>
                      {jouee ? (
                        <span className="ic-score" aria-label={`Score ${t.scoreHome} à ${t.scoreAway}`}>
                          {t.scoreHome}–{t.scoreAway}
                        </span>
                      ) : (
                        <span className="ic-score ic-score-none" aria-label="Pas encore jouée">
                          <span aria-hidden="true">–</span>
                        </span>
                      )}
                    </span>
                  </>
                );
                const key = `${t.round}-${t.homeCode}-${t.awayCode}`;
                // Une rencontre à venir n'a rien à détailler : elle ne s'ouvre pas sur une feuille vide.
                return (
                  <li key={key}>
                    {jouee ? (
                      <button
                        type="button"
                        className={`ic-row${i ? ` ic-issue-${i}` : ""}`}
                        onClick={() => push({ kind: "tie", tie: t, teams: data.teams, focus: team.code })}
                      >
                        {contenu}
                      </button>
                    ) : (
                      <div className="ic-row ic-sheet-later">{contenu}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )
        ) : roster === null ? (
          <p className="muted tiny ic-sheet-msg">
            {relecture ? "Lecture de l'effectif chez la ligue…" : "Effectif pas encore relevé."}
          </p>
        ) : roster.length === 0 ? (
          <p className="muted tiny ic-sheet-msg">Aucun joueur inscrit pour l&apos;instant.</p>
        ) : (
          <ul className="ic-sheet-roster">
            {roster.map((p) => {
              const contenu = (
                <>
                  <span className="ic-sheet-badge">{p.clt ?? "?"}</span>
                  <span className="ic-sheet-name">{nomLisible(p.name)}</span>
                  {p.rangM && (
                    <span className="ic-sheet-clt" title={`Rang mixte ${p.rangM}`}>
                      {p.rangM}e
                    </span>
                  )}
                </>
              );
              return (
                <li key={p.licence ?? p.name}>
                  {p.regiid ? (
                    <button
                      type="button"
                      className="ic-sheet-person"
                      onClick={() => push({ kind: "player", regiid: p.regiid as string, name: nomLisible(p.name) })}
                    >
                      {contenu}
                    </button>
                  ) : (
                    <span className="ic-sheet-person">{contenu}</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <p className="ic-stats-note muted tiny">
        {vue.tab === "ties"
          ? data.poolAt
            ? `Résultats relevés sur squashnet le ${releve(data.poolAt)}.`
            : null
          : data.rosterAt
            ? `Effectif relevé sur squashnet le ${releve(data.rosterAt)}.`
            : null}
        {relecture && " Mise à jour…"}
      </p>
    </>
  );
}

function VueRencontre({
  vue,
  push,
}: {
  vue: Extract<Vue, { kind: "tie" }>;
  push: (v: Vue) => void;
}) {
  const { tie, teams } = vue;
  const totaux = totauxDesScores(tie.lines.map((l) => l.score));
  const equipe = (code: string, nom: string | null) => {
    const ref = teams.find((t) => t.code === code);
    const libelle = nom ?? ref?.name ?? code;
    return ref?.snTeamId ? (
      <button
        type="button"
        className="ic-sheet-link ic-sheet-team"
        onClick={() => push({ kind: "team", snTeamId: ref.snTeamId as string, name: libelle, tab: "ties" })}
      >
        {libelle}
      </button>
    ) : (
      <span className="ic-sheet-team">{libelle}</span>
    );
  };
  const ouvrir = (p: TiePlayer) => push({ kind: "player", regiid: p.regiid as string, name: nomLisible(p.name) });

  return (
    <>
      <div className="ic-sheet-score">
        {equipe(tie.homeCode, tie.homeName)}
        <span className="ic-sheet-bigscore" aria-label={`Score ${tie.scoreHome ?? "?"} à ${tie.scoreAway ?? "?"}`}>
          {tie.scoreHome ?? "–"}–{tie.scoreAway ?? "–"}
        </span>
        {equipe(tie.awayCode, tie.awayName)}
      </div>
      {/* La journée et le jour sont au titre : la ligne ne garde que l'heure et les totaux. */}
      <p className="muted tiny ic-sheet-meta">
        {[
          tie.dateConfirmed && tie.time ? tie.time : null,
          totaux && `jeux ${totaux.jeux[0]}–${totaux.jeux[1]}`,
          totaux && `points ${totaux.points[0]}–${totaux.points[1]}`,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      <ul className="ic-sheet-lines">
        {tie.lines.map((l) => {
          const jeux = jeuxDuScore(l.score);
          return (
            <li key={l.label} className="ic-sheet-line">
              <span className="ic-sheet-line-label muted">{l.label}</span>
              {(["home", "away"] as const).map((cote) => (
                <span key={cote} className="ic-sheet-line-row">
                  <Joueur p={l[cote]} gagne={l.winner === cote} onOpen={ouvrir} />
                  <span className="ic-sheet-games">
                    {jeux
                      ? jeux.map(([h, a], i) => {
                          const [moi, lui] = cote === "home" ? [h, a] : [a, h];
                          return (
                            <span key={i} className={moi > lui ? "is-won" : undefined}>
                              {moi}
                            </span>
                          );
                        })
                      : cote === "home" && l.score && <span>{l.score}</span>}
                  </span>
                </span>
              ))}
            </li>
          );
        })}
      </ul>
    </>
  );
}

function VueJoueur({
  vue,
  cache,
  onExpired,
}: {
  vue: Extract<Vue, { kind: "player" }>;
  cache: Map<string, unknown>;
  onExpired: (status: number) => boolean;
}) {
  const { data, erreur, relecture } = useFiche<PlayerSheet>(
    `/api/interclub/poule/joueur?regiid=${encodeURIComponent(vue.regiid)}`,
    cache,
    onExpired,
  );
  if (erreur) return <p className="muted tiny ic-sheet-msg">{erreur}</p>;
  if (!data) return <p className="muted tiny ic-sheet-msg">Chargement…</p>;

  const won = data.matches.filter((m) => m.result === "won").length;
  const lost = data.matches.filter((m) => m.result === "lost").length;
  const items: MatchItem[] = data.matches.map((m, i) => ({
    key: `${m.date}-${i}`,
    date: m.date,
    won: m.result === null ? null : m.result === "won",
    opponentName: m.opponent ? nomLisible(m.opponent.name) : null,
    opponentClt: m.opponent?.clt ?? null,
    // L'équipe adverse quand on sait la nommer ; sinon l'intitulé fédéral, tel quel.
    opponentTeam: m.opponentTeam ?? m.tie,
    context: m.ownTeam && m.clt ? `${m.ownTeam} · classé ${m.clt}` : (m.ownTeam ?? null),
    score: m.score,
  }));

  return (
    <>
      <p className="ic-sheet-sum muted">
        {[data.clt && `Classé ${data.clt}`, data.rangM && `rang mixte ${data.rangM}`, data.category && `catégorie ${data.category}`]
          .filter(Boolean)
          .join(" · ")}
      </p>
      <Bilan won={won} lost={lost} />
      <MatchList items={items} />
      <p className="ic-stats-note muted tiny">
        {data.source === "poule"
          ? "Matchs joués dans nos poules, lus sur les feuilles de rencontre. Sa fiche complète n'a pas pu être lue."
          : data.fetchedAt
            ? `Fiche relevée sur squashnet le ${releve(data.fetchedAt)}.`
            : null}
        {relecture && " Mise à jour…"}
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
//  Les deux fenêtres.
// ---------------------------------------------------------------------------

export default function InterclubTeamSheet({
  snTeamId,
  name,
  onClose,
  onExpired,
}: {
  snTeamId: string;
  name: string;
  onClose: () => void;
  onExpired: (status: number) => boolean;
}) {
  const [pile, setPile] = useState<Vue[]>([{ kind: "team", snTeamId, name, tab: "ties" }]);
  const cache = useRef(new Map<string, unknown>()).current;
  const titre = useRef<HTMLHeadingElement>(null);
  const vue = pile[pile.length - 1];

  // LE FOCUS SUIT LA VUE : sans cela, un lecteur d'écran resterait sur un bouton qui n'existe
  // plus. Pas au montage — la modale pose déjà le sien (cf. `useDialog`).
  const profondeur = useRef(pile.length);
  useEffect(() => {
    if (profondeur.current !== pile.length) titre.current?.focus();
    profondeur.current = pile.length;
  }, [pile.length]);

  const push = (v: Vue) => setPile((p) => [...p, v]);
  const back = pile.length > 1 ? () => setPile((p) => p.slice(0, -1)) : null;

  const intitule =
    vue.kind === "team" ? vue.name : vue.kind === "player" ? vue.name : `${vue.tie.round} · ${jour(vue.tie.date)}`;

  return (
    <Dialog onClose={onClose} label={`Fiche — ${intitule}`} className="ic-detail ic-sheet">
      <Entete titre={intitule} onBack={back} onClose={onClose} titreRef={titre} />
      {vue.kind === "team" && (
        <VueEquipe
          key={`team-${vue.snTeamId}-${pile.length}`}
          vue={vue}
          cache={cache}
          onExpired={onExpired}
          onTab={(tab) => setPile((p) => [...p.slice(0, -1), { ...vue, tab }])}
          push={push}
        />
      )}
      {vue.kind === "tie" && <VueRencontre key={`tie-${pile.length}`} vue={vue} push={push} />}
      {vue.kind === "player" && (
        <VueJoueur key={`player-${vue.regiid}-${pile.length}`} vue={vue} cache={cache} onExpired={onExpired} />
      )}
    </Dialog>
  );
}

/**
 * LES MATCHS D'UN JOUEUR DU CLUB, depuis le tableau des statistiques.
 *
 * Aucune requête : la liste voyage avec le palmarès (`PlayerStatRow.matches`), calculée dans la
 * même boucle et sous les mêmes règles. L'en-tête reprend donc mot pour mot la ligne touchée.
 */
export function StatPlayerDialog({ row, onClose }: { row: PlayerStatRow; onClose: () => void }) {
  // `?? []` : pendant un déploiement, l'écran peut recevoir le palmarès d'un serveur qui ne
  // joint pas encore les matchs. Une fenêtre vide vaut mieux qu'un écran qui lève.
  const items: MatchItem[] = (row.matches ?? []).map((m, i) => ({
    key: `${m.date}-${m.label}-${i}`,
    date: m.date,
    won: m.won,
    opponentName: m.opponentName,
    opponentClt: m.opponentClt,
    opponentTeam: m.opponentTeam,
    context: [m.teamName, m.label].filter(Boolean).join(" · ") || null,
    score: m.score,
  }));
  return (
    <Dialog onClose={onClose} label={`Matchs de ${row.name}`} className="ic-detail ic-sheet">
      <Entete titre={row.name} onBack={null} onClose={onClose} />
      <Bilan won={row.won} lost={row.lost} />
      <MatchList items={items} />
      <p className="ic-stats-note muted tiny">Source : feuilles de match publiées sur squashnet.</p>
    </Dialog>
  );
}
