"use client";

import { useCallback, useEffect, useState } from "react";
import { readOk } from "@/lib/apiFetch";
import { countProblems, type CheckReport, type PlayerCheck } from "@/lib/captain-check";

// ============================================================================
//  L'ESPACE CAPITAINE — vérifier une rencontre avant de la saisir chez la ligue.
//
//  CE QU'IL RÉPOND, ET QUE RIEN NE RÉPONDAIT : « qu'est-ce qui va coincer quand
//  j'ouvrirai squashnet ? ». Le score officiel ne se publie pas tout seul — un
//  capitaine le saisit chez la fédération, l'autre le valide —, et le formulaire
//  exige les joueurs tels que la FÉDÉRATION les orthographie. Un nom introuvable
//  se découvre sinon devant ce formulaire, un dimanche soir, sans personne à qui
//  demander.
//
//  TROIS PARTIS PRIS D'ÉCRAN :
//
//   1. ON NE VÉRIFIE PAS TOUT SEUL. La vérification coûte huit recherches chez
//      un site associatif : elle part sur un geste explicite, jamais à
//      l'ouverture. Le dernier rapport, lui, se relit gratuitement.
//   2. CE QUI VA BIEN SE TAIT. L'écran met en avant ce qu'il reste à régler ;
//      les lignes vertes se replient. Une checklist où tout crie ne se lit plus.
//   3. CHAQUE PROBLÈME PORTE SON REMÈDE, en toutes lettres et à côté de lui.
//      « Introuvable » sans la suite renvoie chercher au mauvais endroit — et le
//      bon endroit, ici, est presque toujours l'orthographe.
//
//  Un composant À PART, et non un sixième écran dans `Interclub.tsx` : celui-ci
//  fait déjà ~1730 lignes pour cinq écrans, et `docs/interclub.md` dit que « le
//  découpage n'est plus une éventualité ».
// ============================================================================

interface Fixture {
  id: string;
  date: string;
  time: string | null;
  round: string | null;
  opponent: string;
  home: boolean;
  status: string;
  teamId: string;
  teamName: string | null;
  matchCount: number;
  checkedAt: string | null;
  /** Nombre de points à régler au dernier passage. `null` = jamais vérifiée. */
  problems: number | null;
}

type Liste = { teams: { id: string; name: string }[]; fixtures: Fixture[] };

const jour = (d: string) =>
  new Date(`${d}T12:00:00`).toLocaleDateString("fr-FR", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });

const quand = (iso: string) =>
  new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });

/** Le camp d'une ligne de joueur, dit comme le capitaine le dirait. */
const camp = (p: PlayerCheck) => (p.side === "home" ? "nous" : "eux");

