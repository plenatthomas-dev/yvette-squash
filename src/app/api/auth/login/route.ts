import { NextRequest, NextResponse } from "next/server";
import { login, isResaAuthRejected } from "@/lib/resamania/client";
import { createSession, AccountDisabledError, LoginRefusedError, normalizeEmail } from "@/lib/session";
import { clientIp } from "@/lib/client-ip";
import { prisma } from "@/lib/db";
import { isDbUnavailable, dbUnavailableResponse } from "@/lib/db-error";
import { appBlockForEmail, appBlockedResponse } from "@/lib/app-block";
import { MAX_PASSWORD_LEN } from "@/lib/email-auth";

export const runtime = "nodejs";

// Rate limiting : au-delà de MAX_FAILURES échecs en WINDOW_MS, on refuse SANS transmettre à
// ResaMania. Protège les comptes des membres du brute-force et évite que ResaMania blocklist
// les IP de l'appli. Le compteur vit en base (les fonctions serverless n'ont pas de mémoire
// partagée entre elles).
//
// DEUX dimensions, et il en faut deux :
//  - par IP : arrête celui qui balaie plusieurs comptes depuis une machine ;
//  - par COMPTE : arrête l'inverse, celui qui vise UN membre depuis plein d'IP (botnet, ou
//    simple rotation d'IP mobile). Une limite par IP seule ne protège pas un mot de passe donné.
// Le plafond par compte est plus large : plusieurs personnes peuvent partager une IP (club,
// foyer), alors que les échecs sur un même identifiant sont rarement légitimes.
const WINDOW_MS = 15 * 60_000; // 15 minutes
const MAX_FAILURES = 5; // par IP
const MAX_FAILURES_ACCOUNT = 10; // par identifiant visé

// Bornes d'entrée : 254 = longueur maximale d'une adresse (RFC 5321) ; le mot de passe reprend
// la borne de la connexion email (cf. lib/email-auth). Au-delà, c'est une requête fabriquée :
// on la refuse AVANT toute lecture en base ou appel à ResaMania, plutôt que de lui faire
// transporter (et compter, et stocker dans LoginAttempt.identifier) des mégaoctets.
const MAX_USERNAME_LEN = 254;

