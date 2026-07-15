import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { hashPassword, verifyPassword } from "@/lib/crypto";
import { normalizeEmail, createEmailSession } from "@/lib/session";
import { getFeatures } from "@/lib/features-server";
import { EMAIL_RE, clientIp } from "@/lib/email-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 jours

// Rate limiting partagé avec la connexion ResaMania : au-delà de MAX_FAILURES échecs en
// WINDOW_MS pour une même IP, on refuse (protège du brute-force). Compteur en base
// (les fonctions serverless n'ont pas de mémoire partagée).
const WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 5;

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
  await prisma.loginAttempt.deleteMany({ where: { createdAt: { lt: since } } });
  const failures = await prisma.loginAttempt.count({ where: { ip, createdAt: { gte: since } } });
  if (failures >= MAX_FAILURES) {
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
    await prisma.loginAttempt.create({ data: { ip } }).catch(() => {});
    return NextResponse.json({ error: "Email ou mot de passe incorrect." }, { status: 401 });
  }
  // Compte désactivé par un admin : identifiants corrects, mais accès bloqué localement.
  if (user.disabledAt) {
    return NextResponse.json(
      { error: "Ce compte a été désactivé. Contacte un responsable du club." },
      { status: 403 },
    );
  }

  // Succès : on efface l'ardoise de cette IP puis on ouvre une session « email seul ».
  await prisma.loginAttempt.deleteMany({ where: { ip } });
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
