import { AJAX_URL, TIMEOUT_MS, UA } from "./client";

// ============================================================================
//  UNE SESSION SQUASHNET AU NOM DU CAPITAINE — le temps d'une requête.
//
//  La page capitaine de squashnet n'a pas d'API : c'est le même point d'entrée
//  AJAX que les pages publiques (`index.php` + `ic_a`), derrière une connexion
//  par identifiant et mot de passe. Ce module tient le POT À COOKIES de cette
//  connexion, en mémoire, et rien d'autre.
//
//  ⚠️ LES IDENTIFIANTS NE FONT QUE PASSER. Ils arrivent dans le corps de la
//  requête du capitaine, partent dans le `POST` de connexion, et ne sont ni
//  stockés, ni journalisés, ni repris dans un message d'erreur — toutes les
//  erreurs de ce module ont un texte FIXE. Le cookie de session obtenu meurt
//  avec l'objet : aucune base, aucun cache, aucune réponse ne le porte.
//
//  LE JETON ANTI-FALSIFICATION. squashnet pose un cookie `ic_csrf` et le
//  réclame dans chaque `POST` (« Session expirée ou requête invalide » sans
//  lui, mesuré le 16/10/2026) — c'est ce que fait son propre JavaScript.
// ============================================================================

const BASE = new URL(AJAX_URL).origin;

/** Action AJAX de la connexion (formulaire de `/connexion`). */
const ACTION_CONNEXION = "131328";

/**
 * Ce qu'un navigateur joint à chaque `POST` du site. Rien ne dit que squashnet les contrôle ;
 * s'il le fait un jour, un envoi sans eux échouerait au moment précis où le capitaine valide.
 */
const ORIGINE = { origin: BASE, referer: `${BASE}/captain` };

/**
 * squashnet refuse l'accès : identifiants faux, ou compte qui n'est pas capitaine de cette
 * équipe. La page de refus est la même dans les deux cas (« Erreur 403, merci de vous connecter
 * avec le bon compte »), donc le message aussi.
 */
export class AccesRefuse extends Error {
  constructor() {
    super("squashnet refuse l'accès");
    this.name = "AccesRefuse";
  }
}

/** Le jeton ou la session a expiré entre deux appels. */
export class SessionInvalide extends Error {
  constructor() {
    super("session squashnet expirée");
    this.name = "SessionInvalide";
  }
}

export interface SessionSquashnet {
  readonly cookies: Map<string, string>;
}

function absorber(s: SessionSquashnet, res: Response): void {
  for (const c of res.headers.getSetCookie()) {
    const paire = c.split(";")[0];
    const i = paire.indexOf("=");
    if (i > 0) s.cookies.set(paire.slice(0, i).trim(), paire.slice(i + 1).trim());
  }
}

const jeton = (s: SessionSquashnet) => decodeURIComponent(s.cookies.get("ic_csrf") ?? "");

async function appeler(s: SessionSquashnet, chemin: string, init: RequestInit): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(BASE + chemin, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        "user-agent": UA,
        cookie: [...s.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      },
      // Une redirection emporterait ses cookies sans qu'on les voie passer.
      redirect: "manual",
      signal: ctrl.signal,
    });
    absorber(s, res);
    if (res.status >= 400) throw new Error(`squashnet a répondu ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Les deux réponses qui ne sont pas des contenus, mais des refus. */
function verifier(html: string): string {
  if (/Erreur 403|merci de vous connecter/i.test(html)) throw new AccesRefuse();
  if (/Session expirée ou requête invalide/i.test(html)) throw new SessionInvalide();
  return html;
}

/**
 * Se connecte au nom du capitaine. Ne VÉRIFIE pas la connexion : la réponse de squashnet n'est
 * pas documentée, et deviner un échec dans son texte serait fragile. C'est le premier appel
 * suivant qui tranche (`AccesRefuse`), sur la page de refus que squashnet sert à tout visiteur
 * non autorisé — celle-là, on l'a vue.
 */
export async function ouvrirSession(login: string, motDePasse: string): Promise<SessionSquashnet> {
  const s: SessionSquashnet = { cookies: new Map() };
  const page = await appeler(s, "/connexion", { method: "GET" });
  const csrf = /name=["']ic_csrf["'][^>]*value=["']([^"']*)["']/.exec(page)?.[1] ?? jeton(s);
  if (!csrf) throw new Error("squashnet : page de connexion sans jeton");
  await appeler(s, "/index.php", {
    method: "POST",
    headers: {
      ...ORIGINE,
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "x-requested-with": "XMLHttpRequest",
    },
    body: new URLSearchParams({
      ic_a: ACTION_CONNEXION,
      ic_ajax: "1",
      ic_csrf: csrf,
      login,
      pwd: motDePasse,
    }).toString(),
  });
  return s;
}

/** Un appel AJAX authentifié — lecture d'une section de l'espace capitaine. */
export async function posterAjax(s: SessionSquashnet, params: Record<string, string>): Promise<string> {
  return verifier(
    await appeler(s, "/index.php", {
      method: "POST",
      headers: {
        ...ORIGINE,
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
      },
      body: new URLSearchParams({ ...params, ic_ajax: "1", ic_csrf: jeton(s) }).toString(),
    }),
  );
}

/**
 * L'envoi d'un formulaire, en `multipart/form-data` comme le fait le site (`enctype` du
 * formulaire de saisie). La frontière est posée par `fetch` : on ne fixe pas `content-type`.
 */
export async function posterFormulaire(
  s: SessionSquashnet,
  champs: Record<string, string>,
): Promise<string> {
  const corps = new FormData();
  for (const [k, v] of Object.entries(champs)) corps.append(k, v);
  corps.set("ic_ajax", "1");
  corps.set("ic_csrf", jeton(s));
  return verifier(
    await appeler(s, "/index.php", {
      method: "POST",
      headers: { ...ORIGINE, "x-requested-with": "XMLHttpRequest" },
      body: corps,
    }),
  );
}
