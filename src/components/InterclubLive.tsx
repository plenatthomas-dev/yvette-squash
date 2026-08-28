"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { readOk } from "@/lib/apiFetch";
import { onForeground } from "@/lib/onForeground";
import { resolveColor, FOLLOW_LABELS, FOLLOW_LEVELS, type FollowLevel } from "@/lib/interclub";
import { ensurePushSubscribed, pushEnabledOnServer, pushSupported } from "@/lib/pushClient";

// Suivi en direct, pour ceux qui ne sont pas sur place.
//
// LE POLLING EST LA PARTIE DÉLICATE. `PRODUCT.md` proscrit le polling agressif, et une soirée
// dure deux heures. Trois garde-fous, dans cet ordre d'importance :
//   1. on n'interroge QUE s'il y a quelque chose à voir aujourd'hui ;
//   2. on n'interroge QUE si l'onglet est visible — un téléphone en poche ne coûte rien ;
//   3. côté serveur, la requête lourde vient du Data Cache (cf. interclub-gate) : seule la
//      lecture de session subsiste par sondage.
//
// ⚠️ Le garde-fou n°1 a longtemps été FAUX, et c'est le plus coûteux des trois à manquer. Il
// annonçait « on n'interroge que si une rencontre est en cours » alors que le sondage de veille
// tournait INDÉFINIMENT, à raison d'un appel par minute. Un membre qui laissait l'onglet ouvert
// un dimanche après-midi payait une lecture de session par minute pendant des heures — de quoi
// empêcher à lui seul le scale-to-zero de Neon (5 min d'inactivité), hors de la fenêtre où
// `docs/neon-keep-alive.md` réveille délibérément la base.
//
// La formulation juste est « s'il y a quelque chose à voir » : le serveur ne renvoie que les
// rencontres du jour et celles restées en direct (cf. interclub-gate). Si cette liste est vide,
// ou si tout y est terminé, RIEN ne peut plus bouger d'ici la fin de la journée : on arrête le
// sondage et on s'en remet au retour au premier plan, qui est de toute façon le geste par
// lequel on demande « montre-moi où ça en est ».
const POLL_MS = 10_000;
/**
 * Cadence de veille : une rencontre est prévue aujourd'hui mais n'a pas commencé. Il FAUT
 * continuer à sonder dans ce cas précis — `anyLive` se déduit du dernier chargement, donc ne
 * peut devenir vrai que par un chargement. Sans cela, un membre qui ouvre l'onglet avant le
 * premier point ne verrait jamais la rencontre démarrer.
 */
const IDLE_POLL_MS = 60_000;

type LiveMatch = {
  id: string;
  order: number;
  home: string;
  away: string;
  homeColor: string | null;
  awayColor: string | null;
  status: string;
  gamesHome: number | null;
  gamesAway: number | null;
  games: { home: number; away: number }[];
  live: { current: { home: number; away: number }; serving: "home" | "away" | null } | null;
};

type LiveFixture = {
  id: string;
  date: string;
  teamId: string;
  teamName: string;
  opponent: string;
  home: boolean;
  division: string | null;
  status: string;
  score: { home: number; away: number };
  matches: LiveMatch[];
};

type Team = { id: string; name: string };
type Follow = { teamId: string; level: FollowLevel };

/** Pourquoi les notifications ne peuvent pas arriver, le cas échéant. */
type PushBlock = null | "unsupported" | "server" | "denied";

function Dot({ color }: { color: string | null }) {
  const c = resolveColor(color);
  if (!c) return null;
  return <span className="ic-dot ic-dot-lg" style={{ background: c.bg, borderColor: c.fg }} />;
}

