"use client";

// Relance d'enrôlement biométrique (amélioration A) : après une connexion réussie, si l'appareil
// supporte Face ID / Touch ID / empreinte et qu'AUCUN passkey n'y est encore enrôlé, on propose
// UNE FOIS de l'activer. C'est le plus gros levier d'adoption : sinon la biométrie reste enterrée
// dans les Réglages et personne ne l'active. Non intrusif : masquable, et « Plus tard » met la
// relance en veille 7 jours. Gated en interne (flag emailLogin + support), donc l'appelant se
// contente de le monter dans la vue connectée.

import { useEffect, useState } from "react";
import { useFeatures } from "@/components/FeatureProvider";
import { enrollPasskey, passkeySupported, hasPasskeyOnDevice } from "@/lib/webauthnClient";

const SNOOZE_KEY = "pk_enroll_snooze";
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours

function snoozed(): boolean {
  try {
    const t = Number(localStorage.getItem(SNOOZE_KEY) || 0);
    return Number.isFinite(t) && t > 0 && Date.now() - t < SNOOZE_MS;
  } catch {
    return false;
  }
}

export function PasskeyEnrollPrompt({
  toast,
}: {
  toast: (type: "ok" | "err" | "info", msg: string) => void;
}) {
  const { emailLogin } = useFeatures();
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!emailLogin) return; // les routes passkey sont gated sur ce flag
    if (hasPasskeyOnDevice()) return; // déjà activé sur cet appareil → rien à proposer
    if (snoozed()) return; // « Plus tard » récent : on ne relance pas
    let cancelled = false;
    passkeySupported().then((ok) => {
      if (ok && !cancelled) setShow(true);
    });
    return () => {
      cancelled = true;
    };
  }, [emailLogin]);

  if (!show) return null;

  const snooze = () => {
    try {
      localStorage.setItem(SNOOZE_KEY, String(Date.now()));
    } catch {
      /* localStorage indisponible : tant pis, la relance réapparaîtra au prochain chargement */
    }
    setShow(false);
  };

  const activate = async () => {
    setBusy(true);
    // Libellé laissé au serveur (déduit du User-Agent) : demander un nom ici alourdirait la
    // relance pour rien — l'appareil se renomme ensuite dans les Réglages au besoin.
    const r = await enrollPasskey();
    setBusy(false);
    if (r.ok) {
      // enrollPasskey a posé le marqueur local → la relance ne se reproposera plus ici.
      toast("ok", "Connexion biométrique activée 🔐");
      setShow(false);
    } else {
      // Inclut l'annulation par l'utilisateur : on met simplement en veille, sans dramatiser.
      toast("err", r.error ?? "Activation impossible.");
      snooze();
    }
  };

  return (
    <div
      className="notice info"
      style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}
    >
      <span>
        🔐 Active <strong>Face ID / empreinte</strong> pour te reconnecter en un geste la prochaine fois.
      </span>
      <span style={{ display: "flex", gap: 8, flexShrink: 0 }}>
        <button type="button" onClick={activate} disabled={busy}>
          {busy ? "…" : "Activer"}
        </button>
        <button type="button" className="secondary" onClick={snooze} disabled={busy}>
          Plus tard
        </button>
      </span>
    </div>
  );
}
