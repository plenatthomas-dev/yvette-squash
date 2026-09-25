"use client";

import {
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { COLOR_PRESETS, hexToHsv, hsvToHex, resolveColor, type Hsv } from "@/lib/interclub";

// Partagé par la saisie d'un simple d'interclub et par le marqueur libre : même pastille, même
// palette, même choix libre. Valeur `""` = pas de couleur.

/**
 * Sélecteur compact : une pastille posée à droite du nom, qui déplie une grille de couleurs.
 * Un `<select>` pleine largeur mangeait un tiers de l'écran pour une information secondaire,
 * et n'affichait la couleur que par son nom — alors que c'est justement le repère visuel.
 */
// Couleur de maillot : une pastille qui ouvre une palette. Elle sert à distinguer les deux
// joueurs d'un coup d'œil sur l'écran de marquage, montré à bout de bras — d'où la palette
// restreinte (`COLOR_PRESETS`) et l'alerte quand les deux couleurs sont trop proches
// (`colorsTooClose`) : deux maillots indiscernables rendent le marqueur hésitant au pire
// moment.
export default function ColorPicker({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  /** Le panneau « autre couleur » est-il déplié ? */
  const [free, setFree] = useState(false);
  const current = resolveColor(value);
  const isCustom = !!current && !COLOR_PRESETS.some((c) => c.hex === current.bg);

  const hsv = hexToHsv(current?.bg ?? "") ?? { h: 0, s: 0.7, v: 0.8 };
  const pose = (next: Hsv) => onChange(hsvToHex(next));
  const borne = (u: number) => Math.min(1, Math.max(0, u));

  const areaRef = useRef<HTMLDivElement>(null);
  /** Traduit un point de l'aire en saturation/valeur. Origine en haut à gauche. */
  const pointer = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = areaRef.current?.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0) return;
    pose({
      ...hsv,
      s: borne((e.clientX - r.left) / r.width),
      v: 1 - borne((e.clientY - r.top) / r.height),
    });
  };

  const PAS = 0.02;
  const clavier = (e: KeyboardEvent<HTMLDivElement>) => {
    const gestes: Record<string, [number, number]> = {
      ArrowLeft: [-PAS, 0],
      ArrowRight: [PAS, 0],
      ArrowUp: [0, PAS],
      ArrowDown: [0, -PAS],
    };
    const g = gestes[e.key];
    if (!g) return;
    e.preventDefault();
    const f = e.shiftKey ? 5 : 1;
    pose({ ...hsv, s: borne(hsv.s + g[0] * f), v: borne(hsv.v + g[1] * f) });
  };

  return (
    <span className="ic-picker">
      <button
        type="button"
        className="ic-swatch-btn"
        aria-label={current ? `${label} : ${current.label}. Changer` : `${label} : choisir une couleur`}
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
          setFree(false);
        }}
        style={current ? { background: current.bg, borderColor: current.fg } : undefined}
      >
        {!current && <span aria-hidden="true">?</span>}
      </button>

      {open && (
        <span className="ic-swatches">
          <span className="ic-swatch-grid">
            {COLOR_PRESETS.map((c) => (
              <button
                key={c.key}
                type="button"
                aria-label={c.label}
                className={`ic-swatch${value.toLowerCase() === c.hex ? " is-on" : ""}`}
                style={{ background: c.hex }}
                title={c.label}
                onClick={() => {
                  onChange(c.hex);
                  setOpen(false);
                }}
              />
            ))}

            {/* Déplie l'aire de choix libre, au lieu d'appeler le sélecteur du système : celui-ci
                présente, selon la plateforme, trois curseurs teinte/saturation/valeur où l'on
                cherche une couleur à l'aveugle. L'aire carrée montre d'un coup toutes les
                nuances d'une teinte — c'est le geste que tout le monde connaît. */}
            <button
              type="button"
              className={`ic-swatch ic-swatch-free${isCustom ? " is-custom" : ""}${free ? " is-on" : ""}`}
              aria-expanded={free}
              title={isCustom ? `Couleur personnalisée ${current?.bg}` : "Autre couleur…"}
              style={isCustom && current ? { background: current.bg } : undefined}
              onClick={() => setFree((f) => !f)}
            >
              <span className="sr-only">Choisir une autre couleur</span>
            </button>

            <button
              type="button"
              aria-label="Aucune couleur"
              className={`ic-swatch ic-swatch-none${value === "" ? " is-on" : ""}`}
              title="Aucune couleur"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
            >
              <span aria-hidden="true">✕</span>
            </button>
          </span>

          {free && (
            <span className="ic-free">
              {/* L'aire : saturation en abscisse, valeur en ordonnée, sur la teinte courante.
                  Deux dégradés superposés — blanc→transparent, puis transparent→noir — donnent
                  exactement le carré classique, sans une seule image. */}
              <div
                ref={areaRef}
                className="ic-free-area"
                style={{ backgroundColor: hsvToHex({ h: hsv.h, s: 1, v: 1 }) }}
                role="application"
                aria-label="Saturation et luminosité — flèches pour ajuster"
                tabIndex={0}
                onKeyDown={clavier}
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  pointer(e);
                }}
                onPointerMove={(e) => {
                  if (e.buttons !== 0) pointer(e);
                }}
              >
                <span
                  className="ic-free-dot"
                  style={{
                    left: `${hsv.s * 100}%`,
                    top: `${(1 - hsv.v) * 100}%`,
                    background: current?.bg ?? "#888888",
                  }}
                />
              </div>

              {/* La teinte reste un curseur natif : une seule dimension, accessible au clavier
                  sans une ligne de code, et déjà annoncée par les lecteurs d'écran. Avec les
                  flèches sur l'aire, c'est ce qui garantit que tout se fait sans souris. */}
              <input
                className="ic-free-hue"
                type="range"
                min={0}
                max={359}
                value={Math.round(hsv.h)}
                aria-label="Teinte"
                onChange={(e) => pose({ ...hsv, h: Number(e.target.value) })}
              />

            </span>
          )}
        </span>
      )}
    </span>
  );
}
