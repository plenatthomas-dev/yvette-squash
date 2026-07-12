"use client";

// Page cible du lien « mot de passe oublié » : /reinitialiser?token=…
// Formulaire d'un nouveau mot de passe → POST /api/auth/email/reset. En cas de succès, le
// serveur pose déjà le cookie de session : on redirige simplement vers l'accueil (connecté).

import { useEffect, useState, type FormEvent } from "react";
import { PrivacyNotice } from "@/components/PrivacyNotice";
import { FEATURE_EMAIL_LOGIN } from "@/lib/features";

export default function ResetPasswordPage() {
  const [token, setToken] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Le token vit dans l'URL (query) : on le lit côté client pour éviter une frontière Suspense.
  useEffect(() => {
    if (typeof window === "undefined") return;
    setToken(new URLSearchParams(window.location.search).get("token"));
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/auth/email/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Réinitialisation impossible");
      // Session posée par le serveur → on repart connecté sur l'accueil.
      window.location.href = "/";
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  if (!FEATURE_EMAIL_LOGIN) {
    return (
      <main className="login">
        <h1>Réinitialisation</h1>
        <div className="notice error">⚠️ Fonction indisponible.</div>
      </main>
    );
  }

  return (
    <main className="login">
      <h1>Nouveau mot de passe</h1>
      {token === null ? (
        <p className="muted">Chargement…</p>
      ) : token === "" ? (
        <div className="notice error">
          ⚠️ Lien invalide. Redemande un lien depuis « Mot de passe oublié » sur l'écran de
          connexion.
        </div>
      ) : (
        <>
          <p className="muted">Choisis ton nouveau mot de passe (8 caractères minimum).</p>
          <form onSubmit={submit}>
            <div className="pwd-field">
              <input
                type={showPwd ? "text" : "password"}
                placeholder="Nouveau mot de passe"
                value={password}
                minLength={8}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
              />
              <button
                type="button"
                className="pwd-toggle"
                onClick={() => setShowPwd((v) => !v)}
                aria-label={showPwd ? "Masquer le mot de passe" : "Afficher le mot de passe"}
                aria-pressed={showPwd}
                title={showPwd ? "Masquer le mot de passe" : "Afficher le mot de passe"}
              >
                {showPwd ? "🙈" : "👁"}
              </button>
            </div>
            <button type="submit" disabled={busy || password.length < 8}>
              {busy ? "Enregistrement…" : "Enregistrer et me connecter"}
            </button>
          </form>
        </>
      )}
      {err && <div className="notice error">⚠️ {err}</div>}
      <PrivacyNotice />
    </main>
  );
}
