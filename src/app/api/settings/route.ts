import { NextResponse } from "next/server";
import { readSettings, toPublic, writeSettings } from "@/lib/settings";
import type { Settings } from "@/lib/types";
import { isRouteName } from "@/lib/networkRoutes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const s = await readSettings();
  return NextResponse.json(toPublic(s));
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Partial<Settings> & { clearApiKey?: boolean };
  const patch: Partial<Settings> & { clearApiKey?: boolean } = {};
  if (typeof body.apiKey === "string" && body.apiKey.trim()) patch.apiKey = body.apiKey.trim();
  if (body.clearApiKey) patch.clearApiKey = true;
  if (isRouteName(body.route)) patch.route = body.route;
  if (body.defaults && typeof body.defaults === "object") patch.defaults = body.defaults;
  const next = await writeSettings(patch);
  return NextResponse.json(toPublic(next));
}
