"use client";

import { useCallback, useEffect, useState } from "react";
import { onForeground } from "@/lib/onForeground";
import {
  AVAILABILITY_LABELS,
  AVAILABILITY_ORDER,
  MAX_AVAILABILITY_COMMENT,
  type AvailabilityStatus,
} from "@/lib/interclub-availability";

// ============================================================================
//  « Qui peut venir ? » — le bloc de disponibilité d'une rencontre.
//
//  Il remplace un fil de discussion où la question se repose chaque semaine,
//  où les réponses se comptent à la main, et où celui qui n'a rien dit se
//  confond avec celui qui a dit non.
//
//  DEUX PARTIS PRIS D'ÉCRAN, tous deux mesurés sur l'usage réel du club :
//
//   * TOUT LE MONDE VOIT TOUT. Savoir qu'on n'est que trois est ce qui fait
//     répondre le quatrième. Un écran où chacun ne verrait que sa propre
//     réponse laisserait le capitaine seul avec le problème.
//   * CHACUN PEUT RÉPONDRE POUR UN AUTRE. Les joueurs sans compte et les
//     membres sans notifications ne verront jamais l'appel ; si eux seuls
//     pouvaient se déclarer, l'outil serait inutile pour la moitié du roster.
//     La provenance est écrite sur la ligne — c'est la trace, et non la
//     restriction, qui rend le relais sûr.
// ============================================================================

interface Entry {
  key: string;
  name: string;
  isMember: boolean;
  status: AvailabilityStatus | null;
  comment: string | null;
  relayedBy: string | null;
  reachable: boolean;
}

interface Counts {
  yes: number;
  no: number;
  maybe: number;
  pendingReachable: Entry[];
  pendingUnreachable: Entry[];
}

interface Payload {
  entries: Entry[];
  counts: Counts;
  matchCount: number;
  me: string;
}

/** Ce que le serveur renvoie en 409 : la réponse qu'on s'apprête à remplacer. */
interface Conflict {
  key: string;
  status: AvailabilityStatus;
  existing: { status: AvailabilityStatus; updatedAt: string };
}

/**
 * Le corps de réponse, ou `null` s'il n'a pas la forme attendue.
 *
 * Un `as Payload` non vérifié suffisait — jusqu'à ce que ce bloc rende `counts.yes` sur un
 * corps qui n'en portait pas, et emporte la FICHE ENTIÈRE avec lui : plus de composition, plus
 * de marquage, pour une réponse inattendue sur une donnée d'appoint. Un service worker qui sert
 * une réponse d'une autre version, un proxy qui répond 200 à côté, un test qui mocke large : le
 * cas n'est pas théorique. Ici, la donnée d'appoint disparaît, et le reste de la fiche vit.
 */
function asPayload(v: unknown): Payload | null {
  const p = v as Partial<Payload> | null;
  return p && Array.isArray(p.entries) && p.counts && typeof p.matchCount === "number"
    ? (p as Payload)
    : null;
}

/**
 * Absorbe une réponse serveur SANS PERDRE `me`.
 *
 * Le PUT ne le renvoyait pas, et remplacer l'état en bloc effaçait « qui suis-je » : plus aucune
 * ligne n'était la mienne, et le lien « Ajouter une précision » disparaissait dès la première
 * réponse posée. Le serveur le rend désormais des deux côtés — cette fusion est la ceinture :
 * l'identité du lecteur ne change pas d'une requête à l'autre, donc rien ne justifie qu'une
 * réponse partielle puisse la lui retirer.
 */
function merge(prev: Payload | null, next: Payload | null): Payload | null {
  if (!next) return prev;
  return { ...next, me: next.me ?? prev?.me ?? "" };
}

