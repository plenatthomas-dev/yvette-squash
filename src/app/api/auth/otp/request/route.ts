import { NextRequest, NextResponse } from "next/server";
import { randomInt } from "node:crypto";
import { prisma } from "@/lib/db";
import { hashOtp } from "@/lib/crypto";
import { normalizeEmail } from "@/lib/session";
import { sendEmail, emailConfigured } from "@/lib/email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OTP_TTL_MS = 10 * 60_000; // 10 minutes
const MAX_PER_WINDOW = 3; // max 3 codes / 10 min / email (anti-spam de la boîte)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /api/auth/otp/request  { email }
// Envoie un code à 6 chiffres à l'email fourni (connexion « email seul », sans ResaMania).
// Le code n'est stocké que HACHÉ. On ne divulgue pas si l'email correspond à un membre.
export async function POST(req: NextRequest) {
  const { email: raw } = (await req.json().catch(() => ({}))) as { email?: unknown };
  if (typeof raw !== "string" || !EMAIL_RE.test(raw.trim())) {
    return NextResponse.json({ error: "Email invalide." }, { status: 400 });
  }
  const email = normalizeEmail(raw);

  if (!emailConfigured()) {
    return NextResponse.json(
      { error: "Envoi d'e-mail non configuré côté serveur." },
      { status: 503 },
    );
  }

  // Purge des codes expirés (garde la table minuscule) puis rate-limit par email :
  // on NE supprime PAS les codes précédents ici, sinon le compteur resterait à 1.
  await prisma.emailOtp.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  const recent = await prisma.emailOtp.count({
    where: { email, createdAt: { gte: new Date(Date.now() - OTP_TTL_MS) } },
  });
  if (recent >= MAX_PER_WINDOW) {
    return NextResponse.json(
      { error: "Trop de demandes — réessaie dans quelques minutes." },
      { status: 429 },
    );
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await prisma.emailOtp.create({
    data: { email, codeHash: hashOtp(code), expiresAt: new Date(Date.now() + OTP_TTL_MS) },
  });

  try {
    await sendEmail({
      to: email,
      subject: "Ton code de connexion — Squash de l'Yvette",
      text: `Ton code de connexion : ${code}\n\nIl est valable 10 minutes. Si tu n'as rien demandé, ignore ce message.`,
    });
  } catch {
    return NextResponse.json({ error: "Échec de l'envoi, réessaie plus tard." }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}
