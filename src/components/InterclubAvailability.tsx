"use client";

import { useCallback, useEffect, useState } from "react";
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

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/interclub/${fixtureId}/availability`, { cache: "no-store" });
      if (onExpired(res.status)) return;
      if (!res.ok) return;
      setData(asPayload(await res.json()));
    } catch {
      /* l'écran reste sur ce qu'il montrait : une liste vide ferait croire à une équipe vide */
    }
  }, [fixtureId, onExpired]);

  useEffect(() => {
    void load();
  }, [load]);

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
        // On NE REFUSE PAS : on montre ce que la personne avait répondu elle-même, et on
        // redemande. Un refus sec ferait croire à une panne ; un remplacement silencieux
        // ferait disparaître un « non » assumé.
        const body = (await res.json()) as { existing: Conflict["existing"] };
        setConflict({ key, status, existing: body.existing });
        return;
      }
      if (!res.ok) {
        toast("err", ((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Impossible.");
        return;
      }
      setData(asPayload(await res.json()));
      setOpenFor(null);
      setDraft("");
      setConflict(null);
    } catch {
      toast("err", "Réseau indisponible.");
    } finally {
      setBusy(null);
    }
  }

  if (!data) return null;
  const { entries, counts, matchCount } = data;
  const manque = counts.yes < matchCount;

  return (
    <section className="ic-dispo">
      <div className="ic-dispo-head">
        <h4>Disponibilités</h4>
        {/* Le compte parle en SIMPLES À COUVRIR, pas en pourcentage de réponses : c'est la
            seule question que le capitaine se pose. Les « incertain » sont dits à part —
            les additionner aux présents ferait taire l'alerte le jour où elle est utile. */}
        <span className={`ic-dispo-count${manque ? " is-short" : ""}`}>
          {counts.yes}/{matchCount} dispo
          {counts.maybe > 0 && ` · ${counts.maybe} incertain${counts.maybe > 1 ? "s" : ""}`}
        </span>
      </div>

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
                      <button
                        type="button"
                        disabled={busy === e.key || !e.status}
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
    </section>
  );
}
