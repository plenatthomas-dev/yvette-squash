import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { hashOtp } from "@/lib/crypto";
import { normalizeEmail, resolveUser, createEmailSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ATTEMPTS = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// Nom d'affichage par défaut d'un nouveau compte email-seul, dérivé de l'email
// ("jean.dupont@x" -> "Jean Dupont"). L'utilisateur pourra l'affiner ensuite.
function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  return (
    local
      .replace(/[._-]+/g, " ")
      .trim()
      .split(" ")
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ") || email
  );
}

// POST /api/auth/otp/verify  { email, code, name? }
// Vérifie le code, ouvre une session « email seul », et rattache/crée le User par email.
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as {
    email?: unknown;
    code?: unknown;
    name?: unknown;
  };
  if (typeof body.email !== "string" || !EMAIL_RE.test(body.email.trim())) {
    return NextResponse.json({ error: "Email invalide." }, { status: 400 });
  }
  if (typeof body.code !== "string" || !/^\d{6}$/.test(body.code.trim())) {
    return NextResponse.json({ error: "Code à 6 chiffres attendu." }, { status: 400 });
  }
  const email = normalizeEmail(body.email);
  const code = body.code.trim();

  // On prend le code le plus récent encore valide (les précédents expirent d'eux-mêmes).
  const otp = await prisma.emailOtp.findFirst({
    where: { email, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!otp) {
    return NextResponse.json(
      { error: "Code expiré ou introuvable — redemande un code." },
      { status: 400 },
    );
  }
  if (otp.attempts >= MAX_ATTEMPTS) {
    await prisma.emailOtp.delete({ where: { id: otp.id } }).catch(() => {});
    return NextResponse.json({ error: "Trop d'essais — redemande un code." }, { status: 429 });
  }
  if (!safeEqualHex(otp.codeHash, hashOtp(code))) {
    await prisma.emailOtp.update({
      where: { id: otp.id },
      data: { attempts: { increment: 1 } },
    });
    return NextResponse.json({ error: "Code incorrect." }, { status: 400 });
  }

  // Code bon : consomme TOUS les codes de cet email, résout l'identité (email = clé),
  // ouvre une session « email seul » (sans jeton ResaMania).
  await prisma.emailOtp.deleteMany({ where: { email } });
  const existing = await prisma.user.findUnique({ where: { email } });
  const displayName =
    existing?.displayName ??
    (typeof body.name === "string" && body.name.trim()
      ? body.name.trim().slice(0, 60)
      : nameFromEmail(email));
  const user = await resolveUser({ email, displayName });

  const sid = await createEmailSession(user.id);
  const res = NextResponse.json({ displayName: user.displayName });
  res.cookies.set("sid", sid, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
