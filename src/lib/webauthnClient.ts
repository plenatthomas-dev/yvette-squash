"use client";

// Wrappers navigateur pour la connexion biométrique (passkeys). La biométrie est gérée par
// l'OS (Face ID / Touch ID / empreinte) ; ici on ne fait qu'orchestrer les allers-retours
// avec nos routes /api/auth/webauthn/**.

import {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
  platformAuthenticatorIsAvailable,
} from "@simplewebauthn/browser";

export type PasskeyResult = { ok: boolean; error?: string };

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
export async function loginWithPasskey(): Promise<PasskeyResult> {
  try {
    const optRes = await fetch("/api/auth/webauthn/auth/options", { method: "POST" });
    if (!optRes.ok) return { ok: false, error: await readError(optRes, "Connexion impossible.") };
    const optionsJSON = await optRes.json();
    const response = await startAuthentication({ optionsJSON });
    const verifyRes = await fetch("/api/auth/webauthn/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response }),
    });
    if (!verifyRes.ok) return { ok: false, error: await readError(verifyRes, "Connexion refusée.") };
    markPasskeyOnDevice();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: humanizeError(e) };
  }
}
