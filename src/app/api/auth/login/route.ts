import { NextRequest, NextResponse } from "next/server";
import { login } from "@/lib/resamania/client";
import { createSession } from "@/lib/session";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

// Rate limiting : au-delà de MAX_FAILURES échecs en WINDOW_MS pour une même IP,
// on refuse SANS transmettre à ResaMania. Protège les comptes des membres du
// brute-force et évite que ResaMania blocklist les IP de l'appli. Le compteur vit
// en base (les fonctions serverless n'ont pas de mémoire partagée entre elles).
const WINDOW_MS = 15 * 60_000; // 15 minutes
const MAX_FAILURES = 5;

// Derrière Vercel, x-forwarded-for est posé par la plateforme (1re IP = client réel).
function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

// POST /api/auth/login { username, password }
export async function POST(req: NextRequest) {
  const { username, password } = await req.json().catch(() => ({}));
  if (!username || !password) {
    return NextResponse.json(
      { error: "Identifiant et mot de passe requis" },
      { status: 400 },
    );
  }

  const ip = clientIp(req);
  const since = new Date(Date.now() - WINDOW_MS);
  // Purge opportuniste des échecs sortis de la fenêtre (toutes IP : garde la table minuscule),
  // puis comptage pour cette IP.
  await prisma.loginAttempt.deleteMany({ where: { createdAt: { lt: since } } });
  const failures = await prisma.loginAttempt.count({
    where: { ip, createdAt: { gte: since } },
  });
  if (failures >= MAX_FAILURES) {
    return NextResponse.json(
      { error: "Trop de tentatives — réessaie dans quelques minutes." },
      { status: 429 },
    );
  }

  try {
    const resa = await login({ username, password });
    // Connexion réussie : on efface l'ardoise de cette IP (les fautes de frappe
    // précédentes ne doivent pas pénaliser les prochains logins du foyer/club).
    await prisma.loginAttempt.deleteMany({ where: { ip } });
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
    // Échec (identifiants invalides ou flux interrompu) : on incrémente le compteur.
    await prisma.loginAttempt.create({ data: { ip } }).catch(() => {});
    // Détail journalisé côté serveur ; message générique pour ne rien divulguer de l'amont.
    console.error("[login] échec:", e);
    return NextResponse.json(
      { error: "Identifiants invalides ou service momentanément indisponible" },
      { status: 401 },
    );
  }
}
