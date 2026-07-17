"use client";

// Pilotage à chaud des fonctions (étape #9), pour /admin.
//
// Trois états par fonction : « Auto » (aucun override → on suit la variable d'environnement
// de la branche) et « Forcé ON / OFF » (override en base, effectif sans redéploiement).
// Autonome (charge ses propres données) pour pouvoir être rendu même quand le reste de
// /admin est indisponible — cf. le garde-fou anti-verrouillage dans admin/page.tsx.

import { useEffect, useState } from "react";
import {
  FEATURE_KEYS,
  FEATURE_LABELS,
  type FeatureKey,
  type FeatureOverrides,
  type Features,
} from "@/lib/features";

type State = { env: Features; overrides: FeatureOverrides; features: Features };
type Choice = "auto" | "on" | "off";

function choiceOf(override: boolean | undefined): Choice {
  if (override === undefined) return "auto";
  return override ? "on" : "off";
}

function valueOf(choice: Choice): boolean | null {
  if (choice === "auto") return null;
  return choice === "on";
}

export default function FeatureFlagsPanel() {
  const [data, setData] = useState<State | null>(null);
  const [busy, setBusy] = useState<FeatureKey | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/admin/features");
        if (!res.ok) return setErr("Chargement des fonctions impossible.");
        setData((await res.json()) as State);
      } catch {
        setErr("Chargement des fonctions impossible.");
      }
    })();
  }, []);

  const change = async (key: FeatureKey, choice: Choice) => {
    setBusy(key);
    setErr(null);
    try {
      const res = await fetch("/api/admin/features", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value: valueOf(choice) }),
      });
      const body = (await res.json()) as State & { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Modification impossible");
      setData({ env: body.env, overrides: body.overrides, features: body.features });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: "1.1rem" }}>Fonctions de l'appli</h2>
      <p className="muted tiny">
        Activer ou couper une fonction sans redéploiement. « Auto » suit la configuration de
        l'environnement. Un changement met jusqu'à ~15 s à se propager, et il faut recharger
        l'appli pour le voir côté membre.
      </p>

      {err && <div className="notice error">⚠️ {err}</div>}
      {!data && !err && <p className="muted">Chargement…</p>}

      {data && (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {FEATURE_KEYS.map((k) => {
            const choice = choiceOf(data.overrides[k]);
            const on = data.features[k];
            return (
              <li
                key={k}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "6px 0",
                  flexWrap: "wrap",
                }}
              >
                <span title={on ? "Active" : "Coupée"} aria-hidden="true">
                  {on ? "🟢" : "⚪"}
                </span>
                <span style={{ flex: 1, minWidth: 160 }}>
                  {FEATURE_LABELS[k]}
                  <span className="sr-only"> : {on ? "active" : "coupée"}</span>
                </span>
                {/* Switch 3 positions : Coupée · Auto · Active (au lieu d'un menu déroulant). */}
                <div
                  className="tri-switch"
                  role="group"
                  aria-label={`État de « ${FEATURE_LABELS[k]} »`}
                >
                  <button
                    type="button"
                    className={"tri-off" + (choice === "off" ? " active" : "")}
                    aria-pressed={choice === "off"}
                    disabled={busy === k}
                    onClick={() => change(k, "off")}
                    title="Forcer la fonction coupée"
                  >
                    Coupée
                  </button>
                  <button
                    type="button"
                    className={"tri-auto" + (choice === "auto" ? " active" : "")}
                    aria-pressed={choice === "auto"}
                    disabled={busy === k}
                    onClick={() => change(k, "auto")}
                    title={`Suit l'environnement (actuellement ${data.env[k] ? "active" : "coupée"})`}
                  >
                    Auto
                  </button>
                  <button
                    type="button"
                    className={"tri-on" + (choice === "on" ? " active" : "")}
                    aria-pressed={choice === "on"}
                    disabled={busy === k}
                    onClick={() => change(k, "on")}
                    title="Forcer la fonction active"
                  >
                    Active
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
