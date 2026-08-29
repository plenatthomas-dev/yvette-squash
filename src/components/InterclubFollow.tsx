"use client";

// Abonnement au suivi d'une équipe — extrait de `InterclubLive`.
//
// Ces réglages n'ont rien à voir avec le direct : ils décident de ce qu'on recevra ce soir, ou
// dans trois semaines. Les laisser SOUS la liste des rencontres du jour les rendait
// introuvables — au point qu'on pouvait se croire abonné sans l'être. Ils ouvrent donc la page
// interclub, avant même la création d'une rencontre.
//
// LE VRAI SUJET EST LE DOSAGE, pas la technique : une notification par échange, c'est ~800 par
// soirée, et une fonction qu'on désactive ne resservira jamais. D'où trois paliers, et AUCUN par
// défaut — l'absence de ligne en base est l'état initial (opt-in franc, cf. /api/interclub/follows).

import { useCallback, useEffect, useState } from "react";
import { readOk } from "@/lib/apiFetch";
import { FOLLOW_LABELS, FOLLOW_LEVELS, type FollowLevel } from "@/lib/interclub";
import { ensurePushSubscribed, pushEnabledOnServer, pushSupported } from "@/lib/pushClient";

type Team = { id: string; name: string };
type Follow = { teamId: string; level: FollowLevel };

/** Pourquoi les notifications ne peuvent pas arriver, le cas échéant. */
type PushBlock = null | "unsupported" | "server" | "denied";

