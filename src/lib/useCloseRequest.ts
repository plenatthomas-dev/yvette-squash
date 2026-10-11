"use client";

import { useEffect, useRef, useState } from "react";

// ============================================================================
//  LE BOUTON RETOUR D'ANDROID FERME LE PANNEAU OUVERT, PAS L'APPLI.
//
//  LE DÉFAUT QU'IL CORRIGE. L'appli ne crée aucune entrée d'historique : ses
//  vues et ses fenêtres ne font que des `replaceState`. Dans l'appli Android
//  (TWA, cf. android/README.md) comme dans la PWA installée, le geste retour
//  n'avait donc rien à dépiler et FERMAIT L'APPLI — depuis la fiche d'une
//  rencontre, les Paramètres, le menu, n'importe quoi d'ouvert.
//
//  POURQUOI `CloseWatcher` ET PAS L'HISTORIQUE. Pousser une entrée d'historique
//  par fenêtre oblige à la retirer quand la fenêtre se ferme autrement (croix,
//  Échap, clic dehors) — un `history.back()` asynchrone qui se croise avec les
//  `replaceState` de la page et que le routeur de Next écoute lui aussi.
//  `CloseWatcher` est l'API faite pour ça : le retour d'Android déclenche le
//  `close` du dernier observateur créé, sans rien toucher à l'historique.
//  Chrome l'a depuis la version 126 ; ailleurs (iOS, Firefox) elle n'existe
//  pas, et rien ne change — Échap y reste géré par chaque composant.
//
//  ÉCHAP. `CloseWatcher` réagit aussi à Échap sur ordinateur. Les composants
//  qui le gèrent déjà eux-mêmes appellent `preventDefault()` sur la touche, ce
//  qui annule la demande de fermeture : pas de double fermeture.
// ============================================================================

interface CloseWatcherLike {
  onclose: (() => void) | null;
  destroy(): void;
}
type CloseWatcherCtor = new () => CloseWatcherLike;

/**
 * Appelle `onClose` sur une demande de fermeture du système (retour Android, Échap) tant que
 * `active` est vrai. Les observateurs s'empilent : le dernier panneau ouvert ferme le premier.
 */
export function useCloseRequest(onClose: () => void, active = true): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Un observateur ne sert qu'UNE fois : après son `close`, il est éteint. Si le panneau est
  // toujours là (fermeture refusée pendant un envoi, par exemple), on en recrée un — sinon le
  // retour suivant fermerait l'appli.
  const [armed, setArmed] = useState(0);

  useEffect(() => {
    if (!active) return;
    const Ctor = (globalThis as { CloseWatcher?: CloseWatcherCtor }).CloseWatcher;
    if (!Ctor) return;
    let watcher: CloseWatcherLike;
    try {
      watcher = new Ctor();
    } catch {
      return;
    }
    watcher.onclose = () => {
      onCloseRef.current();
      setArmed((n) => n + 1);
    };
    return () => watcher.destroy();
  }, [active, armed]);
}
