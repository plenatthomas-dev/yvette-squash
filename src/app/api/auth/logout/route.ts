import { NextRequest, NextResponse } from "next/server";
import { destroySession } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  await destroySession(req.cookies.get("sid")?.value);
  const res = NextResponse.json({ ok: true });
  res.cookies.set("sid", "", { maxAge: 0, path: "/" });
  return res;
}
