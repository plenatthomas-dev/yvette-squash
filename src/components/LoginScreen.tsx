"use client";

// Écran de connexion (extrait de page.tsx) : onglet ResaMania + onglet « Par email »
// (OTP, gated par FEATURE_EMAIL_LOGIN). L'icône œil ci-dessous ne sert qu'ici.

import { useEffect, useState, type FormEvent } from "react";
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
  // Connexion par email (mot de passe) : 3 sous-modes.
  const [emailMode, setEmailMode] = useState<"login" | "register" | "forgot">("login");
  const [email, setEmail] = useState("");
  const [emailPassword, setEmailPassword] = useState("");
  const [showEmailPwd, setShowEmailPwd] = useState(false);
  const [name, setName] = useState("");

  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Un lien d'activation invalide/expiré renvoie vers /?erreur=lien_invalide (cf. la route
  // auth/email/verify). On bascule alors sur l'onglet email et on explique quoi faire.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("erreur") === "lien_invalide" && FEATURE_EMAIL_LOGIN) {
      setTab("email");
      setErr("Ce lien d'activation est invalide ou expiré. Recrée un compte pour en recevoir un nouveau.");
      // Nettoie l'URL pour ne pas ré-afficher le message au rechargement.
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);

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

  // Connexion par email + mot de passe (session « email seul », sans ResaMania).
  const submitEmailLogin = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/auth/email/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: emailPassword }),
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

  // Création de compte : envoie un lien d'activation par mail (aucune connexion immédiate).
  const submitRegister = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setInfo(null);
    try {
      const res = await fetch("/api/auth/email/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: emailPassword, name: name.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Inscription impossible");
      setInfo(
        `Presque fini ! On a envoyé un lien d'activation à ${email}. Clique dessus (pense aux spams) pour activer ton compte et te connecter.`,
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Mot de passe oublié : envoie un lien de réinitialisation (réponse volontairement neutre).
  const submitForgot = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setInfo(null);
    try {
      const res = await fetch("/api/auth/email/forgot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Envoi impossible");
      setInfo(
        `Si un compte existe pour ${email}, un lien de réinitialisation vient d'être envoyé (pense aux spams).`,
      );
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

  // Change de sous-mode email en nettoyant les messages (mais garde l'email déjà saisi).
  const changeEmailMode = (m: "login" | "register" | "forgot") => {
    setEmailMode(m);
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
            Pas d'accès ResaMania (suspendu, pas encore inscrit…) ? Crée un compte par email.
            Utilise le <strong>même email que sur ResaMania</strong> pour retrouver ton
            historique le jour où tu t'y reconnecteras.
          </p>

          {emailMode === "forgot" ? (
            <form onSubmit={submitForgot}>
              <input
                type="email"
                placeholder="Ton email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
              <button type="submit" disabled={busy || !email.trim()}>
                {busy ? "Envoi…" : "Recevoir un lien de réinitialisation"}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => changeEmailMode("login")}
                disabled={busy}
              >
                Retour à la connexion
              </button>
            </form>
          ) : (
            <form onSubmit={emailMode === "register" ? submitRegister : submitEmailLogin}>
              <input
                type="email"
                placeholder="Ton email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
              />
              {emailMode === "register" && (
                <input
                  type="text"
                  placeholder="Ton nom (prénom + nom)"
                  value={name}
                  maxLength={60}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                />
              )}
              <div className="pwd-field">
                <input
                  type={showEmailPwd ? "text" : "password"}
                  placeholder={emailMode === "register" ? "Choisis un mot de passe (8 car. min)" : "Mot de passe"}
                  value={emailPassword}
                  onChange={(e) => setEmailPassword(e.target.value)}
                  autoComplete={emailMode === "register" ? "new-password" : "current-password"}
                  minLength={emailMode === "register" ? 8 : undefined}
                />
                <button
                  type="button"
                  className="pwd-toggle"
                  onClick={() => setShowEmailPwd((v) => !v)}
                  aria-label={showEmailPwd ? "Masquer le mot de passe" : "Afficher le mot de passe"}
                  aria-pressed={showEmailPwd}
                  title={showEmailPwd ? "Masquer le mot de passe" : "Afficher le mot de passe"}
                >
                  <EyeIcon off={showEmailPwd} />
                </button>
              </div>
              <button type="submit" disabled={busy || !email.trim() || !emailPassword}>
                {busy
                  ? emailMode === "register"
                    ? "Envoi…"
                    : "Connexion…"
                  : emailMode === "register"
                    ? "Créer mon compte"
                    : "Se connecter"}
              </button>
            </form>
          )}

          {/* Bascule entre les sous-modes (jamais affichée pendant le mode « oublié »). */}
          {emailMode !== "forgot" && (
            <p className="muted tiny login-switch">
              {emailMode === "login" ? (
                <>
                  <button type="button" className="linklike" onClick={() => changeEmailMode("register")}>
                    Créer un compte
                  </button>
                  {" · "}
                  <button type="button" className="linklike" onClick={() => changeEmailMode("forgot")}>
                    Mot de passe oublié ?
                  </button>
                </>
              ) : (
                <button type="button" className="linklike" onClick={() => changeEmailMode("login")}>
                  J'ai déjà un compte — me connecter
                </button>
              )}
            </p>
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
