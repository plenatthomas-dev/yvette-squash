"use client";

import { useCallback, useEffect, useState } from "react";
import { readOk } from "@/lib/apiFetch";
import { countProblems, type CheckReport, type PlayerCheck } from "@/lib/captain-check";
// La PHRASE vient du module de règle, elle n'est pas réécrite ici : l'écran doit dire exactement
// ce que le serveur a conclu. Deux formulations finiraient par diverger, et c'est l'écran qu'on
// croirait.
import { describeOfficial } from "@/lib/captain-official";

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
//   2. C'EST AUSSI LA FEUILLE DE MATCH. Noms fédéraux, jeux ET points de chaque
//      simple sont TOUJOURS visibles — c'est ce qu'on recopie dans le formulaire
//      de la ligue, un champ après l'autre, en gardant cet écran ouvert à côté.
//      (Les lignes propres se repliaient, au début : c'était une checklist et
//      rien d'autre. Replier ce qu'on est venu transcrire obligeait à rouvrir
//      chaque simple pour saisir, soit exactement le geste que l'écran épargne.)
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
  /** Le nom que la LIGUE donne à notre équipe (« Yvette 1 »), quand sa fiche est en cache. */
  teamFedName: string | null;
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

/**
 * L'ÉQUIPE d'un joueur rapproché, en version courte.
 *
 * « Verrieres 3 », et non « Squash club verrieres le buisson » : le nom d'équipe tient sur la
 * même ligne que le nom du joueur, là où le nom de club la faisait systématiquement passer à
 * deux — soit 22 px par joueur, 176 px sur une rencontre à quatre simples. C'est à peu près ce
 * qui manquait pour qu'une rencontre entière tienne dans une capture d'écran de téléphone.
 *
 * ⚠️ DES DEUX CÔTÉS, UN NOM D'ÉQUIPE — plus « nous ». Le raccourci tenait tant qu'on n'alignait
 * qu'une équipe ; à deux, il ne dit plus LAQUELLE, et c'est justement sur une capture d'écran,
 * relue plus tard ou envoyée à quelqu'un d'autre, que l'ambiguïté coûte.
 *
 * L'ordre de préférence dit d'où vient le nom : celui de la LIGUE d'abord (« Yvette 1 » — le
 * même vocabulaire que « Verrieres 3 » en face, donc rien à traduire), puis le nôtre
 * (« Équipe 1 ») tant que la fiche fédérale n'est pas en cache. L'adversaire, lui, est celui de
 * la rencontre : déjà à l'écran, court, et le même pour les quatre — aucune raison d'aller le
 * chercher joueur par joueur.
 */
