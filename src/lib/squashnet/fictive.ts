// Module PUR, sans dépendance réseau : l'écran interclub (client) l'importe aussi, pour filtrer
// les classements déjà en cache, relevés avant que le parseur n'écarte ces lignes.

/**
 * Une équipe fictive de la fédération — « Non Joue » ou « EXEMPT » — qui complète une poule
 * impaire. Elle occupe un rang mais ne joue jamais : l'afficher ferait croire à un club de plus.
 */
export function estEquipeFictive(name: string): boolean {
  return /^(non\s*jou|exempt\b)/i.test(name.trim());
}
