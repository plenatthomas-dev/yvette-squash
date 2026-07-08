import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { buildMePayload } from "@/lib/me-payload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await getSession(req.cookies.get("sid")?.value);
  if (!session) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  return NextResponse.json(await buildMePayload(session));
}
