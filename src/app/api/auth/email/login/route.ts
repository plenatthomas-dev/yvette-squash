import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/crypto";
import { normalizeEmail, createEmailSession } from "@/lib/session";
import { getFeatures } from "@/lib/features-server";
import { EMAIL_RE, clientIp } from "@/lib/email-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 jours

// Rate limiting partagé avec la connexion ResaMania. Compteur en base (les fonctions
// serverless n'ont pas de mémoire partagée entre elles).
//
// DEUX dimensions, et il en faut deux :
//  - par IP : arrête celui qui balaie plusieurs comptes depuis une machine ;
//  - par COMPTE : arrête l'inverse, celui qui vise UN membre depuis plein d'IP (botnet, ou
//    simple rotation d'IP mobile). Une limite par IP seule ne protège pas un mot de passe donné.
// Le plafond par compte est plus large : plusieurs personnes peuvent partager une IP (club,
// foyer), alors que les échecs sur un même identifiant sont rarement légitimes.
const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 5; // par IP
const MAX_FAILURES_ACCOUNT = 10; // par identifiant visé

// Hash « leurre » calculé une fois : sert à dépenser le même temps CPU quand l'email n'a pas
// de compte, pour ne pas révéler par le timing si un compte existe (anti-énumération).
const dummyHash = hashPassword("timing-equalizer-not-a-real-password");

// POST /api/auth/email/login  { email, password }
export async function POST(req: NextRequest) {
  if (!(await getFeatures()).emailLogin) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
  const body = (await req.json().catch(() => ({}))) as { email?: unknown; password?: unknown };
  if (typeof body.email !== "string" || typeof body.password !== "string" || !body.password) {
    return NextResponse.json({ error: "Email et mot de passe requis." }, { status: 400 });
  }
  if (!EMAIL_RE.test(body.email.trim())) {
    return NextResponse.json({ error: "Email invalide." }, { status: 400 });
  }
  const email = normalizeEmail(body.email);
  const ip = clientIp(req);
  const since = new Date(Date.now() - WINDOW_MS);
  // Purge opportuniste des échecs sortis de la fenêtre (toutes IP : garde la table minuscule),
  // puis comptage sur les DEUX dimensions.
  await prisma.loginAttempt.deleteMany({ where: { createdAt: { lt: since } } });
  const [ipFailures, accountFailures] = await Promise.all([
    prisma.loginAttempt.count({ where: { ip, createdAt: { gte: since } } }),
    prisma.loginAttempt.count({ where: { identifier: email, createdAt: { gte: since } } }),
  ]);
  if (ipFailures >= MAX_FAILURES || accountFailures >= MAX_FAILURES_ACCOUNT) {
    // Message identique dans les deux cas : ne pas révéler laquelle des deux limites a sauté
    // (sinon on apprend à l'attaquant que le compte visé existe et est ciblé).
    return NextResponse.json(
      { error: "Trop de tentatives — réessaie dans quelques minutes." },
      { status: 429 },
    );
  }

  const user = await prisma.user.findUnique({ where: { email } });
  // Connexion possible seulement si un mot de passe est posé ET l'email est vérifié.
  let ok = false;
  if (user?.passwordHash && user.emailVerifiedAt) {
    ok = await verifyPassword(body.password, user.passwordHash);
  } else {
    // Aucun compte utilisable : on vérifie quand même contre un hash leurre pour dépenser
    // le même temps CPU (pas d'oracle de timing révélant l'existence d'un compte).
    await verifyPassword(body.password, await dummyHash);
  }

  if (!ok || !user) {
    // Échec : on incrémente les deux compteurs (IP et identifiant visé).
    await prisma.loginAttempt.create({ data: { ip, identifier: email } }).catch(() => {});
    return NextResponse.json({ error: "Email ou mot de passe incorrect." }, { status: 401 });
  }
  // Compte désactivé par un admin : identifiants corrects, mais accès bloqué localement.
  if (user.disabledAt) {
    return NextResponse.json(
      { error: "Ce compte a été désactivé. Contacte un responsable du club." },
      { status: 403 },
    );
  }

  // Succès : on efface l'ardoise de cette IP ET de ce compte (les fautes de frappe précédentes
  // ne doivent pénaliser ni les prochains logins du foyer/club, ni le membre), puis on ouvre
  // une session « email seul ».
  await prisma.loginAttempt.deleteMany({ where: { OR: [{ ip }, { identifier: email }] } });
  const sid = await createEmailSession(user.id);
  const res = NextResponse.json({ displayName: user.displayName });
  res.cookies.set("sid", sid, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return res;
}
