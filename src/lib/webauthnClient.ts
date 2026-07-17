"use client";

// Wrappers navigateur pour la connexion biométrique (passkeys). La biométrie est gérée par
// l'OS (Face ID / Touch ID / empreinte) ; ici on ne fait qu'orchestrer les allers-retours
// avec nos routes /api/auth/webauthn/**.

import {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  platformAuthenticatorIsAvailable,
} from "@simplewebauthn/browser";

export type PasskeyResult = {
  ok: boolean;
  error?: string;
  // Renseignés quand la biométrie a RÉUSSI mais qu'aucune session n'a pu s'ouvrir (lien ResaMania
  // expiré, pas de repli e-mail) : `code === "resa_expired"` + `username` (l'identifiant à
  // pré-remplir). Le client bascule alors sur le formulaire ResaMania au lieu d'afficher une erreur.
  code?: string;
  username?: string;
};

// Indicateur LOCAL (par appareil) « un passkey a déjà été utilisé ici ». Sert à ne proposer
// l'auto-connexion biométrique au lancement QUE sur les appareils déjà configurés — jamais de
// modale surprise sur un appareil vierge. Posé après un enrôlement ou une connexion réussis.
const PK_HINT = "pk_on_device";
export function hasPasskeyOnDevice(): boolean {
  try {
    return localStorage.getItem(PK_HINT) === "1";
  } catch {
    return false;
  }
}
function markPasskeyOnDevice(): void {
  try {
    localStorage.setItem(PK_HINT, "1");
  } catch {
    /* localStorage indisponible : tant pis, pas d'auto-connexion */
  }
}
export function forgetPasskeyOnDevice(): void {
  try {
    localStorage.removeItem(PK_HINT);
  } catch {
    /* ignore */
  }
}

// Vrai si l'appareil a un authenticator « plateforme » (biométrie intégrée). Sert à n'afficher
// les boutons biométrie que là où ça peut marcher (téléphone surtout).
export async function passkeySupported(): Promise<boolean> {
  if (!browserSupportsWebAuthn()) return false;
  return platformAuthenticatorIsAvailable().catch(() => false);
}

// Vrai si le navigateur gère l'« autofill conditionnel » (Conditional UI) : le passkey apparaît
// dans la liste d'autocomplétion d'un champ (au lieu d'une modale imposée). C'est le mécanisme
// recommandé — non intrusif, et il marche là où l'auto-ouverture de modale est bloquée (iOS
// Safari sans geste utilisateur). Support distinct de `passkeySupported` (peut être vrai même
// sans biométrie plateforme, ex. gestionnaire de mots de passe sur desktop).
export async function passkeyAutofillSupported(): Promise<boolean> {
  if (!browserSupportsWebAuthn()) return false;
  return browserSupportsWebAuthnAutofill().catch(() => false);
}

// L'utilisateur a annulé le prompt biométrique (ou l'a laissé expirer) → message doux.
function humanizeError(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "AbortError") {
    return "Connexion biométrique annulée.";
  }
  if (name === "InvalidStateError") {
    return "Ce passkey est déjà enregistré sur cet appareil.";
  }
  return "La biométrie n'a pas pu aboutir sur cet appareil.";
}

async function readError(res: Response, fallback: string): Promise<string> {
  return ((await res.json().catch(() => ({}))) as { error?: string }).error ?? fallback;
}

// Enrôle un passkey pour le compte « email seul » connecté.
export async function enrollPasskey(deviceLabel?: string): Promise<PasskeyResult> {
  try {
    const optRes = await fetch("/api/auth/webauthn/register/options", { method: "POST" });
    if (!optRes.ok) return { ok: false, error: await readError(optRes, "Enrôlement impossible.") };
    const optionsJSON = await optRes.json();
    const response = await startRegistration({ optionsJSON });
    const verifyRes = await fetch("/api/auth/webauthn/register/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response, deviceLabel }),
    });
    if (!verifyRes.ok) return { ok: false, error: await readError(verifyRes, "Enrôlement refusé.") };
    markPasskeyOnDevice();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: humanizeError(e) };
  }
}

// Connexion par passkey (usernameless) : ouvre une session « email seul ».
//
// `useAutofill` : démarre en mode Conditional UI. L'appel `startAuthentication` reste alors en
// attente en arrière-plan et ne se résout QUE lorsque l'utilisateur choisit un passkey dans
// l'autocomplétion du champ (il faut un <input autocomplete="… webauthn"> à l'écran). Sur un
// clic explicite (bouton empreinte), on rappelle sans autofill : simplewebauthn annule alors
// proprement la cérémonie autofill en cours (WebAuthnAbortService) au profit de la modale.
export async function loginWithPasskey(
  opts: { useAutofill?: boolean } = {},
): Promise<PasskeyResult> {
  try {
    const optRes = await fetch("/api/auth/webauthn/auth/options", { method: "POST" });
    if (!optRes.ok) return { ok: false, error: await readError(optRes, "Connexion impossible.") };
    const optionsJSON = await optRes.json();
    const response = await startAuthentication({
      optionsJSON,
      useBrowserAutofill: opts.useAutofill === true,
    });
    const verifyRes = await fetch("/api/auth/webauthn/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response }),
    });
    if (!verifyRes.ok) {
      // On lit le corps en entier (pas juste `error`) : le 409 « ResaMania expirée » y joint
      // `code` + `username` pour permettre au client de pré-remplir la reconnexion.
      const data = (await verifyRes.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
        username?: string;
      };
      return {
        ok: false,
        error: data.error ?? "Connexion refusée.",
        code: data.code,
        username: data.username,
      };
    }
    markPasskeyOnDevice();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: humanizeError(e) };
  }
}