export function InterclubAvailability({
  fixtureId,
  toast,
  onExpired,
}: {
  fixtureId: string;
  toast: (type: "ok" | "err" | "info", msg: string) => void;
  onExpired: (status: number) => boolean;
}) {
  const [data, setData] = useState<Payload | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [conflict, setConflict] = useState<Conflict | null>(null);
  /**
   * Pourquoi il n'y a rien à montrer, quand il n'y a rien à montrer.
   *
   * Le bloc ne rendait RIEN sur un refus : les disponibilités sont réservées aux joueurs de
   * l'équipe qui dispute la rencontre, et un membre d'une autre équipe — ou un admin qui n'est
   * rattaché à aucune — voyait un espace vide, sans un mot. On cherche alors la panne dans le
   * code alors qu'il n'y en a pas : c'est une règle, elle doit se dire.
   */
  const [refus, setRefus] = useState<string | null>(null);
  /**
   * Le bloc est-il déplié ?
   *
   * `null` = pas encore décidé, faute de données. À la première charge, on ouvre SI JE N'AI PAS
   * ENCORE RÉPONDU, et on referme sinon : c'est la seule règle qui satisfait les deux usages du
   * même écran. Tant que ma réponse manque, la question doit me sauter aux yeux ; une fois
   * répondu, ce bloc n'est plus qu'une consultation, et il poussait les simples si bas qu'il
   * fallait faire défiler pour voir la composition.
   *
   * L'état est GARDÉ ici plutôt que calculé à chaque rendu : passer `open={!jaiRépondu}` en
   * dur refermerait le bloc sous les doigts de l'utilisateur à l'instant où il répond.
   */
  const [ouvert, setOuvert] = useState<boolean | null>(null);

  /**
   * FIXE l'état d'ouverture au premier chargement, et plus jamais ensuite.
   *
   * Sans ça, `ouvert` reste `null` — l'utilisateur n'ayant rien replié — et l'ouverture
   * continue de se DÉDUIRE de ma réponse. À la seconde où je clique « Dispo », la déduction
   * bascule et le bloc se referme sous mes doigts, juste avant que je relise ce que je viens
   * de poser. Un test le tient.
   */
  useEffect(() => {
    if (!data || ouvert !== null) return;
    setOuvert(!(data.entries.find((e) => e.key === data.me)?.status ?? null));
  }, [data, ouvert]);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/interclub/${fixtureId}/availability`, { cache: "no-store" });
      if (onExpired(res.status)) return;
      if (res.status === 403) {
        setRefus(
          "Les disponibilités sont réservées aux joueurs de cette équipe. Demande à un admin de te rattacher à l'équipe pour y répondre.",
        );
        return;
      }
      if (!res.ok) {
        setRefus("Disponibilités indisponibles pour le moment.");
        return;
      }
      setRefus(null);
      const recu = asPayload(await res.json());
      setData((prev) => merge(prev, recu));
    } catch {
      /* l'écran reste sur ce qu'il montrait : une liste vide ferait croire à une équipe vide */
    }
  }, [fixtureId, onExpired]);

  useEffect(() => {
    void load();
  }, [load]);

  // AU RETOUR AU PREMIER PLAN, comme l'écran qui porte ce bloc.
  //
  // Il ne s'y abonnait pas : le capitaine déverrouillait son téléphone au bord du terrain, la
  // liste des rencontres et le détail se rafraîchissaient — et le compteur « 2/4 dispo » restait
  // celui d'il y a une heure. Il relançait alors deux personnes qui avaient déjà répondu, ce
  // qui est exactement ce que ce bloc existe pour éviter.
  //
  // `onForeground` dédoublonne la rafale `focus` + `visibilitychange` : sans lui, chaque retour
  // partirait en double. On ne recharge pas pendant une écriture — la réponse du PUT est plus
  // fraîche que ce qu'un GET concurrent rapporterait.
  useEffect(() => {
    return onForeground(() => {
      if (busy) return;
      void load();
    });
  }, [load, busy]);

  /**
   * Poser une réponse. `key` est la mienne par défaut ; un `guest:` ou l'identifiant d'un
   * coéquipier en fait un relais. `confirm` ne part qu'après que l'écran a montré ce qu'il
   * remplace.
   */
  async function answer(key: string, status: AvailabilityStatus, comment?: string, confirm = false) {
    setBusy(key);
    try {
      const isGuest = key.startsWith("guest:");
      const res = await fetch(`/api/interclub/${fixtureId}/availability`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status,
          comment,
          ...(isGuest ? { guestId: key.slice(6) } : data?.me === key ? {} : { userId: key }),
          ...(confirm ? { confirmOverride: true } : {}),
        }),
      });
      if (onExpired(res.status)) return;
      if (res.status === 409) {
        // DEUX 409 SUR CETTE ROUTE, et un seul est une question.
        //
        //   * `confirm_override` — « cette personne avait répondu elle-même, on remplace ? ».
        //     On NE REFUSE PAS : un refus sec ferait croire à une panne, un remplacement
        //     silencieux ferait disparaître un « non » assumé.
        //   * `write_conflict` — deux écritures au même instant, la transaction a épuisé ses
        //     quatre tentatives. C'est une invitation à réessayer, sans rien à montrer.
        //
        // Brancher sur le seul statut faisait ouvrir la boîte de confirmation SANS `existing`,
        // et le rendu levait sur `existing.status` : faute d'error boundary, tout l'écran
        // disparaissait — un soir de rencontre, c'est-à-dire quand deux personnes répondent en
        // même temps. On lit donc le corps, et on n'ouvre la question que s'il en porte une.
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          existing?: Conflict["existing"];
        };
        if (body.existing) {
          setConflict({ key, status, existing: body.existing });
        } else {
          toast("err", body.error ?? "Deux réponses en même temps, réessaie.");
        }
        return;
      }
      if (!res.ok) {
        toast("err", ((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Impossible.");
        return;
      }
      const recu = asPayload(await res.json());
      setData((prev) => merge(prev, recu));
      setConflict(null);
      // LE BROUILLON NE SE VIDE QUE S'IL A ÉTÉ ENVOYÉ. Tout PUT réussi le jetait, y compris
      // celui d'un simple clic sur « Incertain » : une précision tapée puis laissée de côté le
      // temps de changer de réponse disparaissait sans un mot, alors que le serveur, lui,
      // préserve le commentaire existant quand la requête n'en porte pas.
      if (comment !== undefined) {
        setOpenFor(null);
        setDraft("");
      }
    } catch {
      toast("err", "Réseau indisponible.");
    } finally {
      setBusy(null);
    }
  }

  // Le refus se DIT, il ne se tait pas. Le silence était indiscernable d'un bloc qui n'existe
  // pas, et envoyait chercher un défaut là où il n'y a qu'une règle.
  if (refus) {
    return (
      <section className="ic-dispo">
        <p className="muted tiny ic-dispo-refus">{refus}</p>
      </section>
    );
  }
  if (!data) return null;
  const { entries, counts, matchCount } = data;
  const manque = counts.yes < matchCount;
  const maReponse = entries.find((e) => e.key === data.me)?.status ?? null;
  const deplie = ouvert ?? !maReponse;

  return (
    <details
      className="ic-dispo"
      open={deplie}
      onToggle={(ev) => setOuvert(ev.currentTarget.open)}
    >
      <summary className="ic-dispo-head">
        <h4>Disponibilités</h4>
        {/* MA réponse, dans le résumé : c'est la seule chose que je cherche quand le bloc est
            replié, et l'y montrer évite d'avoir à déplier pour vérifier que j'ai bien répondu. */}
        <span className={`ic-dispo-mine${maReponse ? ` is-${maReponse}` : " is-none"}`}>
          {maReponse ? AVAILABILITY_LABELS[maReponse] : "à répondre"}
        </span>
        {/* Le compte parle en SIMPLES À COUVRIR, pas en pourcentage de réponses : c'est la
            seule question que le capitaine se pose. Les « incertain » sont dits à part —
            les additionner aux présents ferait taire l'alerte le jour où elle est utile. */}
        <span className={`ic-dispo-count${manque ? " is-short" : ""}`}>
          {counts.yes}/{matchCount} dispo
          {counts.maybe > 0 && ` · ${counts.maybe} incertain${counts.maybe > 1 ? "s" : ""}`}
        </span>
      </summary>

      <ul className="ic-dispo-list">
        {entries.map((e) => {
          const moi = e.key === data.me;
          return (
            <li key={e.key} className={`ic-dispo-row${e.status ? ` is-${e.status}` : ""}`}>
              <span className="ic-dispo-name">
                {e.name}
                {moi && <span className="ic-dispo-tag">moi</span>}
                {!e.isMember && <span className="ic-dispo-tag">hors appli</span>}
              </span>

              <span className="ic-dispo-buttons" role="group" aria-label={`Disponibilité de ${e.name}`}>
                {AVAILABILITY_ORDER.map((s) => (
                  <button
                    key={s}
                    type="button"
                    aria-pressed={e.status === s}
                    disabled={busy === e.key}
                    onClick={() => answer(e.key, s)}
                  >
                    {AVAILABILITY_LABELS[s]}
                  </button>
                ))}
              </span>

              {(e.comment || e.relayedBy) && (
                <span className="ic-dispo-note muted">
                  {e.comment}
                  {/* La provenance, toujours affichée quand ce n'est pas l'intéressé qui a
                      répondu : « il a dit oui » et « on a dit qu'il dirait oui » ne sont pas
                      la même information, et les confondre fait venir trois joueurs pour
                      quatre simples. */}
                  {e.relayedBy && (
                    <em className="ic-dispo-relay"> — relayé par {e.relayedBy}</em>
                  )}
                </span>
              )}

              {moi && (
                <span className="ic-dispo-comment">
                  {openFor === e.key ? (
                    <>
                      <input
                        value={draft}
                        maxLength={MAX_AVAILABILITY_COMMENT}
                        placeholder="Précision (facultatif)"
                        aria-label="Précision sur ma disponibilité"
                        onChange={(ev) => setDraft(ev.target.value)}
                      />
                      {/* Grisé tant qu'on n'a pas répondu : une précision sans réponse
                          n'aurait rien à quoi se rattacher. Le `title` le DIT — partout
                          ailleurs dans cet écran, un bouton grisé explique pourquoi, et un
                          bouton muet envoie chercher une panne là où il n'y a qu'un ordre. */}
                      <button
                        type="button"
                        disabled={busy === e.key || !e.status}
                        title={
                          e.status
                            ? "Enregistre la précision avec ta réponse"
                            : "Réponds d'abord (Dispo, Incertain ou Absent) : la précision accompagne une réponse."
                        }
                        onClick={() => e.status && answer(e.key, e.status, draft)}
                      >
                        Enregistrer
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="ic-dispo-link"
                      onClick={() => {
                        setOpenFor(e.key);
                        setDraft(e.comment ?? "");
                      }}
                    >
                      {e.comment ? "Modifier ma précision" : "Ajouter une précision"}
                    </button>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {/* La liste d'appels. Elle est SÉPARÉE des autres silencieux parce qu'elle demande un
          geste différent : ceux-là ne recevront aucune relance, il faut les appeler. */}
      {counts.pendingUnreachable.length > 0 && (
        <p className="ic-dispo-call muted">
          Sans réponse et sans notification —{" "}
          <strong>{counts.pendingUnreachable.map((e) => e.name).join(", ")}</strong>. Personne ne
          les relancera : demande-leur, et réponds à leur place ci-dessus.
        </p>
      )}

      {conflict && (
        <div className="notice" role="alertdialog" aria-label="Confirmer le remplacement">
          <p>
            {entries.find((e) => e.key === conflict.key)?.name} avait répondu «{" "}
            {AVAILABILITY_LABELS[conflict.existing.status]} » lui-même. Remplacer par «{" "}
            {AVAILABILITY_LABELS[conflict.status]} » ?
          </p>
          <button type="button" onClick={() => answer(conflict.key, conflict.status, undefined, true)}>
            Remplacer
          </button>{" "}
          <button type="button" className="secondary" onClick={() => setConflict(null)}>
            Annuler
          </button>
        </div>
      )}
    </details>
  );
}
