"use client";

import { useState } from "react";
import { Dialog } from "@/components/Dialog";
import { readJson } from "@/lib/apiFetch";
import type { LigneEnvoi } from "@/lib/squashnet/captain";

// ============================================================================
//  ENVOYER LE SCORE SUR SQUASHNET — la fenêtre, en deux temps.
//
//  1. « Préparer l'envoi » : l'appli se connecte avec les identifiants squashnet
//     du capitaine, lit le formulaire de la rencontre et MONTRE ce qui partira,
//     simple par simple, tel que squashnet l'affichera (recevant à gauche).
//  2. « Envoyer sur squashnet » : la même chose part, puis le serveur relit le
//     détail chez squashnet et le compare. Le message de réussite n'est affiché
//     qu'après cette relecture.
//
//  LES IDENTIFIANTS ne vivent que dans l'état de ce composant — jamais
//  `localStorage`, jamais l'URL — et disparaissent avec lui. Ils sont dans un
//  vrai `<form>` aux `autocomplete` standards : c'est ce qui permet au
//  gestionnaire de mots de passe du navigateur (Chrome, y compris dans l'appli
//  Android) de les proposer et de les mémoriser. L'appli, elle, ne garde rien.
// ============================================================================

type Etape = "saisie" | "apercu" | "envoye";

export default function CaptainSquashnet({
  fixtureId,
  onClose,
  onSent,
  toast,
  onExpired,
}: {
  fixtureId: string;
  onClose: () => void;
  /** L'envoi est parti ET relu sur squashnet : l'écran de la rencontre doit le dire. */
  onSent: (sentAt: string) => void;
  toast: (type: "ok" | "err" | "info", msg: string) => void;
  onExpired: (status: number) => boolean;
}) {
  const [login, setLogin] = useState("");
  const [motDePasse, setMotDePasse] = useState("");
  const [etape, setEtape] = useState<Etape>("saisie");
  const [lignes, setLignes] = useState<LigneEnvoi[]>([]);
  const [seen, setSeen] = useState<string | null>(null);
  const [erreur, setErreur] = useState<{ message: string; problemes: string[] } | null>(null);
  const [busy, setBusy] = useState(false);

  /** Changer d'identifiants après l'aperçu, c'est peut-être changer de compte : on reprépare. */
  const changer = (set: (v: string) => void) => (v: string) => {
    set(v);
    if (etape === "apercu") setEtape("saisie");
  };

  async function appeler(action: "preview" | "send") {
    setBusy(true);
    setErreur(null);
    try {
      const res = await fetch(`/api/captain/squashnet/${fixtureId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, login, password: motDePasse, seen }),
      });
      if (onExpired(res.status)) return;
      const data = await readJson<{
        error?: string;
        problemes?: string[];
        lignes?: LigneEnvoi[];
        seen?: string;
        sentAt?: string;
      }>(res);
      if (!res.ok) {
        setErreur({ message: data?.error ?? `Erreur ${res.status}`, problemes: data?.problemes ?? [] });
        return;
      }
      setLignes(data?.lignes ?? []);
      if (action === "preview") {
        setSeen(data?.seen ?? null);
        setEtape("apercu");
      } else {
        setEtape("envoye");
        setLogin("");
        setMotDePasse("");
        onSent(data?.sentAt ?? new Date().toISOString());
        toast("ok", "Score envoyé sur squashnet.");
      }
    } catch (e) {
      setErreur({ message: (e as Error).message, problemes: [] });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog onClose={onClose} label="Envoyer sur squashnet" closeOnOverlay={!busy}>
      <h3>Envoyer sur squashnet</h3>

      {etape === "envoye" ? (
        <>
          <div className="notice info" role="status">
            ✅ Envoyé, et relu sur squashnet. L&apos;autre capitaine reçoit un e-mail pour confirmer.
          </div>
          <Recap lignes={lignes} />
          <div className="modal-actions">
            <button onClick={onClose}>Fermer</button>
          </div>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void appeler(etape === "saisie" ? "preview" : "send");
          }}
        >
          <label>
            Identifiant squashnet
            <input
              name="username"
              autoComplete="username"
              value={login}
              onChange={(e) => changer(setLogin)(e.target.value)}
              required
            />
          </label>
          <label>
            Mot de passe squashnet
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              value={motDePasse}
              onChange={(e) => changer(setMotDePasse)(e.target.value)}
              required
            />
          </label>
          <p className="muted tiny">
            L&apos;appli s&apos;en sert pour cette connexion et ne les garde pas. Ton navigateur peut
            les mémoriser.
          </p>

          {etape === "apercu" && (
            <>
              <p className="tiny">
                Voici ce qui sera saisi sur squashnet (l&apos;équipe qui reçoit à gauche)&nbsp;:
              </p>
              <Recap lignes={lignes} />
            </>
          )}

          {erreur && (
            <div className="notice error" role="alert">
              {erreur.message}
              {erreur.problemes.length > 0 && (
                <ul className="cap-envoi-problemes">
                  {erreur.problemes.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="modal-actions">
            <button type="button" className="secondary" onClick={onClose} disabled={busy}>
              Annuler
            </button>
            <button type="submit" disabled={busy || !login || !motDePasse}>
              {busy
                ? "Connexion à squashnet…"
                : etape === "saisie"
                  ? "Préparer l'envoi"
                  : "Envoyer sur squashnet"}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function Recap({ lignes }: { lignes: LigneEnvoi[] }) {
  return (
    <ol className="cap-envoi-lignes">
      {lignes.map((l) => (
        <li key={l.ordre}>
          <strong>n°{l.ordre}</strong>{" "}
          <span>
            {l.recevant} – {l.visiteur}
          </span>{" "}
          <span className="cap-envoi-jeux">{l.jeux.join(" ")}</span>
        </li>
      ))}
    </ol>
  );
}
