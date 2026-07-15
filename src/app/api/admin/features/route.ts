import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { ENV_FEATURES, isFeatureKey, resolveFeatures } from "@/lib/features";
import { getFeatureOverrides, setFeatureOverride } from "@/lib/features-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/features — de quoi piloter les flags : le défaut de l'environnement (ce que
// vaut « auto »), les overrides posés, et l'état effectif qui en résulte.
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) {
    return NextResponse.json({ error: "Accès réservé" }, { status: 403 });
  }
  const overrides = await getFeatureOverrides();
  return NextResponse.json({
    env: ENV_FEATURES,
    overrides,
    features: resolveFeatures(overrides),
  });
}

// POST /api/admin/features  { key, value: true | false | null }
// `null` retire l'override → la fonction repasse en « auto » (valeur de l'environnement).
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) {
    return NextResponse.json({ error: "Accès réservé" }, { status: 403 });
  }
  const raw = (await req.json().catch(() => ({}))) as { key?: unknown; value?: unknown };
  if (!isFeatureKey(raw.key)) {
    return NextResponse.json({ error: "Fonction inconnue." }, { status: 400 });
  }
  if (raw.value !== null && typeof raw.value !== "boolean") {
    return NextResponse.json({ error: "Valeur invalide." }, { status: 400 });
  }

  const overrides = await setFeatureOverride(raw.key, raw.value, admin.userId);
  return NextResponse.json({
    ok: true,
    env: ENV_FEATURES,
    overrides,
    features: resolveFeatures(overrides),
  });
}