// POST /api/auth/login { username, password }
export async function POST(req: NextRequest) {
  const { username, password } = await req.json().catch(() => ({}));
  if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
    return NextResponse.json(
      { error: "Identifiant et mot de passe requis" },
      { status: 400 },
    );
  }
  if (username.length > MAX_USERNAME_LEN || password.length > MAX_PASSWORD_LEN) {
    return NextResponse.json({ error: "Identifiant ou mot de passe trop long" }, { status: 400 });
  }

  const ip = clientIp(req);
  const account = normalizeEmail(username); // même clé quelle que soit la casse/les espaces
  const since = new Date(Date.now() - WINDOW_MS);
  // Garde base : si la base est injoignable (Neon en veille / au-delà du quota compute), on répond
  // 503 « maintenance » lisible AU LIEU d'un 500 au corps vide qui casserait `res.json()` côté
  // client (cf. lib/apiFetch, lib/db-error).
  try {
    // Appli fermée par un admin (switch de /admin) : on refuse AVANT d'appeler ResaMania —
    // inutile de solliciter l'amont pour une connexion qu'on n'accordera pas. Les admins
    // traversent (l'authentification reste évidemment exigée juste après).
    const block = await appBlockForEmail(account);
    if (block) return appBlockedResponse(block);

    // Purge opportuniste des échecs sortis de la fenêtre (toutes IP : garde la table minuscule),
    // puis comptage sur les DEUX dimensions.
    await prisma.loginAttempt.deleteMany({ where: { createdAt: { lt: since } } });
    const [ipFailures, accountFailures] = await Promise.all([
      prisma.loginAttempt.count({ where: { ip, createdAt: { gte: since } } }),
      prisma.loginAttempt.count({ where: { identifier: account, createdAt: { gte: since } } }),
    ]);
    if (ipFailures >= MAX_FAILURES || accountFailures >= MAX_FAILURES_ACCOUNT) {
      // Message identique dans les deux cas : ne pas révéler laquelle des deux limites a sauté
      // (sinon on apprend à l'attaquant que le compte visé existe et est ciblé).
      return NextResponse.json(
        { error: "Trop de tentatives — réessaie dans quelques minutes." },
        { status: 429 },
      );
    }

    // Deux étapes, deux try DISTINCTS. Quand `login()` et `createSession()` partageaient le
    // même, toute erreur de createSession (email déjà pris par un autre compte → P2002,
    // CREDENTIALS_SECRET mal configuré…) devenait « Identifiants invalides » ET une tentative
    // échouée : un membre au bon mot de passe finissait bloqué par l'anti-brute-force, sans
    // qu'aucun message ne pointe la vraie cause. Seul un REFUS de ResaMania est compté.
    let resa;
    try {
      resa = await login({ username, password });
    } catch (e) {
      // Détail journalisé côté serveur ; message générique pour ne rien divulguer de l'amont.
      console.error("[login] échec ResaMania:", e);
      if (isResaAuthRejected(e)) {
        // Identifiants refusés par ResaMania : on incrémente les deux compteurs.
        await prisma.loginAttempt.create({ data: { ip, identifier: account } }).catch(() => {});
        return NextResponse.json({ error: "Identifiants invalides" }, { status: 401 });
      }
      // ResaMania indisponible (5xx, 429, réseau, délai) ou réponse inattendue : le membre n'y
      // est pour rien → 503, SANS compter de tentative (sinon une panne amont de quelques
      // minutes verrouillerait tout un club derrière une IP partagée). Pas de drapeau
      // `maintenance` : il annoncerait une panne de NOTRE base (cf. lib/apiFetch).
      return NextResponse.json(
        { error: "ResaMania ne répond pas pour le moment — réessaie dans quelques minutes." },
        { status: 503 },
      );
    }

    // Connexion réussie : on efface les échecs de CE COUPLE (IP, compte) — les fautes de frappe
    // du membre ne doivent pas le pénaliser à sa prochaine connexion.
    // Surtout PAS `OR: [{ ip }, { identifier }]`, l'ancienne forme : elle effaçait les échecs de
    // l'IP sur TOUS les comptes. Un attaquant muni d'UN compte valide pouvait alterner quatre
    // essais sur les comptes visés et une connexion réussie avec le sien, et remettre ainsi la
    // limite par IP à zéro indéfiniment. Prix à payer, assumé : les échecs d'un AUTRE membre
    // du même foyer/club restent comptés jusqu'au bout de leur fenêtre de 15 min.
    await prisma.loginAttempt.deleteMany({ where: { ip, identifier: account } });

    let sid: string;
    try {
      sid = await createSession(resa);
    } catch (e) {
      // Compte désactivé par un admin : l'authentification ResaMania a réussi, ce n'est PAS un
      // échec d'identifiants → 403 explicite, sans incrémenter le compteur anti-brute-force.
      if (e instanceof AccountDisabledError) {
        return NextResponse.json(
          { error: "Ce compte a été désactivé. Contacte un responsable du club." },
          { status: 403 },
        );
      }
      if (e instanceof LoginRefusedError) {
        console.warn("[login] connexion refusée:", e.reason);
        const error =
          e.reason === "foreign_club"
            ? "Ce compte ResaMania n'est pas rattaché au club. L'appli est réservée à ses membres."
            : e.reason === "identity_conflict"
              ? "Cette adresse est déjà liée à un autre compte ResaMania. Contacte un responsable du club."
              : "Connexion refusée. Contacte un responsable du club.";
        return NextResponse.json({ error }, { status: 403 });
      }
      // Base injoignable : on la laisse remonter à la garde externe (→ 503 « maintenance »).
      if (isDbUnavailable(e)) throw e;
      // Toute autre erreur est NOTRE problème (contrainte d'unicité, chiffrement mal configuré…),
      // pas celui du membre : 500 lisible, journalisé, jamais compté comme tentative.
      console.error("[login] ouverture de session impossible:", e);
      return NextResponse.json(
        {
          error:
            "Connexion impossible pour le moment (erreur de l'appli). Préviens un responsable du club.",
        },
        { status: 500 },
      );
    }

    const res = NextResponse.json({
      displayName: `${resa.identity.givenName} ${resa.identity.familyName}`.trim(),
    });
    res.cookies.set("sid", sid, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    return res;
  } catch (e) {
    if (isDbUnavailable(e)) return dbUnavailableResponse();
    throw e; // vraie erreur inattendue → laisse Next répondre 500
  }
}