export default function InterclubLive({
  teams,
  toast,
  onExpired,
}: {
  teams: Team[];
  toast: (type: "ok" | "err" | "info", msg: string) => void;
  onExpired: (status: number) => boolean;
}) {
  const [fixtures, setFixtures] = useState<LiveFixture[] | null>(null);
  const [follows, setFollows] = useState<Follow[]>([]);
  const [pushReady, setPushReady] = useState<boolean | null>(null);
  const [denied, setDenied] = useState(false);
  /** Le dernier chargement a échoué : on ne conclut alors RIEN sur ce qu'il y a à voir. */
  const [failed, setFailed] = useState(false);
  const anyLive = (fixtures ?? []).some((f) => f.status === "live");
  const anyLiveRef = useRef(false);
  anyLiveRef.current = anyLive;

  // Y a-t-il encore quelque chose à attendre aujourd'hui ? `null` = on n'a pas encore chargé,
  // et il faut alors sonder pour le découvrir. Une liste vide, ou dont tout est terminé, ferme
  // le sujet jusqu'au prochain retour au premier plan.
  //
  // ⚠️ `failed` est indispensable : en cas d'échec réseau, `load` retombe sur une liste VIDE
  // pour ne pas bloquer l'affichage — ce qui, sans cette nuance, se lirait « rien à voir
  // aujourd'hui » et arrêterait le sondage pour toute la session. Une coupure de trois
  // secondes en début de soirée aurait éteint le direct jusqu'au prochain changement d'onglet.
  const somethingToWatch = fixtures === null || failed || fixtures.some((f) => f.status !== "done");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/interclub/live", { cache: "no-store" });
      if (onExpired(res.status)) return;
      const data = await readOk<{ fixtures: LiveFixture[] }>(res);
      setFixtures(data.fixtures);
      setFailed(false);
    } catch {
      // Silencieux : un direct qui ne se rafraîchit pas ne mérite pas d'interrompre la
      // lecture. Le prochain passage réessaiera — d'où `failed`, qui distingue « la journée
      // est finie » (on peut cesser de sonder) de « je n'ai pas réussi à savoir » (surtout pas).
      setFixtures((f) => f ?? []);
      setFailed(true);
    }
  }, [onExpired]);

  const loadFollows = useCallback(async () => {
    try {
      const res = await fetch("/api/interclub/follows", { cache: "no-store" });
      if (onExpired(res.status)) return;
      const data = await readOk<{ follows: Follow[]; pushReady: boolean }>(res);
      setFollows(data.follows);
      setPushReady(data.pushReady);
    } catch {
      /* les abonnements ne sont pas critiques à l'affichage */
    }
  }, [onExpired]);

  useEffect(() => {
    load();
    loadFollows();
  }, [load, loadFollows]);

  useEffect(() => {
    // Rien à voir aujourd'hui : AUCUN intervalle. C'est le cas le plus fréquent de loin — la
    // vue est ouverte un jour sans rencontre — et c'est celui qui coûtait le plus cher, parce
    // qu'il durait aussi longtemps que l'onglet restait ouvert.
    if (!somethingToWatch) return;

    // Sinon on sonde tant que l'onglet est visible, mais six fois moins vite tant que rien
    // n'est en cours : assez pour voir la rencontre démarrer, sans peser avant le premier point.
    let ticks = 0;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      ticks += 1;
      if (!anyLiveRef.current && ticks % (IDLE_POLL_MS / POLL_MS) !== 0) return;
      load();
    };
    const t = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(t);
  }, [load, somethingToWatch]);

  // Au retour sur l'onglet on rafraîchit tout de suite, en cours ou non : c'est le geste qui
  // exprime « montre-moi où ça en est ». Effet SÉPARÉ du sondage, et sans condition : c'est ce
  // qui rattrape une rencontre créée après le chargement, un jour où l'on avait justement
  // arrêté de sonder faute de quoi que ce soit à attendre.
  useEffect(() => onForeground(load), [load]);

  async function setFollow(teamId: string, level: FollowLevel | null) {
    // S'abonner sans avoir autorisé les notifications ne produirait rien : on demande la
    // permission au moment où le geste a du sens, pas au chargement de la page.
    if (level && pushSupported() && pushEnabledOnServer()) {
      const ok = await ensurePushSubscribed();
      setDenied(!ok);
      if (!ok) {
        toast("info", "Notifications refusées par le navigateur — l'abonnement reste sans effet.");
      }
    }
    try {
      const res = await fetch("/api/interclub/follows", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamId, level }),
      });
      if (onExpired(res.status)) return;
      await readOk(res);
      setFollows((prev) => {
        const rest = prev.filter((f) => f.teamId !== teamId);
        return level ? [...rest, { teamId, level }] : rest;
      });
      // On ne dit « enregistré » que si la notification peut RÉELLEMENT partir. L'abonnement
      // est bien stocké dans les deux cas — il servira dès que l'obstacle sera levé — mais le
      // dire sans réserve laissait attendre des notifications qui ne viendraient jamais.
      if (!level) toast("ok", "Abonnement retiré");
      else if (block) toast("info", "Abonnement enregistré, mais les notifications ne peuvent pas encore arriver.");
      else toast("ok", "Abonnement enregistré");
    } catch (e) {
      toast("err", (e as Error).message);
    }
  }

  const levelOf = (teamId: string) => follows.find((f) => f.teamId === teamId)?.level ?? "";

  // Un seul obstacle est signalé à la fois, du plus général au plus personnel : inutile de
  // parler de permission navigateur si le serveur n'a de toute façon pas de quoi envoyer.
  const block: PushBlock = !pushSupported()
    ? "unsupported"
    : pushReady === false
      ? "server"
      : denied
        ? "denied"
        : null;

  const BLOCK_TEXT: Record<NonNullable<PushBlock>, string> = {
    unsupported:
      "Ce navigateur ne gère pas les notifications — sur iPhone, il faut d'abord ajouter l'appli à l'écran d'accueil. Le suivi reste consultable ici.",
    server:
      "Les notifications ne sont pas configurées sur cet environnement (clés VAPID absentes). L'abonnement est enregistré et servira dès qu'elles le seront.",
    denied:
      "Les notifications sont bloquées pour ce site dans les réglages du navigateur. L'abonnement est enregistré et servira une fois l'autorisation donnée.",
  };

  return (
    <section className="ic-live">
      <h4 className="ic-live-title">En direct</h4>

      {fixtures === null ? (
        <p className="muted tiny">Chargement…</p>
      ) : fixtures.length === 0 ? (
        <p className="muted tiny">Aucune rencontre aujourd&apos;hui.</p>
      ) : (
        fixtures.map((f) => (
          <article key={f.id} className="ic-live-card">
            <header className="ic-live-head">
              <span>
                {f.teamName} {f.home ? "reçoit" : "chez"} {f.opponent}
              </span>
              <span className="ic-live-score">
                {f.score.home}–{f.score.away}
              </span>
            </header>
            <ul className="ic-live-matches">
              {f.matches.map((m) => (
                <li key={m.id}>
                  <span className="ic-order">#{m.order}</span>
                  <span className="ic-player">
                    <Dot color={m.homeColor} />
                    {m.home}
                  </span>
                  <span className="ic-versus" title="contre">
                    <span className="sr-only">contre</span>
                    <span aria-hidden="true">c.</span>
                  </span>
                  <span className="ic-player">
                    <Dot color={m.awayColor} />
                    {m.away}
                  </span>
                  <span className="ic-games">
                    {m.live ? (
                      <span className="ic-inplay">
                        {m.live.current.home}–{m.live.current.away}
                      </span>
                    ) : null}
                    {m.gamesHome !== null ? (
                      <span className="ic-gamescore">
                        {m.gamesHome}–{m.gamesAway}
                      </span>
                    ) : !m.live ? (
                      <span className="muted tiny">—</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </article>
        ))
      )}

      {/* Abonnement : opt-in franc, aucune ligne par défaut. Le dosage est le vrai sujet —
          une notification par échange, c'est ~800 par soirée. */}
      <div className="ic-follow">
        <h4 className="ic-live-title">Être prévenu</h4>
        {teams.map((t) => (
          <label key={t.id} className="ic-follow-row">
            <span>{t.name}</span>
            <select
              value={levelOf(t.id)}
              onChange={(e) => setFollow(t.id, (e.target.value || null) as FollowLevel | null)}
            >
              <option value="">Ne pas suivre</option>
              {FOLLOW_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {FOLLOW_LABELS[l]}
                </option>
              ))}
            </select>
          </label>
        ))}
        {block && (
          <p className="notice tiny" role="status">
            {BLOCK_TEXT[block]}
          </p>
        )}
      </div>
    </section>
  );
}
