"use client";

// Écran de connexion (extrait de page.tsx) : onglet ResaMania + onglet « Par email »
// (OTP, gated par FEATURE_EMAIL_LOGIN). L'icône œil ci-dessous ne sert qu'ici.

import { useState, type FormEvent } from "react";
import { PrivacyNotice } from "@/components/PrivacyNotice";
import { FEATURE_EMAIL_LOGIN } from "@/lib/features";

// Icône « œil » (afficher/masquer le mot de passe). `off` = œil barré (masqué).
function EyeIcon({ off }: { off: boolean }) {
  const p = {
    viewBox: "0 0 24 24",
    width: 20,
    height: 20,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (off) {
    return (
      <svg {...p}>
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20C5 20 1 12 1 12a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
        <line x1="1" y1="1" x2="23" y2="23" />
      </svg>
    );
  }
  return (
    <svg {...p}>
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function LoginScreen({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [tab, setTab] = useState<"resa" | "email">("resa");
  // ResaMania
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  // Connexion par email (OTP)
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [codeSent, setCodeSent] = useState(false);

  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submitResa = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Connexion impossible");
      onLoggedIn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const requestCode = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setInfo(null);
    try {
      const res = await fetch("/api/auth/otp/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Envoi impossible");
      setCodeSent(true);
      setInfo(`Code envoyé à ${email}. Regarde tes mails (et les spams).`);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const verifyCode = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/auth/otp/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code, name: name.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Code invalide");
      onLoggedIn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const switchTab = (t: "resa" | "email") => {
    setTab(t);
    setErr(null);
    setInfo(null);
  };

  return (
    <main className="login">
      <h1 className="sr-only">Squash de l'Yvette</h1>
      <img src="/logo_squash.jpeg" alt="Squash de l'Yvette" className="logo-hero" />

      {/* Onglet « Par email » : actif si le flag est ON ; sinon affiché grisé (désactivé)
          avec un tooltip « en cours de développement ». Seule ResaMania reste utilisable. */}
      <div className="login-tabs" role="group" aria-label="Méthode de connexion">
        <button
          type="button"
          className={tab === "resa" ? "active" : "secondary"}
          aria-pressed={tab === "resa"}
          onClick={() => switchTab("resa")}
        >
          ResaMania
        </button>
        <button
          type="button"
          className={
            (tab === "email" ? "active" : "secondary") +
            (FEATURE_EMAIL_LOGIN ? "" : " coming-soon")
          }
          aria-pressed={tab === "email"}
          onClick={() => FEATURE_EMAIL_LOGIN && switchTab("email")}
          disabled={!FEATURE_EMAIL_LOGIN}
          title={FEATURE_EMAIL_LOGIN ? undefined : "🚧 En cours de développement"}
        >
          Par email
        </button>
      </div>

      {tab === "resa" || !FEATURE_EMAIL_LOGIN ? (
        <>
          <p className="muted">
            Connecte-toi avec ton compte ResaMania (Le Complexe Bures).
          </p>
          <form onSubmit={submitResa}>
            <input
              type="text"
              placeholder="Identifiant (email)"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
            />
            <div className="pwd-field">
              <input
                type={showPwd ? "text" : "password"}
                placeholder="Mot de passe"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
              <button
                type="button"
                className="pwd-toggle"
                onClick={() => setShowPwd((v) => !v)}
                aria-label={showPwd ? "Masquer le mot de passe" : "Afficher le mot de passe"}
                aria-pressed={showPwd}
                title={showPwd ? "Masquer le mot de passe" : "Afficher le mot de passe"}
              >
                <EyeIcon off={showPwd} />
              </button>
            </div>
            <button type="submit" disabled={busy}>
              {busy ? "Connexion…" : "Se connecter"}
            </button>
          </form>
          <p className="muted tiny">
            Ton mot de passe sert seulement à te connecter à ResaMania ; il n'est jamais
            conservé. L'appli mémorise uniquement que tu es connecté, de façon sécurisée.
          </p>
        </>
      ) : (
        <>
          <p className="muted">
            Pas d'accès ResaMania (suspendu, pas encore inscrit…) ? Connecte-toi par email.
            Utilise le <strong>même email que sur ResaMania</strong> pour retrouver ton
            historique le jour où tu t'y reconnecteras.
          </p>
          {!codeSent ? (
            <form onSubmit={requestCode}>
              <input
                type="email"
                placeholder="Ton email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
              <button type="submit" disabled={busy || !email.trim()}>
                {busy ? "Envoi…" : "Recevoir un code"}
              </button>
            </form>
          ) : (
            <form onSubmit={verifyCode}>
              <input
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="Code à 6 chiffres"
                value={code}
                maxLength={6}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              />
              <input
                type="text"
                placeholder="Ton nom (si première connexion)"
                value={name}
                maxLength={60}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
              />
              <button type="submit" disabled={busy || code.length !== 6}>
                {busy ? "Vérification…" : "Se connecter"}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setCodeSent(false);
                  setCode("");
                  setInfo(null);
                  setErr(null);
                }}
                disabled={busy}
              >
                Changer d'email / renvoyer un code
              </button>
            </form>
          )}
          <p className="muted tiny">
            En connexion email, tu peux consulter le planning et le Tricount, mais pas réserver
            de terrain (ça reste sur ResaMania).
          </p>
        </>
      )}

      {info && <div className="notice info">{info}</div>}
      {err && <div className="notice error">⚠️ {err}</div>}
      <PrivacyNotice />
    </main>
  );
}
