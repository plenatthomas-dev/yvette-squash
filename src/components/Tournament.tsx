"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "@/components/Dialog";
import { MIN_PLAYERS, MAX_PLAYERS } from "@/lib/tournament";
import { fetchDirectory } from "@/lib/directoryCache";

// Vue « Tournoi » : liste des tournois, assistant de création (roster annuaire + invités,
// cible de matchs) → proposition de formule → génération, puis suivi (poules/tableau,
// liste des matchs par terrain, saisie des scores). Montants/scores en JEUX.

interface Member {
  id: string;
  name: string;
  clt?: string; // classement fédéral (si le flag `ranking` est actif + rapprochement sûr)
  rang?: number | null; // rang national (tri des têtes de série)
  cat?: string | null; // catégorie d'âge (info-bulle)
}
interface PlayerRef {
  id: string;
  name: string;
}
interface MatchView {
  id: string | null;
  p1: PlayerRef | null;
  p2: PlayerRef | null;
  score1: number | null;
  score2: number | null;
  winnerId: string | null;
  status: "pending" | "bye" | "done";
  terrain: string | null;
  order: number | null;
  round?: number;
  slot?: number;
  branch?: string;
  phase?: string;
  placeLabel?: string | null;
  rankLow?: number; // bande de places décidée par le sous-tableau (titre des groupes)
  rankHigh?: number;
  stage?: string;
}
interface StandingView {
  playerId: string;
  name: string;
  rank: number;
  played: number;
  wins: number;
  losses: number;
  gamesFor: number;
  gamesAgainst: number;
  gameDiff: number;
  points: number;
}
interface PoolView {
  label: string;
  matches: MatchView[];
  standings: StandingView[];
}
interface Detail {
  id: string;
  name: string | null;
  date: string;
  status: "draft" | "running" | "done";
  format: string;
  formatLabel: string;
  targetMatches: number;
  bestOf: number;
  courts: number;
  isCreator: boolean;
  isParticipant: boolean;
  players: { id: string; name: string; seed: number }[];
  pools: PoolView[] | null;
  bracket: {
    rounds: number;
    byes: number;
    ranking:
      | { playerId: string; name: string; rank: number; played: number; wins: number; losses: number }[]
      | null;
    matches: MatchView[];
  } | null;
  // Format « poules + tableau final » : un tableau par rang de poule (1ers, 2es…), résolu
  // en direct comme le tableau autonome. Null hors pools_bracket ou avant génération.
  finals:
    | {
        tier: number;
        title: string;
        rounds: number;
        byes: number;
        ranking:
          | { playerId: string; name: string; rank: number; played: number; wins: number; losses: number }[]
          | null;
        matches: MatchView[];
      }[]
    | null;
  // Vrai quand les poules sont finies et la phase finale pas encore générée (bouton créateur).
  canGenerateFinals: boolean;
  champion: PlayerRef | null;
}
interface ListItem {
  id: string;
  name: string | null;
  date: string;
  status: string;
  format: string;
  playerCount: number;
}
interface Proposal {
  kind: "pools" | "bracket" | "pools_bracket";
  label: string;
  matchesPerPlayer: { min: number; max: number };
  avgMatchesPerPlayer: number;
  totalMatches: number;
  producesChampion: boolean;
  fullRanking: boolean;
  estimatedMinutes: number;
  poolSizes?: number[];
  bracketByes?: number;
}

interface Props {
  toast: (type: "ok" | "err" | "info", msg: string) => void;
  onExpired: (status: number) => boolean;
}

function todayISO(): string {
  return new Date().toLocaleDateString("en-CA");
}