const equipeDe = (
  p: PlayerCheck,
  f: { opponent: string; teamName: string | null; teamFedName: string | null },
) => (p.side === "home" ? (f.teamFedName ?? f.teamName ?? "nous") : f.opponent);

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

        <button type="button" disabled={busy} onClick={verifier} className="cap-verifier">
          {busy && <span className="cap-spinner" aria-hidden="true" />}
          {busy ? "Vérification…" : rapport ? "Revérifier" : "Vérifier la rencontre"}
        </button>
        {/* LE TEXTE DIT CE QUE LA ROUE NE DIT PAS : combien de temps, et pourquoi. Dix secondes
            sans explication se lisent « c'est planté » ; avec, elles s'attendent. `role="status"`
            le fait annoncer aux lecteurs d'écran, à qui une roue purement décorative
            (`aria-hidden`) n'apprendrait rien du tout. */}
        {busy && (
          <p className="muted tiny cap-attente" role="status">
            Interrogation de la fédération, joueur par joueur — quelques secondes.
          </p>
        )}
        <p className="muted tiny cap-aide">
          Interroge la fédération pour NOS joueurs et contrôle les scores. Ceux d&apos;en face
          sont lus dans la liste des inscrits de leur équipe quand on l&apos;a — c&apos;est plus
          sûr qu&apos;une recherche par le nom, qui peut tomber sur un homonyme d&apos;un autre
          club. Relit aussi la feuille de match publiée par la ligue, pour la confronter à notre
          relevé.{" "}
          {/* ⚠️ LA PHRASE EXACTE COMPTE. Elle disait « aucune donnée n'est envoyée », ce qui
              était faux : chercher un joueur consiste précisément à envoyer son nom à squashnet.
              Ce qu'on veut promettre est autre chose, et c'est tenu — cet écran ne PUBLIE rien
              chez la fédération : il ne saisit aucun score, ne valide aucune feuille. */}
          Rien n&apos;est saisi ni publié chez la fédération&nbsp;: cet écran lit, il n&apos;écrit
          pas.
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

            {/* CE QUE LA LIGUE PUBLIE, juste sous notre propre compte — c'est là que la
                comparaison se fait d'un coup d'œil, sans rien à rapprocher de tête.

                RIEN N'EST AFFICHÉ QUAND IL N'Y A RIEN À DIRE. « Pas d'identifiant fédéral » est
                le sort de toute rencontre saisie à la main : l'annoncer à chaque fois ferait
                passer pour une anomalie ce qui est un mode de saisie normal. Le silence de la
                ligue avant la saisie, lui, se dit — mais discrètement, parce que c'est l'état
                attendu quand on vérifie AVANT d'aller saisir. */}
            {rapport.official && rapport.official.status !== "absent" && (
              <div
                className={
                  "cap-officiel" +
                  (rapport.official.status === "diverges" ? " cap-officiel-ko" : "") +
                  (rapport.official.status === "match" ? " cap-officiel-ok" : "")
                }
              >
                <p className="cap-officiel-tete">
                  {rapport.official.status === "match"
                    ? "✅ "
                    : rapport.official.status === "diverges"
                      ? "⚠️ "
                      : "ℹ️ "}
                  {describeOfficial(rapport.official)}
                  {/* LE LIEN VERS LA FEUILLE, systématiquement. C'est le document qui fait foi :
                      quand quelque chose ne concorde pas, la première chose à faire est d'aller
                      le voir de ses yeux — et le retrouver à la main sur squashnet demande de
                      redescendre l'épreuve, la poule, puis la journée. */}
                  {rapport.official.url && (
                    <>
                      {" "}
                      <a
                        href={rapport.official.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="cap-officiel-lien"
                      >
                        voir la feuille
                      </a>
                    </>
                  )}
                </p>
                {/* LES ÉCARTS, UN PAR LIGNE. Formulés en constats (« la ligue publie X, notre
                    relevé dit Y ») : l'un des deux documents est faux et rien ne dit lequel —
                    c'est peut-être notre marquage qui a dérapé. */}
                {rapport.official.problems.length > 0 && (
                  <ul className="cap-officiel-ecarts">
                    {rapport.official.problems.map((p, i) => (
                      <li key={i}>{p}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {/* L'ORDRE DES SIMPLES D'EN FACE. Il n'apparaît que s'il y a quelque chose à en
                dire : conforme, il n'apprend rien et occuperait la place de ce qui compte. */}
            {rapport.awayOrder.status !== "ok" && rapport.awayOrder.problem && (
              <p
                className={
                  "cap-ordre" + (rapport.awayOrder.status === "violation" ? " cap-ordre-ko" : "")
                }
              >
                {rapport.awayOrder.status === "violation" ? "⚠️ " : "ℹ️ "}
                {rapport.awayOrder.problem}
              </p>
            )}

            <ul className="ic-list cap-simples">
              {rapport.scores.map((s) => {
                const joueurs = parSimple.get(s.order) ?? [];
                const soucis = joueurs.filter((p) => p.verdict !== "found").length + (s.ok ? 0 : 1);
                const nous = joueurs.find((p) => p.side === "home");
                const eux = joueurs.find((p) => p.side === "away");
                return (
                  <li key={s.order}>
                    <div className={`ic-row cap-simple${soucis ? " cap-ko" : " cap-ok"}`}>
                      {/* TOUT LE SIMPLE SUR UNE LIGNE : son numéro, le détail JEU PAR JEU, et
                          le total. Les points étaient sur une ligne à part, ce qui coûtait 25 px
                          par simple — sur quatre simples, la moitié de ce qui manquait pour
                          qu'une rencontre entière tienne dans une capture d'écran de téléphone.

                          LE DÉTAIL RESTE TOUJOURS VISIBLE : c'est ce qu'on recopie chez la
                          fédération, champ par champ, en gardant cet écran ouvert à côté. Il se
                          replie sur une seconde ligne quand il ne tient pas (cinq jeux sur un
                          écran étroit) — jamais il ne se tronque. */}
                      <div className="ic-row-head cap-tete">
                        {/* « n°4 » à l'écran, « Simple n° 4 » à la voix : le mot coûtait 85 px
                            de largeur sur une ligne qui doit en tenir cinq jeux, pour une
                            information que la liste donne déjà. */}
                        <strong className="cap-numero" aria-label={`Simple n° ${s.order}`}>
                          n°{s.order}
                        </strong>
                        {s.games.length > 0 && (
                          <span className="cap-points">
                            {s.games.map((g, i) => (
                              <span key={i} className="cap-jeu">
                                {g.home}-{g.away}
                              </span>
                            ))}
                          </span>
                        )}
                        <span className="cap-jeux">
                          {s.gamesHome} – {s.gamesAway}
                        </span>
                      </div>

                      {!s.ok && s.problem && <p className="cap-probleme">{s.problem}</p>}

                      {[nous, eux].map((p) =>
                        !p ? null : (
                          <div key={p.side} className="cap-joueur">
                            <span className="cap-marque" aria-hidden="true">
                              {p.verdict === "found" ? "✅" : p.verdict === "other-club" ? "ℹ️" : "⚠️"}
                            </span>
                            <span className="cap-joueur-corps">
                              {p.verdict === "found" ? (
                                <>
                                  {/* UNE SEULE IDENTITÉ, LA FÉDÉRALE. On affichait les deux — le
                                      nom saisi chez nous PUIS celui de la fédération — et c'était
                                      redondant : ce sont la même personne, et seul le second se
                                      recopie.

                                      ⚠️ LE CAMP, ET NON PLUS LE CLUB. On affichait ici le club
                                      fédéral (« Squash club verrieres le buisson ») : deux lignes
                                      de large pour une information qui, sur un joueur RAPPROCHÉ,
                                      ne vérifie rien — `checkPlayer` ne rend `found` QUE si le
                                      club correspond à celui qu'on attendait. Il ne restait donc
                                      que son rôle secondaire, dire de quel camp est le joueur, et
                                      le nom de l'ÉQUIPE le tient en trois fois moins de place.
                                      (Un joueur trouvé AILLEURS n'est pas `found` : c'est
                                      `other-club`, et son remède nomme le club en toutes
                                      lettres.) */}
                                  <span className="cap-joueur-nom">
                                    {p.fedName}
                                    <span className="cap-club"> · {equipeDe(p, ouverte)}</span>
                                  </span>
                                  <span className="muted tiny cap-fiche">
                                    {[p.clt, p.rangM != null ? `#${p.rangM}` : null]
                                      .filter(Boolean)
                                      .join(" ")}
                                    {p.licence ? ` · ${p.licence}` : ""}
                                  </span>
                                </>
                              ) : (
                                <>
                                  {/* Pas rapproché : le nom SAISI est tout ce qu'on a, et le camp
                                      ne se déduit plus d'un club qu'on n'a pas trouvé. */}
                                  <span className="cap-joueur-nom">
                                    {p.name} <span className="muted tiny">({camp(p)})</span>
                                  </span>
                                  <span className="cap-hint">{p.hint}</span>
                                </>
                              )}
                            </span>
                          </div>
                        ),
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
