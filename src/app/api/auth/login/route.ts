import { NextRequest, NextResponse } from "next/server";
import { login } from "@/lib/resamania/client";
import { createSession, AccountDisabledError, normalizeEmail } from "@/lib/session";
import { clientIp } from "@/lib/client-ip";
import { prisma } from "@/lib/db";

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

// POST /api/auth/login { username, password }
export async function POST(req: NextRequest) {
  const { username, password } = await req.json().catch(() => ({}));
  if (typeof username !== "string" || typeof password !== "string" || !username || !password) {
    return NextResponse.json(
      { error: "Identifiant et mot de passe requis" },
      { status: 400 },
    );
  }

  const ip = clientIp(req);
  const account = normalizeEmail(username); // même clé quelle que soit la casse/les espaces
  const since = new Date(Date.now() - WINDOW_MS);
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

  try {
    const resa = await login({ username, password });
    // Connexion réussie : on efface l'ardoise de cette IP ET de ce compte (les fautes de frappe
    // précédentes ne doivent pénaliser ni les prochains logins du foyer/club, ni le membre).
    await prisma.loginAttempt.deleteMany({ where: { OR: [{ ip }, { identifier: account }] } });
    const sid = await createSession(resa);
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
    // Compte désactivé par un admin : l'authentification ResaMania a réussi, ce n'est PAS un
    // échec d'identifiants → 403 explicite, sans incrémenter le compteur anti-brute-force.
    if (e instanceof AccountDisabledError) {
      return NextResponse.json(
        { error: "Ce compte a été désactivé. Contacte un responsable du club." },
        { status: 403 },
      );
    }
    // Échec (identifiants invalides ou flux interrompu) : on incrémente les deux compteurs.
    await prisma.loginAttempt.create({ data: { ip, identifier: account } }).catch(() => {});
    // Détail journalisé côté serveur ; message générique pour ne rien divulguer de l'amont.
    console.error("[login] échec:", e);
    return NextResponse.json(
      { error: "Identifiants invalides ou service momentanément indisponible" },
      { status: 401 },
    );
  }
}
