"use client";

// Écran de connexion (extrait de page.tsx) : onglet ResaMania + onglet « Par email »
// (OTP, gated par le flag `emailLogin`). L'icône œil ci-dessous ne sert qu'ici.

import { useEffect, useState, type FormEvent } from "react";
import { PrivacyNotice } from "@/components/PrivacyNotice";
import { useFeatures } from "@/components/FeatureProvider";
import { loginWithPasskey, passkeySupported } from "@/lib/webauthnClient";

// Icône empreinte (connexion biométrique).
function FingerprintIcon() {
  return (
    <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 10a2 2 0 0 0-2 2c0 1.5.5 3.5-1 5" />
      <path d="M12 6a6 6 0 0 0-6 6c0 2-.5 3.5-1 4.5" />
      <path d="M12 14c0 3-1 5-2 6.5" />
      <path d="M16 12a4 4 0 0 0-4-4" />
      <path d="M18.5 17c.5-1.5.5-3.5.5-5a7 7 0 0 0-11-5.7" />
      <path d="M14.5 20c.7-1.5 1.2-3 1.4-4.5" />
    </svg>
  );
}

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
  const { emailLogin } = useFeatures();
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
  // Connexion biométrique (passkey) : proposée seulement si l'appareil a un authenticator
  // plateforme (biométrie intégrée) ET que la connexion par email est activée.
  const [pkSupported, setPkSupported] = useState(false);
  useEffect(() => {
    passkeySupported().then(setPkSupported);
  }, []);

  const doPasskeyLogin = async () => {
    setBusy(true);
    setErr(null);
    const r = await loginWithPasskey();
    if (r.ok) {
      onLoggedIn();
    } else {
      setErr(r.error ?? "Connexion biométrique impossible.");
      setBusy(false);
    }
  };

  // Un lien d'activation invalide/expiré renvoie vers /?erreur=lien_invalide (cf. la route
  // auth/email/verify). On bascule alors sur l'onglet email et on explique quoi faire.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("erreur") === "lien_invalide" && emailLogin) {
      setTab("email");
      setErr("Ce lien d'activation est invalide ou expiré. Recrée un compte pour en recevoir un nouveau.");
      // Nettoie l'URL pour ne pas ré-afficher le message au rechargement.
      window.history.replaceState(null, "", window.location.pathname);
    }
    // Rejoué si le flag arrive après coup (override runtime) : sans effet, `replaceState`
    // a déjà retiré le paramètre d'URL.
  }, [emailLogin]);

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

  // Création de compte : dépose une demande d'inscription (approbation admin, aucun mail).
  const submitRegister = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setInfo(null);
    try {
      const res = await fetch("/api/auth/email/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, name: name.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Inscription impossible");
      setInfo(
        `Demande envoyée ✅ Un administrateur va la valider et te transmettre ton lien d'activation directement (WhatsApp, SMS…). Rien à surveiller dans tes mails.`,
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Mot de passe oublié : dépose une demande de réinitialisation (validée par un admin).
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
        `Si un compte existe pour ${email}, un administrateur validera ta demande et te transmettra un lien de réinitialisation directement.`,
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

      {/* Connexion biométrique en un geste (passkey). Découvrable → pas d'email à saisir.
          N'apparaît que si l'appareil la supporte et que la connexion email est active. */}
      {emailLogin && pkSupported && (
        <div className="passkey-login">
          <button type="button" className="passkey-btn" onClick={doPasskeyLogin} disabled={busy}>
            <FingerprintIcon />
            {busy ? "Connexion…" : "Se connecter avec Face ID / empreinte"}
          </button>
          <p className="muted tiny" style={{ textAlign: "center" }}>
            Après l'avoir activée une fois dans les Réglages.
          </p>
        </div>
      )}

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
            (emailLogin ? "" : " coming-soon")
          }
          aria-pressed={tab === "email"}
          onClick={() => emailLogin && switchTab("email")}
          disabled={!emailLogin}
          title={emailLogin ? undefined : "🚧 En cours de développement"}
        >
          Par email
        </button>
      </div>

      {tab === "resa" || !emailLogin ? (
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
                {busy ? "Envoi…" : "Demander une réinitialisation"}
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
              {/* Le mot de passe ne se choisit PAS ici à l'inscription : c'est au moment
                  d'activer le compte (via le lien transmis par l'admin) — cf. /reinitialiser. */}
              {emailMode === "login" && (
                <div className="pwd-field">
                  <input
                    type={showEmailPwd ? "text" : "password"}
                    placeholder="Mot de passe"
                    value={emailPassword}
                    onChange={(e) => setEmailPassword(e.target.value)}
                    autoComplete="current-password"
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
              )}
              <button
                type="submit"
                disabled={
                  busy || !email.trim() || (emailMode === "login" && !emailPassword)
                }
              >
                {busy
                  ? emailMode === "register"
                    ? "Envoi…"
                    : "Connexion…"
                  : emailMode === "register"
                    ? "Demander un compte"
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
