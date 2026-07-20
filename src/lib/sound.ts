"use client";

// Sons de l'appli (jingle de confirmation) via l'API Web Audio — aucun fichier audio à
// charger : le jingle est SYNTHÉTISÉ (petit arpège), donc léger et disponible hors-ligne.
//
// Contrainte mobile importante : les navigateurs (surtout iOS) exigent un GESTE utilisateur
// pour autoriser l'audio. Un `AudioContext` créé hors interaction reste « suspended » et muet.
// On le débloque donc au PREMIER tap/clic n'importe où dans l'appli (`unlockAudio`), puis on
// peut jouer un son plus tard (ex. après le POST de réservation), même si le succès arrive de
// façon asynchrone — le contexte est déjà « running ».
//
// Réglage on/off : mémorisé dans localStorage (clé `soundEnabled`), activé par défaut. La
// section « Son de confirmation » des Paramètres écrit cette clé ; ici on ne fait que la lire.

const ENABLED_KEY = "soundEnabled";

let ctx: AudioContext | null = null;
let unlockBound = false;

// Préférence son : activée par défaut (localStorage vaut null au premier lancement).
export function isSoundEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) !== "0";
  } catch {
    return true;
  }
}

export function setSoundEnabled(on: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, on ? "1" : "0");
  } catch {
    /* localStorage indisponible : le réglage ne persistera pas, tant pis */
  }
}

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (ctx) return ctx;
  const Ctor = window.AudioContext || (window as WebkitWindow).webkitAudioContext;
  if (!Ctor) return null; // navigateur sans Web Audio → on renonce silencieusement
  try {
    ctx = new Ctor();
  } catch {
    ctx = null;
  }
  return ctx;
}

/**
 * À appeler UNE fois au montage de l'appli. Attache des écouteurs « one-shot » qui, au premier
 * geste utilisateur, créent et « réveillent » l'AudioContext (indispensable sur iOS). Sans geste,
 * aucun son n'est joué : c'est la règle des navigateurs, pas un bug.
 */
export function unlockAudio(): void {
  if (typeof window === "undefined" || unlockBound) return;
  unlockBound = true;

  const unlock = () => {
    const c = getCtx();
    if (c && c.state === "suspended") c.resume().catch(() => {});
    // Bip inaudible pour finir de déverrouiller la sortie sur iOS (durée ~0, gain 0).
    if (c) {
      try {
        const osc = c.createOscillator();
        const gain = c.createGain();
        gain.gain.value = 0;
        osc.connect(gain).connect(c.destination);
        osc.start();
        osc.stop(c.currentTime + 0.01);
      } catch {
        /* pas grave : le prochain vrai son passera si le contexte est réveillé */
      }
    }
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
    window.removeEventListener("touchstart", unlock);
  };

  window.addEventListener("pointerdown", unlock, { once: true });
  window.addEventListener("keydown", unlock, { once: true });
  window.addEventListener("touchstart", unlock, { once: true });
}

/**
 * Joue un petit jingle de succès (~1,6 s) : arpège ascendant Do–Mi–Sol–Do puis une note tenue,
 * avec une enveloppe douce (attaque courte, longue décroissance) pour un rendu « cloche » discret.
 * No-op si le son est désactivé, si le navigateur n'a pas Web Audio, ou si l'audio n'a pas encore
 * été déverrouillé par un geste.
 */
export function playSuccessJingle(): void {
  if (!isSoundEnabled()) return;
  const c = getCtx();
  if (!c) return;
  if (c.state === "suspended") c.resume().catch(() => {});

  const now = c.currentTime + 0.02;
  // Do5, Mi5, Sol5, Do6 (Hz). Arpège majeur = sonorité « réussite » claire et positive.
  const notes = [523.25, 659.25, 783.99, 1046.5];
  const step = 0.13; // écart entre les notes de l'arpège
  const master = 0.18; // volume global modéré (ne pas agresser)

  notes.forEach((freq, i) => {
    const t0 = now + i * step;
    // La dernière note est tenue plus longtemps (résolution du jingle).
    const dur = i === notes.length - 1 ? 0.9 : 0.28;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "triangle"; // plus doux/rond qu'un sinus pur, sans être criard
    osc.frequency.value = freq;
    // Enveloppe : montée quasi immédiate puis décroissance exponentielle.
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(master, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain).connect(c.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  });
}
