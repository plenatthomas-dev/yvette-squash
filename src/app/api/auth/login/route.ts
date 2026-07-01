import { NextRequest, NextResponse } from "next/server";
import { login } from "@/lib/resamania/client";
import { createSession } from "@/lib/session";

export const runtime = "nodejs";

// POST /api/auth/login { username, password }
export async function POST(req: NextRequest) {
  const { username, password } = await req.json().catch(() => ({}));
  if (!username || !password) {
    return NextResponse.json(
      { error: "Identifiant et mot de passe requis" },
      { status: 400 },
    );
  }
  try {
    const resa = await login({ username, password });
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
    return NextResponse.json({ error: (e as Error).message }, { status: 401 });
  }
}
