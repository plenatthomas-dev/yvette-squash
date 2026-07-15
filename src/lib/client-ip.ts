import type { NextRequest } from "next/server";

/**
 * IP du client, telle qu'on peut la croire — SOURCE UNIQUE, à utiliser partout où l'on
 * compte quelque chose « par IP » (anti-brute-force, anti-spam).
 *
 * ⚠️ Le piège : `x-forwarded-for` est un en-tête, donc le client peut en envoyer un. On ne
 * fait confiance qu'à ce que la PLATEFORME a posé :
 *  - `x-real-ip` d'abord : posé par Vercel, jamais repris de la requête entrante ;
 *  - à défaut, la DERNIÈRE entrée de `x-forwarded-for` : la chaîne se lit de gauche (le plus
 *    lointain, donc le plus douteux) à droite (le proxy le plus proche de nous). Prendre la
 *    PREMIÈRE, c'est prendre la valeur que l'attaquant contrôle : il lui suffirait de la
 *    randomiser à chaque requête pour que tout compteur par IP reste à zéro.
 *
 * Ce module existe parce que cette fonction a longtemps eu DEUX implémentations divergentes
 * (dont une naïve sur la route de login, la plus sensible). Une primitive de sécurité ne se
 * duplique pas : elle dérive.
 *
 * `"local"` en dernier recours (dev sans proxy) : tout le monde partage alors le même
 * compteur, ce qui est le comportement le plus strict — jamais le plus permissif.
 */
export function clientIp(req: NextRequest): string {
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return "local";
}