export default function InterclubFollow({
  teams,
  toast,
  onExpired,
}: {
  teams: Team[];
  toast: (type: "ok" | "err" | "info", msg: string) => void;
  onExpired: (status: number) => boolean;
}) {
  // `null` = on ne SAIT pas encore, et c'est différent de « aucun abonnement » ([]). Les deux
  // s'affichaient jadis de la même façon — « Ne pas suivre » — donc le sélecteur affirmait un
  // état qu'il n'avait pas vérifié. Dans ce sens-là c'est déjà faux (un abonné se voit
  // « Ne pas suivre » le temps du chargement) ; dans l'autre c'est pire : sans jamais de second
  // rendu, rien ne venait corriger la valeur que le navigateur restaure tout seul dans un
  // <select> au rechargement. D'où l'écran qui promettait « Détaillé » à un compte dont la base
  // ne contenait aucune ligne — abonnement fantôme, et aucune notification.
  const [follows, setFollows] = useState<Follow[] | null>(null);
  /** La lecture des abonnements a échoué : on ne prétend alors rien sur leur état. */
  const [followsFailed, setFollowsFailed] = useState(false);
  const [pushReady, setPushReady] = useState<boolean | null>(null);
  const [denied, setDenied] = useState(false);

  const loadFollows = useCallback(async () => {
    try {
      const res = await fetch("/api/interclub/follows", { cache: "no-store" });
      if (onExpired(res.status)) return;
      const data = await readOk<{ follows: Follow[]; pushReady: boolean }>(res);
      setFollows(data.follows);
      setPushReady(data.pushReady);
      setFollowsFailed(false);
    } catch {
      // On ne retombe SURTOUT pas sur une liste vide : ce serait annoncer « tu n'es abonné à
      // rien » à quelqu'un qui l'est, sur la foi d'une requête qui n'a pas abouti. On le dit,
      // et on laisse le choix de réessayer.
      setFollowsFailed(true);
    }
  }, [onExpired]);

  useEffect(() => {
    loadFollows();
  }, [loadFollows]);

  async function setFollow(teamId: string, level: FollowLevel | null) {
    // Le refus constaté À L'INSTANT, et non `block`, qui date du rendu courant : `setDenied`
    // ci-dessous ne sera visible que du rendu SUIVANT, et l'interaction qui découvre le refus
    // annonçait donc « Abonnement enregistré » sans la réserve qu'elle venait pourtant d'établir.
    let blockedNow = block !== null;
    // S'abonner sans avoir autorisé les notifications ne produirait rien : on demande la
    // permission au moment où le geste a du sens, pas au chargement de la page.
    if (level && pushSupported() && pushEnabledOnServer()) {
      // ⚠️ `ensurePushSubscribed` PEUT JETER, et son échec ne doit pas emporter l'écriture.
      //
      // `serviceWorker.register`, `pushManager.subscribe` (`InvalidStateError` sur un
      // abonnement déjà posé avec une autre clé VAPID, refus du système) et le `fetch` qu'elle
      // termine rejettent tous les trois. Appelée hors du `try`, elle sortait alors de cette
      // fonction par une promesse rejetée : le PUT ne partait jamais, aucun toast ne
      // s'affichait, aucun état ne changeait — donc aucun rendu, et le `<select>` gardait
      // visuellement le niveau choisi. C'est MOT POUR MOT l'abonnement fantôme que l'en-tête
      // de ce fichier dit avoir corrigé, reproduit par l'autre bout.
      //
      // Une exception n'est ici qu'une façon de plus de ne pas être abonné : on la traite
      // comme un `false`, et l'écriture serveur suit son cours — la ligne d'abonnement vaut
      // d'être posée, elle servira dès que l'obstacle sera levé.
      const ok = await ensurePushSubscribed().catch(() => false);
      setDenied(!ok);
      // Un seul toast par geste : le refus se dit dans le message de fin, qui porte déjà la
      // réserve, et l'encart persistant sous la liste (`block`) le rappelle ensuite tant qu'il
      // dure. Deux toasts coup sur coup pour un même fait n'apprenaient rien de plus.
      if (!ok) blockedNow = true;
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
        const rest = (prev ?? []).filter((f) => f.teamId !== teamId);
        return level ? [...rest, { teamId, level }] : rest;
      });
      // On ne dit « enregistré » que si la notification peut RÉELLEMENT partir. L'abonnement
      // est bien stocké dans les deux cas — il servira dès que l'obstacle sera levé — mais le
      // dire sans réserve laissait attendre des notifications qui ne viendraient jamais.
      if (!level) toast("ok", "Abonnement retiré");
      else if (blockedNow) toast("info", "Abonnement enregistré, mais les notifications ne peuvent pas encore arriver.");
      else toast("ok", "Abonnement enregistré");
    } catch (e) {
      toast("err", (e as Error).message);
    }
  }

  const levelOf = (teamId: string) => (follows ?? []).find((f) => f.teamId === teamId)?.level ?? "";

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

  // Aucune équipe : rien à suivre, et un panneau vide en tête de page n'apprendrait rien.
  if (teams.length === 0) return null;

  return (
    <div className="ic-follow">
      <h4 className="ic-follow-title">Être prévenu</h4>
      {teams.map((t) => (
        <label key={t.id} className="ic-follow-row">
          <span>{t.name}</span>
          <select
            value={levelOf(t.id)}
            disabled={follows === null}
            // Le navigateur restaure de lui-même la position d'un <select> au rechargement.
            // React ne la corrige qu'au rendu suivant — qui n'arrive jamais quand l'état ne
            // change pas, c'est-à-dire précisément dans le cas « aucun abonnement ».
            autoComplete="off"
            onChange={(e) => setFollow(t.id, (e.target.value || null) as FollowLevel | null)}
          >
            {/* Le libellé de la position neutre CHANGE une fois la réponse arrivée : c'est ce
                qui garantit un second rendu, donc la remise à la bonne valeur, même quand le
                membre n'est abonné à rien. */}
            <option value="">{follows === null ? "…" : "Ne pas suivre"}</option>
            {FOLLOW_LEVELS.map((l) => (
              <option key={l} value={l}>
                {FOLLOW_LABELS[l]}
              </option>
            ))}
          </select>
        </label>
      ))}
      {followsFailed && (
        <p className="notice tiny" role="status">
          Impossible de lire tes abonnements — ce qui s&apos;affiche ici peut être faux.{" "}
          <button type="button" className="secondary ic-follow-retry" onClick={loadFollows}>
            Réessayer
          </button>
        </p>
      )}
      {block && (
        <p className="notice tiny" role="status">
          {BLOCK_TEXT[block]}
        </p>
      )}
    </div>
  );
}
