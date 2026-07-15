"use client";

// Bannière d'annonce (étape 2 de l'admin) : message éditable par un admin, affiché à TOUS.
// Rendu « bien visible » (choix UX « les deux ») :
//  1) une MODALE la première fois qu'un MEMBRE CONNECTÉ voit une annonce donnée (impossible
//     à rater). Jamais hors connexion : elle recouvrirait l'écran de login ;
//  2) une BANNIÈRE pleine couleur en haut, tant que l'annonce est active — elle, publique.
// Les deux se pilotent depuis un seul fetch et se ferment indépendamment. Une annonce MODIFIÉE
// (nouvelle `version`) repasse devant les yeux (modale + bannière ré-affichées).
//
// Où vit le « déjà vu » ? Pour un membre CONNECTÉ : sur son COMPTE (en base). `localStorage`
// est lié à l'appareil — il fuitait donc d'un membre à l'autre sur un téléphone partagé, et
// devait être oublié à la déconnexion, ce qui remontrait l'annonce à chaque reconnexion. Le
// masquage suit maintenant le membre, y compris d'un appareil à l'autre.
// Pour un visiteur NON connecté (écran de login) : `localStorage`, faute de compte où le poser.

import { useCallback, useEffect, useRef, useState } from "react";

type Banner = { message: string; level: "info" | "warn"; version: string };
type Seen = { dismissedVersion: string | null; modalSeenVersion: string | null };

// Masquage du bandeau pour un visiteur NON connecté uniquement (un membre connecté, lui, est
// suivi en base). La modale ne s'affichant jamais hors connexion, elle n'a pas d'équivalent ici.
const ANON_DISMISS_KEY = "bannerDismissed";
// Demande de réévaluation immédiate. La bannière vit dans le LAYOUT : elle ne se remonte
// jamais, et une navigation interne ou une connexion ne déclenchent ni `focus` ni
// `visibilitychange`. Sans ce signal explicite, une annonce n'apparaît qu'au rechargement.
const RECHECK_EVENT = "banner-recheck";

/**
 * Relit l'annonce côté serveur et réévalue son affichage, tout de suite.
 * À appeler dès qu'elle a pu changer sans que la page bouge : publication depuis /admin,
 * connexion, déconnexion.
 */
export function recheckBanner(): void {
  window.dispatchEvent(new Event(RECHECK_EVENT));
}

// Couleurs pleines et saturées (texte blanc) pour bien trancher avec l'appli.
const palette = {
  info: { bg: "#2563eb", fg: "#ffffff" },
  warn: { bg: "#ea580c", fg: "#ffffff" },
} as const;

