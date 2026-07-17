"use client";

// Écran de connexion (extrait de page.tsx) : onglet ResaMania + onglet « Par email » (gated par
// le flag `emailLogin`). La connexion biométrique (bouton empreinte + auto-connexion) est, elle,
// gatée par le flag `biometry`, indépendant. L'icône œil ci-dessous ne sert qu'ici.

import { useEffect, useRef, useState, type FormEvent } from "react";
import { PrivacyNotice } from "@/components/PrivacyNotice";
import { useFeatures } from "@/components/FeatureProvider";
import {
  loginWithPasskey,
  passkeySupported,
  passkeyAutofillSupported,
  hasPasskeyOnDevice,
} from "@/lib/webauthnClient";

// Icône empreinte (connexion biométrique). Tracé « fingerprint » de Lucide (ISC) : des
// crêtes concentriques nettes, tout de suite reconnaissables comme une empreinte.
function FingerprintIcon({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12C2 6.5 6.5 2 12 2a10 10 0 0 1 8 4" />
      <path d="M5 19.5C5.5 18 6 15 6 12c0-.7.12-1.37.34-2" />
      <path d="M17.29 21.02c.12-.6.43-2.3.5-3.02" />
      <path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4" />
      <path d="M8.65 22c.21-.66.45-1.32.57-2" />
      <path d="M14 13.12c0 2.38 0 6.38-1 8.88" />
      <path d="M2 16h.01" />
      <path d="M21.8 16c.2-2 .131-5.354 0-6" />
      <path d="M9 6.8a6 6 0 0 1 9 5.2c0 .47 0 1.17-.02 2" />
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
  const { emailLogin, biometry } = useFeatures();
  const [tab, setTab] = useState<"resa" | "email">("resa");
  // ResaMania
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPwd, setShowPwd] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  // Mode « reconnexion ResaMania guidée » : activé après une biométrie réussie dont la session
  // ResaMania a expiré (409). On garde l'identifiant pré-rempli et on invite juste à taper le mdp.
  const [resaReconnect, setResaReconnect] = useState(false);
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

  // `silent` (autofill au lancement) : on N'affiche PAS d'erreur si l'utilisateur annule ou
  // ignore la suggestion — on le laisse simplement sur les formulaires (le bouton empreinte
  // reste le plan B). `useAutofill` branche le passkey sur l'autocomplétion des champs.
  const doPasskeyLogin = async (opts: { silent?: boolean; useAutofill?: boolean } = {}) => {
    const { silent = false, useAutofill = false } = opts;
    if (!silent) setBusy(true);
    setErr(null);
    const r = await loginWithPasskey({ useAutofill });
    if (r.ok) {
      onLoggedIn();
      return;
    }
    // Biométrie reconnue MAIS session ResaMania expirée (pas de repli e-mail) : on ne bloque pas.
    // On bascule sur l'onglet ResaMania avec l'identifiant déjà rempli et le focus sur le mot de
    // passe — il ne reste qu'à le taper pour pouvoir réserver. On le fait MÊME en mode silencieux
    // (auto-connexion au lancement) : ici la biométrie A réussi, ce n'est pas une annulation à
    // taire — et c'est justement le scénario le plus courant du token ResaMania expiré.
    if (r.code === "resa_expired") {
      setTab("resa");
      if (r.username) setUsername(r.username);
      setResaReconnect(true);
      setInfo(null);
      setErr(null);
      setBusy(false);
      requestAnimationFrame(() => passwordRef.current?.focus());
      return;
    }
    if (!silent) setErr(r.error ?? "Connexion biométrique impossible.");
    if (!silent) setBusy(false);
  };

  // Auto-connexion biométrique au lancement, adaptée à l'appareil :
  //  • appareil DÉJÀ configuré (un passkey y a servi → repère local `pk_on_device`) : on ouvre
  //    directement la modale Face ID / empreinte, comme un lecteur qui s'arme tout seul. C'est
  //    le comportement attendu des habitués (un geste et on est connecté) ; il marche là où
  //    l'auto-ouverture est permise (Android/Chrome notamment).
  //  • appareil vierge : jamais de modale surprise. On tente l'« autofill conditionnel »
  //    (Conditional UI) là où c'est supporté — le passkey apparaît alors dans l'autocomplétion
  //    des champs, sans rien imposer. Sinon rien : le bouton empreinte reste le plan B.
  const autoTried = useRef(false);
  useEffect(() => {
    if (autoTried.current) return;
    if (!biometry) return; // gate biométrie (routes passkey + auto-connexion empreinte)
    autoTried.current = true;
    (async () => {
      if (hasPasskeyOnDevice()) {
        await doPasskeyLogin({ silent: true });
        return;
      }
      if (await passkeyAutofillSupported()) {
        await doPasskeyLogin({ silent: true, useAutofill: true });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [biometry]);

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
    setResaReconnect(false);
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
          {/* Reconnexion guidée après une biométrie réussie mais un lien ResaMania expiré :
              identifiant déjà rempli + focus sur le mot de passe → un seul geste pour réserver. */}
          {resaReconnect && (
            <div className="notice info">
              🔓 Biométrie reconnue ✅ — entre juste ton <strong>mot de passe ResaMania</strong>{" "}
              pour réserver ton terrain. Ta biométrie restera active ensuite.
            </div>
          )}
          <form onSubmit={submitResa}>
            <input
              type="text"
              placeholder="Identifiant (email)"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              // « webauthn » (quand la biométrie est active) branche l'autofill conditionnel :
              // le passkey apparaît dans la liste d'autocomplétion de ce champ.
              autoComplete={biometry ? "username webauthn" : "username"}
            />
            <div className="pwd-field">
              <input
                ref={passwordRef}
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
                // « webauthn » : autofill conditionnel du passkey sur ce champ (cf. onglet ResaMania),
                // seulement si la biométrie est active.
                autoComplete={biometry ? "email webauthn" : "email"}
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

      {/* Connexion biométrique en un geste (passkey), sous les formulaires. Juste l'empreinte,
          tappable comme un lecteur. Découvrable → pas d'email à saisir. N'apparaît que si
          l'appareil la supporte et que la biométrie est active (flag `biometry`). */}
      {biometry && pkSupported && (
        <div className="passkey-login">
          <button
            type="button"
            className="passkey-fab"
            onClick={() => doPasskeyLogin()}
            disabled={busy}
            aria-label="Se connecter avec Face ID / empreinte"
            title="Se connecter avec Face ID / empreinte"
          >
            <FingerprintIcon size={40} />
          </button>
        </div>
      )}

      {info && <div className="notice info">{info}</div>}
      {err && <div className="notice error">⚠️ {err}</div>}
      <PrivacyNotice />
    </main>
  );
}