function prettyDate(date: string): string {
  return new Date(`${date}T12:00:00`).toLocaleDateString("fr-FR", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/** Lignes de score valides selon le format : bo3 → 2-0/2-1/… ; bo5 → 3-0/3-1/… */
function scorelines(bestOf: number): [number, number][] {
  const w = Math.ceil(bestOf / 2);
  const lines: [number, number][] = [];
  for (let k = w - 1; k >= 0; k--) lines.push([w, k]); // p1 gagne
  for (let k = 0; k < w; k++) lines.push([k, w]); // p2 gagne
  return lines;
}

const STATUS_LABEL: Record<string, string> = {
  draft: "Brouillon",
  running: "En cours",
  done: "Terminé",
};

export default function Tournament({ toast, onExpired }: Props) {
  const [list, setList] = useState<ListItem[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  // Id du match dont on RÉ-ouvre la saisie pour corriger un score (faute de frappe).
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Assistant de création (1 roster, 2 têtes de série, 3 réglages, 4 formules)
  const [wizardOpen, setWizardOpen] = useState(false);
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [guests, setGuests] = useState<string[]>([]);
  const [guestInput, setGuestInput] = useState("");
  // Ordre des têtes de série (glisser-déposer / flèches) : le 1er = tête de série n°1.
  const [seeded, setSeeded] = useState<
    {
      key: string;
      label: string;
      userId: string | null;
      guestName: string | null;
      clt?: string | null;
      rang?: number | null;
      cat?: string | null;
    }[]
  >([]);
  const dragIndex = useRef<number | null>(null);
  const [name, setName] = useState("");
  const [date, setDate] = useState(todayISO());
  const [target, setTarget] = useState<2 | 3 | 4>(3);
  const [bestOf, setBestOf] = useState<3 | 5>(3);
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    const r = await fetch("/api/tournaments");
    if (onExpired(r.status)) return;
    const j = await r.json().catch(() => ({}));
    if (r.ok) setList(j.tournaments ?? []);
  }, [onExpired]);

  const loadDetail = useCallback(
    async (id: string) => {
      const r = await fetch(`/api/tournaments/${id}`);
      if (onExpired(r.status)) return;
      const j = await r.json().catch(() => ({}));
      if (r.ok) setDetail(j as Detail);
    },
    [onExpired],
  );

  useEffect(() => {
    loadList();
  }, [loadList]);
  useEffect(() => {
    if (openId) loadDetail(openId);
    else setDetail(null);
  }, [openId, loadDetail]);

  // Rafraîchissement multi-utilisateur : plusieurs personnes saisissent des scores en
  // parallèle. Au retour sur l'onglet (focus / redevenu visible), on recharge le tournoi
  // ouvert — sauf pendant une saisie (busy) pour ne pas écraser l'action en cours.
  const busyRef = useRef(busy);
  busyRef.current = busy;
  useEffect(() => {
    if (!openId) return;
    const refresh = () => {
      if (document.visibilityState === "visible" && !busyRef.current) loadDetail(openId);
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [openId, loadDetail]);

  const totalPlayers = picked.size + guests.length;

  const openWizard = async () => {
    setStep(1);
    setPicked(new Set());
    setGuests([]);
    setGuestInput("");
    setName("");
    setDate(todayISO());
    setTarget(3);
    setBestOf(3);
    setProposals(null);
    setDraftId(null);
    setSeeded([]);
    setWizardOpen(true);
    if (members === null) {
      // Cache mémoire partagé (cf. fetchDirectory) : dédupliqué avec la modale Annuaire
      // et le panneau Réglages. En cas d'échec réseau, on laisse `members` à null.
      try {
        setMembers(await fetchDirectory());
      } catch {
        /* on retentera à la prochaine ouverture du wizard */
      }
    }
  };

  const togglePick = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const addGuest = () => {
    const g = guestInput.trim();
    if (!g) return;
    if (totalPlayers >= MAX_PLAYERS) {
      toast("err", `Maximum ${MAX_PLAYERS} joueurs`);
      return;
    }
    setGuests((prev) => [...prev, g.slice(0, 40)]);
    setGuestInput("");
  };

  // Construit la liste ordonnée (têtes de série) à partir des joueurs choisis. ORDRE PAR
  // DÉFAUT = classement fédéral (rang national croissant = plus fort en tête), les membres
  // non classés puis les invités ensuite (ordre alpha). L'utilisateur ré-ordonne à la main.
  const buildSeeded = () => {
    const memberOf = (id: string) => members?.find((x) => x.id === id);
    const sortedIds = [...picked].sort((a, b) => {
      const ra = memberOf(a)?.rang ?? Infinity;
      const rb = memberOf(b)?.rang ?? Infinity;
      if (ra !== rb) return ra - rb;
      return (memberOf(a)?.name ?? "").localeCompare(memberOf(b)?.name ?? "", "fr", {
        sensitivity: "base",
      });
    });
    const memberItems = sortedIds.map((id) => ({
      key: `m${id}`,
      label: memberOf(id)?.name ?? "?",
      userId: id as string | null,
      guestName: null as string | null,
      clt: memberOf(id)?.clt ?? null,
      rang: memberOf(id)?.rang ?? null,
      cat: memberOf(id)?.cat ?? null,
    }));
    const guestItems = guests.map((g, i) => ({
      key: `g${i}`,
      label: g,
      userId: null as string | null,
      guestName: g as string | null,
      clt: null as string | null,
      rang: null as number | null,
      cat: null as string | null,
    }));
    setSeeded([...memberItems, ...guestItems]);
  };

  // Déplace une tête de série (flèches ou glisser-déposer).
  const moveSeed = (from: number, to: number) =>
    setSeeded((prev) => {
      if (to < 0 || to >= prev.length || from === to) return prev;
      const a = [...prev];
      const [x] = a.splice(from, 1);
      a.splice(to, 0, x);
      return a;
    });

  const fetchProposals = async () => {
    if (seeded.length < MIN_PLAYERS || seeded.length > MAX_PLAYERS) {
      toast("err", `Il faut de ${MIN_PLAYERS} à ${MAX_PLAYERS} joueurs`);
      return;
    }
    setBusy(true);
    try {
      // Ordre = têtes de série (seed = position dans la liste).
      const players = seeded.map((s) =>
        s.userId ? { userId: s.userId } : { guestName: s.guestName as string },
      );
      const res = await fetch("/api/tournaments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, date, targetMatches: target, bestOf, players }),
      });
      if (onExpired(res.status)) return;
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? `Erreur ${res.status}`);
      setDraftId(j.id);
      setProposals(j.proposals ?? []);
      setStep(4);
    } catch (e) {
      toast("err", "Impossible : " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const generate = async (p: Proposal) => {
    if (!draftId || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/tournaments/${draftId}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: p.kind, poolSizes: p.poolSizes }),
      });
      if (onExpired(res.status)) return;
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `Erreur ${res.status}`);
      toast("ok", "Tournoi lancé 🏆");
      setWizardOpen(false);
      await loadList();
      setOpenId(draftId);
    } catch (e) {
      toast("err", "Génération impossible : " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Génère la phase finale d'un pools_bracket (créateur, une fois les poules finies).
  const generateFinals = async () => {
    if (!openId || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/tournaments/${openId}/finals`, { method: "POST" });
      if (onExpired(res.status)) return;
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `Erreur ${res.status}`);
      toast("ok", "Phase finale générée 🏆");
      await loadDetail(openId);
    } catch (e) {
      toast("err", "Génération impossible : " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const enterScore = async (m: MatchView, g1: number, g2: number) => {
    if (!m.id || !openId || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/tournaments/${openId}/matches/${m.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ score1: g1, score2: g2 }),
      });
      if (onExpired(res.status)) return;
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? `Erreur ${res.status}`);
      setEditing(null); // sort du mode correction
      await loadDetail(openId);
    } catch (e) {
      toast("err", "Score refusé : " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    setConfirmDelete(false);
    if (!openId || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/tournaments/${openId}`, { method: "DELETE" });
      if (onExpired(res.status)) return;
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Erreur ${res.status}`);
      }
      toast("ok", "Tournoi supprimé");
      setOpenId(null);
      loadList();
    } catch (e) {
      toast("err", "Suppression impossible : " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // --- Rendu d'un match (corps réutilisé en liste ET dans l'arbre) ---
  const canScore = !!detail && (detail.isParticipant || detail.isCreator);

  // Contrôles de saisie d'un match, partagés liste/arbre :
  //  - match À JOUER : boutons de score (tout participant) ;
  //  - match DÉJÀ SAISI : bouton « ✏️ Corriger » (créateur seulement, comme le backend) qui
  //    ré-ouvre les boutons de score → permet de rattraper une faute de frappe.
  const scoreControls = (m: MatchView) => {
    if (!m.p1 || !m.p2 || !detail) return null;
    const done = m.status === "done";
    const canEnter = done ? detail.isCreator : m.status === "pending" && canScore;
    if (!canEnter) return null;
    const open = m.status === "pending" || editing === m.id;
    if (!open) {
      return (
        <button
          type="button"
          className="secondary trn-correct"
          disabled={busy}
          onClick={() => setEditing(m.id)}
        >
          ✏️ Corriger
        </button>
      );
    }
    return (
      <div className="trn-scorepick">
        {scorelines(detail.bestOf).map(([a, b]) => (
          <button
            key={`${a}-${b}`}
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => enterScore(m, a, b)}
            aria-label={`${m.p1!.name} ${a} - ${b} ${m.p2!.name}`}
          >
            {a}–{b}
          </button>
        ))}
        {done && (
          <button
            type="button"
            className="secondary trn-correct"
            disabled={busy}
            onClick={() => setEditing(null)}
          >
            Annuler
          </button>
        )}
      </div>
    );
  };
  const renderMatchBody = (m: MatchView) => {
    const done = m.status === "done";
    const bye = m.status === "bye";
    const p1 = m.p1?.name ?? "—";
    const p2 = m.p2?.name ?? "—";
    return (
      <>
        <div className="trn-match-head">
          {m.terrain && m.status === "pending" && (
            <span className="trn-terrain">{m.terrain}</span>
          )}
          {m.stage && <span className="trn-place">{m.stage}</span>}
        </div>
        <div className="trn-vs">
          <span className={done && m.winnerId === m.p1?.id ? "win" : ""}>{p1}</span>
          {bye ? (
            <em className="trn-bye">passe (bye)</em>
          ) : done ? (
            <strong className="trn-scoreval">
              {m.score1}–{m.score2}
            </strong>
          ) : (
            <span className="trn-vs-sep">vs</span>
          )}
          <span className={done && m.winnerId === m.p2?.id ? "win" : ""}>{p2}</span>
        </div>
        {scoreControls(m)}
      </>
    );
  };
  const renderMatch = (m: MatchView, key: string) => (
    <li key={key} className={"trn-match" + (m.status === "done" ? " done" : "")}>
      {renderMatchBody(m)}
    </li>
  );

  // Le tableau à repêchage est une RÉCURSION de sous-tableaux (principal + une bande de
  // classement par « chute » de perdants : 3e place, places 5-8, 9-16…). L'ancien rendu
  // aplatissait tous les perdants par tour → matchs de bandes différentes entremêlés.
  // Clé de groupe = branche jusqu'au 1er « L » inclus ; « M » (sans L) = tableau principal.
  const groupKeyOf = (branch: string): string => {
    // DERNIER « L » (et pas le 1er) : sépare CHAQUE chute de perdants en tableau distinct.
    // Ex. n=8 → 4 groupes : principal (M), 3e place (MWL), tableau des perdants/5-6 (ML),
    // finale 7-8 (MLL) — les deux derniers ne sont plus fondus ensemble.
    const i = branch.lastIndexOf("L");
    return i < 0 ? "M" : branch.slice(0, i + 1);
  };
  // Libellé de colonne par DISTANCE à la finale du (sous-)tableau (0 = finale).
  const roundLabel = (dist: number, main: boolean): string =>
    dist <= 0
      ? main
        ? "Finale"
        : "Finales"
      : dist === 1
        ? "Demi-finales"
        : dist === 2
          ? "Quarts de finale"
          : dist === 3
            ? "8es de finale"
            : dist === 4
              ? "16es de finale"
              : `Tour ${dist + 1} avant la fin`;

  // Un match dans l'arbre : adversaires EMPILÉS (l'un sous l'autre) + case de score
  // contrastée à droite (façon bracket). Le vainqueur est surligné.
  const renderTreeMatch = (m: MatchView) => {
    const done = m.status === "done";
    const bye = m.status === "bye";
    const p1 = m.p1?.name ?? "—";
    const p2 = m.p2?.name ?? "—";
    const w1 = done && m.winnerId != null && m.winnerId === m.p1?.id;
    const w2 = done && m.winnerId != null && m.winnerId === m.p2?.id;
    return (
      <>
        {m.terrain && m.status === "pending" && (
          <div className="trn-bkt-terrain">{m.terrain}</div>
        )}
        <div className={"trn-bkt-row" + (w1 ? " win" : "")}>
          <span className="trn-bkt-nm">{p1}</span>
          <span className="trn-bkt-sc">{done ? m.score1 : ""}</span>
        </div>
        <div className={"trn-bkt-row" + (w2 ? " win" : "")}>
          <span className="trn-bkt-nm">{bye ? <em>passe (bye)</em> : p2}</span>
          <span className="trn-bkt-sc">{done ? m.score2 : ""}</span>
        </div>
        {scoreControls(m)}
      </>
    );
  };

  // Un sous-tableau autonome = colonnes par tour, avec traits de liaison façon bracket.
  const renderBracketGroup = (ms: MatchView[], main: boolean, key: string) => {
    const rounds = [...new Set(ms.map((m) => m.round ?? 0))].sort((a, b) => a - b);
    const finalRound = rounds[rounds.length - 1];
    // Titre : le match « couronnant » du groupe porte déjà un placeLabel précis
    // (« Finale », « Petite finale (3e-4e place) », « Places 5-6 »…) — on le réutilise.
    const crowned = ms.find((m) => m.placeLabel);
    const rankLow = Math.min(...ms.map((m) => m.rankLow ?? 1));
    const rankHigh = Math.max(...ms.map((m) => m.rankHigh ?? 1));
    const title = main
      ? "Tableau principal"
      : crowned?.placeLabel
        ? crowned.placeLabel
        : rankHigh - rankLow === 1
          ? `Match pour la ${rankLow}ᵉ place`
          : `Places ${rankLow} à ${rankHigh}`;
    return (
      <div key={key} className={"trn-bkt-group" + (main ? " main" : "")}>
        <div className="trn-bkt-title">{title}</div>
        <div className="trn-tree">
          {rounds.map((r) => {
            const col = ms
              .filter((m) => m.round === r)
              .sort((a, c) => (a.slot ?? 0) - (c.slot ?? 0));
            return (
              <div key={r} className="trn-tree-col">
                <div className="trn-tree-col-title">{roundLabel(finalRound - r, main)}</div>
                <div className="trn-tree-col-body">
                  {col.map((m, i) => (
                    <div
                      key={i}
                      className={
                        "trn-bkt-match" +
                        (r > rounds[0] ? " linked" : "") +
                        (m.status === "done" ? " done" : "") +
                        (m.status === "bye" ? " bye" : "")
                      }
                    >
                      {renderTreeMatch(m)}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // Découpe TOUS les matchs de tableau en groupes triés : principal d'abord, puis par
  // meilleure place (3e place, 5-8, 9-16…).
  const bracketGroups = (ms: MatchView[]) => {
    const by = new Map<string, MatchView[]>();
    for (const m of ms) {
      const k = groupKeyOf(m.branch ?? "M");
      const arr = by.get(k);
      if (arr) arr.push(m);
      else by.set(k, [m]);
    }
    return [...by.entries()]
      .map(([key, list]) => ({
        key,
        main: key === "M",
        rankLow: Math.min(...list.map((m) => m.rankLow ?? 1)),
        list,
      }))
      .sort((a, b) => (a.main ? -1 : b.main ? 1 : a.rankLow - b.rankLow));
  };

  // Liste des matchs planifiés (par ordre de passage / terrain) — les prochains d'abord.
  // Mémoïsé : ne se recalcule que quand le tournoi change (et non à chaque rendu déclenché
  // par un toast, le refresh au focus, etc.), et n'est plus parcouru deux fois dans le JSX.
  const scheduleMatches = useMemo<MatchView[]>(() => {
    if (!detail) return [];
    const all = [
      ...(detail.pools?.flatMap((p) => p.matches) ?? []),
      ...(detail.bracket?.matches ?? []),
      ...(detail.finals?.flatMap((f) => f.matches) ?? []),
    ];
    return all
      .filter((m) => m.order !== null && m.status === "pending" && m.p1 && m.p2)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }, [detail]);

  return (
    <section className="tournament">
      {openId && detail ? (
        // --- Vue d'un tournoi ---
        <div>
          <div className="trn-detail-head">
            <button
              className="secondary"
              onClick={() => {
                setOpenId(null);
                loadList(); // rafraîchit les statuts (ex. « terminé ») dans la liste
              }}
            >
              ← Tournois
            </button>
            {detail.isCreator && (
              <button className="cancel" onClick={() => setConfirmDelete(true)} disabled={busy}>
                Supprimer
              </button>
            )}
          </div>
          <h2>
            🏆 {detail.name || `Tournoi du ${prettyDate(detail.date)}`}{" "}
            <small className="trn-count">· {detail.players.length} joueurs</small>{" "}
            <span className={"trn-status " + detail.status}>{STATUS_LABEL[detail.status]}</span>
          </h2>
          <p className="trn-formula muted tiny">
            Formule : <strong>{detail.formatLabel}</strong> ·{" "}
            {detail.bestOf === 5 ? "3 jeux gagnants" : "2 jeux gagnants"}
          </p>

          {detail.champion && (
            <p className="trn-champion">🥇 Vainqueur : <strong>{detail.champion.name}</strong></p>
          )}

          {/* Prochains matchs (planning des terrains) */}
          {scheduleMatches.length > 0 && (
            <section className="trn-block">
              <h3>📋 Prochains matchs</h3>
              <ul className="trn-schedule">
                {scheduleMatches
                  .slice(0, 6)
                  .map((m) => (
                    <li key={`sch-${m.id}`}>
                      {m.terrain && <span className="trn-terrain">{m.terrain}</span>}
                      <span>
                        {m.p1?.name} <span className="muted">vs</span> {m.p2?.name}
                      </span>
                    </li>
                  ))}
              </ul>
            </section>
          )}

          {/* Poules */}
          {detail.pools?.map((pool) => (
            <section key={pool.label} className="trn-block">
              <h3>Poule {pool.label}</h3>
              <table className="trn-standings">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Joueur</th>
                    <th title="Matchs joués">MJ</th>
                    <th title="Victoires">V</th>
                    <th title="Défaites">D</th>
                    <th>Jeux</th>
                  </tr>
                </thead>
                <tbody>
                  {pool.standings.map((s) => (
                    <tr key={s.playerId}>
                      <td>{s.rank}</td>
                      <td>{s.name}</td>
                      <td>{s.played}</td>
                      <td>{s.wins}</td>
                      <td>{s.losses}</td>
                      <td>
                        {s.gamesFor}/{s.gamesAgainst}
                        <span className="muted">
                          {" "}
                          ({s.gameDiff >= 0 ? "+" : ""}
                          {s.gameDiff})
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <ul className="trn-matches">
                {pool.matches.map((m, i) => renderMatch(m, `${pool.label}-${i}`))}
              </ul>
            </section>
          ))}

          {/* Phase finale (pools_bracket) : bouton créateur puis un tableau par rang de poule. */}
          {detail.canGenerateFinals && detail.isCreator && (
            <section className="trn-block">
              <button onClick={generateFinals} disabled={busy}>
                🏆 Générer la phase finale
              </button>
              <p className="muted tiny">
                Les poules sont terminées. Lance les tableaux par rang (les 1ers de chaque poule
                ensemble, les 2es ensemble…). Les participants sont figés au moment du clic.
              </p>
            </section>
          )}
          {detail.canGenerateFinals && !detail.isCreator && (
            <p className="muted tiny">
              Poules terminées — le créateur doit lancer la phase finale.
            </p>
          )}
          {detail.finals?.map((f) => (
            <section key={`tier-${f.tier}`} className="trn-block">
              <h3>{f.title}</h3>
              {f.ranking && (
                <table className="trn-standings">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Joueur</th>
                      <th title="Matchs joués">MJ</th>
                      <th title="Victoires">V</th>
                      <th title="Défaites">D</th>
                    </tr>
                  </thead>
                  <tbody>
                    {f.ranking.map((r) => (
                      <tr key={r.playerId}>
                        <td>{r.rank}</td>
                        <td>{r.name}</td>
                        <td>{r.played}</td>
                        <td>{r.wins}</td>
                        <td>{r.losses}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {bracketGroups(f.matches).map((g) =>
                renderBracketGroup(g.list, g.main, `${f.tier}-${g.key}`),
              )}
            </section>
          ))}

          {/* Tableau (bracket) : arbre graphique du chemin principal + repêchage */}
          {detail.bracket &&
            (() => {
              const b = detail.bracket!;
              return (
                <section className="trn-block">
                  <h3>Tableau</h3>
                  {b.ranking && (
                    <table className="trn-standings">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>Joueur</th>
                          <th title="Matchs joués">MJ</th>
                          <th title="Victoires">V</th>
                          <th title="Défaites">D</th>
                        </tr>
                      </thead>
                      <tbody>
                        {b.ranking.map((r) => (
                          <tr key={r.playerId}>
                            <td>{r.rank}</td>
                            <td>{r.name}</td>
                            <td>{r.played}</td>
                            <td>{r.wins}</td>
                            <td>{r.losses}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {/* Chaque bande de classement (principal, 3e place, 5-8…) = son propre
                      arbre titré, plus jamais entremêlée. */}
                  {bracketGroups(b.matches).map((g) =>
                    renderBracketGroup(g.list, g.main, g.key),
                  )}
                </section>
              );
            })()}
        </div>
      ) : (
        // --- Liste des tournois ---
        <div>
          <div className="trn-actions">
            <button onClick={openWizard} disabled={busy}>
              ➕ Nouveau tournoi
            </button>
          </div>
          {list === null ? (
            <p className="muted">Chargement…</p>
          ) : list.length === 0 ? (
            <p className="muted">Aucun tournoi. Crée le premier (6 à 16 joueurs).</p>
          ) : (
            <ul className="trn-list">
              {list.map((t) => (
                <li key={t.id}>
                  <button className="trn-list-item" onClick={() => setOpenId(t.id)}>
                    <strong>{t.name || `Tournoi du ${prettyDate(t.date)}`}</strong>
                    <small className="trn-count">
                      {t.playerCount} joueurs ·{" "}
                      <span className={"trn-status " + t.status}>
                        {STATUS_LABEL[t.status] ?? t.status}
                      </span>
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Assistant de création */}
      {wizardOpen && (
        <Dialog onClose={() => !busy && setWizardOpen(false)} closeOnOverlay={!busy} label="Nouveau tournoi" className="trn-wizard">
          <h3>➕ Nouveau tournoi</h3>

          {step === 1 && (
            <>
              <p className="muted tiny">
                Choisis les joueurs ({totalPlayers}/{MAX_PLAYERS}) — membres et/ou invités.
              </p>
              <div className="trn-roster">
                {members?.map((m) => (
                  <label key={m.id} className={"trn-check" + (picked.has(m.id) ? " on" : "")}>
                    <input
                      type="checkbox"
                      checked={picked.has(m.id)}
                      onChange={() => togglePick(m.id)}
                    />
                    {m.name}
                  </label>
                ))}
              </div>
              {guests.length > 0 && (
                <ul className="trn-guests">
                  {guests.map((g, i) => (
                    <li key={i}>
                      {g}
                      <button
                        type="button"
                        className="cancel"
                        onClick={() => setGuests((prev) => prev.filter((_, j) => j !== i))}
                        aria-label={`Retirer ${g}`}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="trn-guest-add">
                <input
                  type="text"
                  placeholder="Ajouter un invité (prénom)"
                  value={guestInput}
                  maxLength={40}
                  onChange={(e) => setGuestInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addGuest();
                    }
                  }}
                />
                <button type="button" className="secondary" onClick={addGuest}>
                  +
                </button>
              </div>
              <div className="modal-actions">
                <button type="button" className="secondary" onClick={() => setWizardOpen(false)}>
                  Annuler
                </button>
                <button
                  type="button"
                  onClick={() => {
                    buildSeeded();
                    setStep(2);
                  }}
                  disabled={totalPlayers < MIN_PLAYERS || totalPlayers > MAX_PLAYERS}
                >
                  Suivant
                </button>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <p className="muted tiny">
                Classe les joueurs du plus fort (n°1) au plus faible — glisse-les ou utilise les
                flèches. Ça crée les têtes de série : en poules le 1 et le 2 sont séparés ; en
                tableau le 1 rencontre le dernier, et le 1/4 (puis 2/3) peuvent se croiser en demie.
                {seeded.some((s) => s.clt) && " Ordre pré-rempli d'après le classement fédéral."}
              </p>
              <ol className="trn-seedlist">
                {seeded.map((s, i) => (
                  <li
                    key={s.key}
                    draggable
                    onDragStart={() => (dragIndex.current = i)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      if (dragIndex.current !== null) moveSeed(dragIndex.current, i);
                      dragIndex.current = null;
                    }}
                  >
                    <span className="trn-seed-num">{i + 1}</span>
                    <span className="trn-seed-name">{s.label}</span>
                    {s.clt && (
                      <span
                        className="trn-seed-clt"
                        title={
                          "Classement fédéral" +
                          (s.rang ? ` · rang national ${s.rang}` : "") +
                          (s.cat ? ` · ${s.cat}` : "")
                        }
                      >
                        {s.clt}
                      </span>
                    )}
                    <span className="trn-seed-arrows">
                      <button
                        type="button"
                        className="secondary"
                        disabled={i === 0}
                        onClick={() => moveSeed(i, i - 1)}
                        aria-label={`Monter ${s.label}`}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={i === seeded.length - 1}
                        onClick={() => moveSeed(i, i + 1)}
                        aria-label={`Descendre ${s.label}`}
                      >
                        ↓
                      </button>
                    </span>
                  </li>
                ))}
              </ol>
              <div className="modal-actions">
                <button type="button" className="secondary" onClick={() => setStep(1)}>
                  Retour
                </button>
                <button type="button" onClick={() => setStep(3)}>
                  Suivant
                </button>
              </div>
            </>
          )}

          {step === 3 && (
            <>
              <label className="tri-field">
                Nom (optionnel)
                <input
                  type="text"
                  value={name}
                  maxLength={80}
                  placeholder="ex. Tournoi de printemps"
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label className="tri-field">
                Jour
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
              </label>
              <fieldset className="trn-choice">
                <legend>Matchs par joueur (environ)</legend>
                {[2, 3, 4].map((t) => (
                  <button
                    key={t}
                    type="button"
                    className={target === t ? "on" : ""}
                    onClick={() => setTarget(t as 2 | 3 | 4)}
                  >
                    {t}
                  </button>
                ))}
              </fieldset>
              <fieldset className="trn-choice">
                <legend>Format d'un match</legend>
                <button
                  type="button"
                  className={bestOf === 3 ? "on" : ""}
                  onClick={() => setBestOf(3)}
                >
                  2 jeux gagnants
                </button>
                <button
                  type="button"
                  className={bestOf === 5 ? "on" : ""}
                  onClick={() => setBestOf(5)}
                >
                  3 jeux gagnants
                </button>
              </fieldset>
              <div className="modal-actions">
                <button type="button" className="secondary" onClick={() => setStep(2)}>
                  Retour
                </button>
                <button type="button" onClick={fetchProposals} disabled={busy}>
                  {busy ? "…" : "Voir les formules"}
                </button>
              </div>
            </>
          )}

          {step === 4 && proposals && (
            <>
              <p className="muted tiny">Choisis une formule ({seeded.length} joueurs) :</p>
              <ul className="trn-proposals">
                {proposals.map((p, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      className="trn-proposal"
                      disabled={busy}
                      onClick={() => generate(p)}
                    >
                      <strong>
                        {p.label}
                        {p.kind === "pools_bracket" && " 🏆"}
                      </strong>
                      <small>
                        {p.matchesPerPlayer.min === p.matchesPerPlayer.max
                          ? `${p.matchesPerPlayer.min} matchs/joueur`
                          : `${p.matchesPerPlayer.min}–${p.matchesPerPlayer.max} matchs/joueur`}{" "}
                        · ~{p.estimatedMinutes} min
                        {p.kind === "pools_bracket"
                          ? " · poules puis phase finale à élimination"
                          : p.fullRanking
                            ? " · classement complet"
                            : ""}
                      </small>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="modal-actions">
                <button type="button" className="secondary" onClick={() => setStep(3)}>
                  Retour
                </button>
              </div>
            </>
          )}
        </Dialog>
      )}

      {confirmDelete && (
        <Dialog onClose={() => setConfirmDelete(false)} label="Supprimer le tournoi">
          <h3>Supprimer ce tournoi ?</h3>
          <p className="muted tiny">Tous les matchs et résultats seront effacés.</p>
          <div className="modal-actions">
            <button className="secondary" onClick={() => setConfirmDelete(false)}>
              Garder
            </button>
            <button className="danger" onClick={doDelete}>
              Supprimer
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