export default function AnnouncementBanner() {
  const [banner, setBanner] = useState<Banner | null>(null);
  const [showBanner, setShowBanner] = useState(false);
  const [showModal, setShowModal] = useState(false);
  // Connecté ⇒ le masquage se mémorise en base, pas dans ce navigateur.
  const [authenticated, setAuthenticated] = useState(false);
  // Défilement (marquee) du message quand il dépasse la largeur du bandeau.
  const boxRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [scroll, setScroll] = useState(false);
  const [durationS, setDurationS] = useState(16);
  const lastFetchRef = useRef(0);

  const load = useCallback(async () => {
    try {
      // no-store : la réponse ne porte aucun en-tête de cache, on ne veut pas que le
      // navigateur resserve une annonce périmée (ou son absence) depuis sa copie.
      const res = await fetch("/api/banner", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as {
        banner: Banner | null;
        authenticated?: boolean;
        seen?: Seen | null;
      };
      const b = data.banner;
      const authed = data.authenticated === true;
      setAuthenticated(authed);
      setBanner(b); // `null` = annonce retirée par l'admin → on cesse de l'afficher
      if (!b) return;

      if (authed) {
        // Membre connecté : c'est son COMPTE qui fait foi (le suit d'un appareil à l'autre).
        setShowBanner(data.seen?.dismissedVersion !== b.version);
        setShowModal(data.seen?.modalSeenVersion !== b.version);
      } else {
        // Visiteur : pas de compte où mémoriser → le navigateur. Et JAMAIS de modale, elle
        // recouvrirait l'écran de login (il faudrait la fermer avant de pouvoir s'y connecter).
        setShowBanner(localStorage.getItem(ANON_DISMISS_KEY) !== b.version);
        setShowModal(false);
      }
    } catch {
      /* réseau indisponible : pas d'annonce, sans bruit */
    }
  }, []);

  // Trois déclencheurs, car ce composant ne se remonte jamais (il vit dans le layout) :
  //  - le montage (premier chargement de l'appli) ;
  //  - le RETOUR sur l'appli (focus/visibilitychange), throttlé 15 s comme le planning, pour
  //    l'annonce publiée pendant qu'un membre avait l'appli ouverte en arrière-plan ;
  //  - RECHECK_EVENT, pour les changements que ces deux-là ne voient PAS : publication depuis
  //    /admin, connexion, déconnexion — aucun ne provoque de remontage ni de focus.
  useEffect(() => {
    load();
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastFetchRef.current < 15000) return;
      lastFetchRef.current = now;
      load();
    };
    const onRecheck = () => {
      lastFetchRef.current = Date.now();
      load();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener(RECHECK_EVENT, onRecheck);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener(RECHECK_EVENT, onRecheck);
    };
  }, [load]);

  // Active le défilement seulement si le texte déborde ; vitesse constante (durée ∝ distance).
  useEffect(() => {
    if (!showBanner || !banner) return;
    const measure = () => {
      const box = boxRef.current;
      const txt = textRef.current;
      if (!box || !txt) return;
      const overflow = txt.scrollWidth > box.clientWidth + 2;
      setScroll(overflow);
      if (overflow) setDurationS(Math.max(10, (2 * txt.scrollWidth) / 80)); // ~80 px/s
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [showBanner, banner]);

  if (!banner) return null;
  const c = palette[banner.level];

  /**
   * Mémorise le masquage : sur le COMPTE si le membre est connecté (il ne reverra plus
   * l'annonce, même après déconnexion ou depuis un autre appareil), sinon dans ce navigateur.
   * Best-effort : on masque tout de suite à l'écran quoi qu'il arrive — au pire l'annonce
   * réapparaîtra au prochain chargement, ce qui vaut mieux qu'un clic sans effet visible.
   */
  const remember = (what: "banner" | "modal") => {
    if (authenticated) {
      fetch("/api/banner/dismiss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ what, version: banner.version }),
      }).catch(() => {
        /* réseau KO : masqué pour cette session, réapparaîtra plus tard */
      });
      return;
    }
    // Visiteur non connecté : seul le bandeau est concerné (pas de modale hors connexion).
    try {
      localStorage.setItem(ANON_DISMISS_KEY, banner.version);
    } catch {
      /* localStorage indisponible : on masque au moins pour la session */
    }
  };

  const closeModal = () => {
    remember("modal");
    setShowModal(false);
  };

  const dismissBanner = () => {
    remember("banner");
    setShowBanner(false);
  };

  return (
    <>
      {/* Bannière pleine couleur, en haut de l'appli. */}
      {showBanner && (
        <div
          role="status"
          style={{
            background: c.bg,
            color: c.fg,
            padding: "12px 16px",
            display: "flex",
            alignItems: "center",
            gap: 12,
            fontSize: "0.95rem",
            fontWeight: 600,
            lineHeight: 1.4,
          }}
        >
          <span aria-hidden style={{ fontSize: "1.15rem" }}>
            📣
          </span>
          <div
            ref={boxRef}
            style={{ flex: 1, overflow: "hidden", textAlign: scroll ? "left" : "center" }}
          >
            <span
              ref={textRef}
              className={scroll ? "announce-marquee" : undefined}
              style={{
                display: "inline-block",
                whiteSpace: "nowrap",
                ...(scroll ? { animationDuration: `${durationS}s` } : null),
              }}
            >
              {banner.message}
            </span>
          </div>
          <button
            type="button"
            onClick={dismissBanner}
            aria-label="Masquer l'annonce"
            style={{
              background: "transparent",
              border: "none",
              color: c.fg,
              cursor: "pointer",
              padding: 0,
              margin: 0,
              width: "auto",
              fontSize: "1.15rem",
              lineHeight: 1,
              opacity: 0.9,
            }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Modale la première fois qu'on voit cette annonce. */}
      {showModal && (
        <div className="modal-overlay" onClick={closeModal}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Annonce"
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 8 }}>
              <h3 style={{ margin: 0, flex: 1 }}>📣 Annonce</h3>
              <button
                type="button"
                onClick={closeModal}
                aria-label="Fermer"
                style={{
                  background: "transparent",
                  border: "none",
                  color: "inherit",
                  cursor: "pointer",
                  padding: 0,
                  margin: 0,
                  width: "auto",
                  fontSize: "1.3rem",
                  lineHeight: 1,
                }}
              >
                ✕
              </button>
            </div>
            <p style={{ margin: "0 0 18px", whiteSpace: "pre-wrap", color: "var(--pico-color)" }}>
              {banner.message}
            </p>
            <div className="modal-actions">
              <button type="button" onClick={closeModal}>
                Fermer
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
