import { NextRequest, NextResponse } from "next/server";
import { randomInt } from "node:crypto";
import { prisma } from "@/lib/db";
import { hashOtp } from "@/lib/crypto";
import { normalizeEmail } from "@/lib/session";
import { sendEmail, emailConfigured } from "@/lib/email";
import { FEATURE_EMAIL_LOGIN } from "@/lib/features";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OTP_TTL_MS = 10 * 60_000; // 10 minutes
const MAX_PER_WINDOW = 3; // max 3 codes / 10 min / email (anti-spam de la boîte)
// max 10 codes / 10 min / IP (anti-abus d'envoi : empêche une source d'arroser des
// centaines d'adresses et de brûler le quota d'envoi Gmail — le compteur par email ne
// verrait rien puisque chaque adresse serait sous sa propre limite). ~3 adresses par IP
// et par fenêtre : large pour un foyer/NAT partagé, la connexion email restant un secours.
const MAX_PER_IP = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Derrière Vercel, x-forwarded-for est posé par la plateforme (1re IP = client réel).
function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

// POST /api/auth/otp/request  { email }
// Envoie un code à 6 chiffres à l'email fourni (connexion « email seul », sans ResaMania).
// Le code n'est stocké que HACHÉ. On ne divulgue pas si l'email correspond à un membre.
export async function POST(req: NextRequest) {
  if (!FEATURE_EMAIL_LOGIN) {
    return NextResponse.json({ error: "Fonction indisponible" }, { status: 404 });
  }
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

  // Purge des codes expirés (garde la table minuscule) puis rate-limit. On NE supprime PAS
  // les codes précédents ici, sinon les compteurs resteraient à 1.
  await prisma.emailOtp.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  const since = new Date(Date.now() - OTP_TTL_MS);
  const ip = clientIp(req);

  // Rate limiting par IP d'abord (protège le quota d'envoi, indépendamment de l'email visé).
  const fromIp = await prisma.emailOtp.count({ where: { ip, createdAt: { gte: since } } });
  if (fromIp >= MAX_PER_IP) {
    return NextResponse.json(
      { error: "Trop de demandes — réessaie dans quelques minutes." },
      { status: 429 },
    );
  }
  // Puis rate limiting par email (anti-spam de la boîte visée).
  const recent = await prisma.emailOtp.count({ where: { email, createdAt: { gte: since } } });
  if (recent >= MAX_PER_WINDOW) {
    return NextResponse.json(
      { error: "Trop de demandes — réessaie dans quelques minutes." },
      { status: 429 },
    );
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await prisma.emailOtp.create({
    data: { email, ip, codeHash: hashOtp(code), expiresAt: new Date(Date.now() + OTP_TTL_MS) },
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