export default function Captain({
  toast,
  onExpired,
}: {
  toast: (type: "ok" | "err" | "info", msg: string) => void;
  onExpired: (status: number) => boolean;
}) {
  const [liste, setListe] = useState<Liste | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [ouverte, setOuverte] = useState<Fixture | null>(null);
  const [rapport, setRapport] = useState<CheckReport | null>(null);
  const [busy, setBusy] = useState(false);
  /** Les simples déjà réglés qu'on a rouverts à la main (cf. parti pris n°2). */
  const [deplies, setDeplies] = useState<number[]>([]);

  const charger = useCallback(async () => {
    try {
      const res = await fetch("/api/captain", { cache: "no-store" });
      if (onExpired(res.status)) return;
      setListe(await readOk<Liste>(res));
    } catch (e) {
      // Le silence serait indiscernable d'un capitaine sans aucune rencontre.
      setErreur((e as Error).message);
      setListe({ teams: [], fixtures: [] });
    }
  }, [onExpired]);

  useEffect(() => {
    void charger();
  }, [charger]);

  /** Ouvre une rencontre et relit son dernier rapport — sans toucher à squashnet. */
  const ouvrir = async (f: Fixture) => {
    setOuverte(f);
    setRapport(null);
    setDeplies([]);
    try {
      const res = await fetch(`/api/captain/check/${f.id}`, { cache: "no-store" });
      if (onExpired(res.status)) return;
      const { report } = await readOk<{ report: CheckReport | null }>(res);
      setRapport(report);
    } catch {
      // Pas de rapport lisible : l'écran propose simplement de vérifier. Rien à annoncer.
      setRapport(null);
    }
  };

  const verifier = async () => {
    if (!ouverte) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/captain/check/${ouverte.id}`, { method: "POST" });
      if (onExpired(res.status)) return;
      const { report } = await readOk<{ report: CheckReport }>(res);
      setRapport(report);
      setDeplies([]);
      const n = countProblems(report);
      toast(
        n === 0 ? "ok" : "info",
        n === 0
          ? "Rien à signaler : la rencontre peut être saisie."
          : `${n} point${n > 1 ? "s" : ""} à régler avant la saisie.`,
      );
      void charger(); // la pastille de la liste doit suivre
    } catch (e) {
      toast("err", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (liste === null) return <p className="muted tiny">Chargement…</p>;

  // --- Le détail d'une rencontre ------------------------------------------
  if (ouverte) {
    const n = rapport === null ? null : countProblems(rapport);
    const parSimple = new Map<number, PlayerCheck[]>();
    for (const p of rapport?.players ?? []) {
      parSimple.set(p.order, [...(parSimple.get(p.order) ?? []), p]);
    }

    return (
      <section className="cap">
        <button className="secondary cap-retour" onClick={() => setOuverte(null)}>
          ← Toutes mes rencontres
        </button>

        <h3 className="cap-titre">
          {ouverte.home ? "Réception" : "Déplacement"} · {ouverte.opponent}
        </h3>
        <p className="muted tiny">
          {ouverte.round ? `${ouverte.round} · ` : ""}
          {jour(ouverte.date)}
          {ouverte.teamName ? ` · ${ouverte.teamName}` : ""}
        </p>

        <button type="button" disabled={busy} onClick={verifier}>
          {busy ? "Vérification… (jusqu'à 10 s)" : rapport ? "Revérifier" : "Vérifier la rencontre"}
        </button>
        <p className="muted tiny cap-aide">
          Interroge la fédération pour chaque joueur — les nôtres et les leurs — et contrôle les
          scores. Aucune donnée n&apos;est envoyée&nbsp;: on regarde, on ne saisit rien.
        </p>

        {rapport === null ? (
          <p className="muted tiny">Pas encore vérifiée.</p>
        ) : (
          <>
            <div className={`notice ${n === 0 ? "info" : "error"} cap-verdict`}>
              {n === 0 || n === null ? (
                <>✓ Rien à signaler — la rencontre peut être saisie chez la fédération.</>
              ) : (
                <>
                  ⚠️ {n} point{n > 1 ? "s" : ""} à régler avant la saisie.
                </>
              )}
              <span className="muted tiny cap-quand"> Vérifiée le {quand(rapport.checkedAt)}</span>
            </div>

            {/* LE COMPTE DE LA RENCONTRE en premier : c'est le chiffre que la fédération
                attend, et celui qu'on relit en dernier avant de valider. */}
            <div className="cap-tie">
              <strong>
                {rapport.tie.home} – {rapport.tie.away}
              </strong>
              <span className="muted tiny">
                {rapport.tie.problem ?? `sur ${ouverte.matchCount} simples`}
              </span>
            </div>

            <ul className="ic-list cap-simples">
              {rapport.scores.map((s) => {
                const joueurs = parSimple.get(s.order) ?? [];
                const soucis = joueurs.filter((p) => p.verdict !== "found").length + (s.ok ? 0 : 1);
                const ouvert = soucis > 0 || deplies.includes(s.order);
                return (
                  <li key={s.order}>
                    <div className={`ic-row cap-simple${soucis ? " cap-ko" : " cap-ok"}`}>
                      <div className="ic-row-head">
                        <span>
                          <strong>Simple n°{s.order}</strong>{" "}
                          <span className="muted tiny">
                            {s.gamesHome} – {s.gamesAway}
                          </span>
                        </span>
                        {soucis === 0 ? (
                          <button
                            type="button"
                            className="cap-pastille cap-pastille-ok"
                            aria-expanded={ouvert}
                            onClick={() =>
                              setDeplies((prev) =>
                                prev.includes(s.order)
                                  ? prev.filter((x) => x !== s.order)
                                  : [...prev, s.order],
                              )
                            }
                          >
                            ✓ <span className="sr-only">Détail du simple n°{s.order}</span>
                          </button>
                        ) : (
                          <span className="cap-pastille cap-pastille-ko">
                            {soucis} <span className="sr-only">point(s) à régler</span>
                          </span>
                        )}
                      </div>

                      {ouvert && (
                        <>
                          {!s.ok && s.problem && <p className="cap-probleme">{s.problem}</p>}
                          {joueurs.map((p) => (
                            <div key={p.side} className="cap-joueur">
                              <span className="cap-marque" aria-hidden="true">
                                {p.verdict === "found" ? "✅" : p.verdict === "other-club" ? "ℹ️" : "⚠️"}
                              </span>
                              <span className="cap-joueur-corps">
                                <span className="cap-joueur-nom">
                                  {p.name} <span className="muted tiny">({camp(p)})</span>
                                </span>
                                {p.verdict === "found" ? (
                                  <span className="muted tiny">
                                    {/* Le nom FÉDÉRAL, parce que c'est celui à recopier — et il
                                        ne s'écrit pas toujours comme le nôtre. */}
                                    {p.fedName}
                                    {p.clt ? ` · ${p.clt}` : ""}
                                    {p.licence ? ` · licence ${p.licence}` : ""}
                                  </span>
                                ) : (
                                  <span className="cap-hint">{p.hint}</span>
                                )}
                              </span>
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>
    );
  }

  // --- La liste ------------------------------------------------------------
  return (
    <section className="cap">
      <h3 className="cap-titre">Capitaine</h3>
      <p className="muted tiny cap-aide">
        Vérifie une rencontre avant d&apos;aller saisir son score chez la fédération&nbsp;: les
        noms des joueurs (les nôtres et ceux d&apos;en face) et la cohérence des scores.
      </p>

      {erreur && <p className="muted tiny">{erreur}</p>}

      {liste.fixtures.length === 0 ? (
        <p className="muted tiny">
          Aucune rencontre pour {liste.teams.length > 1 ? "tes équipes" : "ton équipe"} pour le
          moment.
        </p>
      ) : (
        <ul className="ic-list">
          {liste.fixtures.map((f) => (
            <li key={f.id}>
              <button className="ic-row" onClick={() => void ouvrir(f)}>
                <span className="ic-row-head">
                  <span className="muted tiny">
                    {f.round ? `${f.round} · ` : ""}
                    {jour(f.date)}
                    {/* L'équipe n'est utile QUE si le capitaine en tient deux — sinon c'est un
                        rappel de ce qu'il sait déjà, sur une ligne déjà chargée. */}
                    {liste.teams.length > 1 && f.teamName ? ` · ${f.teamName}` : ""}
                  </span>
                  {f.problems === null ? (
                    <span className="cap-pastille">à vérifier</span>
                  ) : f.problems === 0 ? (
                    <span className="cap-pastille cap-pastille-ok">✓ prêt</span>
                  ) : (
                    <span className="cap-pastille cap-pastille-ko">
                      {f.problems} à régler
                    </span>
                  )}
                </span>
                <span className="ic-row-main">
                  <span>
                    {f.home ? "vs" : "chez"} <strong>{f.opponent}</strong>
                  </span>
                  {f.checkedAt && (
                    <span className="muted tiny">vérifiée le {quand(f.checkedAt)}</span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
