import { NextResponse } from "next/server";
import { readSettings } from "@/lib/settings";
import { resolveBaseUrl } from "@/lib/o1key";
import { normalizeVisionPrompt, reverseEngineerPrompt, VisionError } from "@/lib/vision";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 视觉反推：POST { image: dataURL } -> { prompt, model, parsed }
export async function POST(req: Request) {
  const s = await readSettings();
  if (!s.apiKey) return NextResponse.json({ error: "未设置 API 令牌" }, { status: 400 });

  const body = (await req.json().catch(() => ({}))) as { image?: string };
  const image = typeof body.image === "string" ? body.image : "";
  if (!image.startsWith("data:image/")) {
    return NextResponse.json({ error: "缺少图片数据" }, { status: 400 });
  }

  try {
    const { content, model } = await reverseEngineerPrompt(resolveBaseUrl(s.route), s.apiKey, image);
    const normalized = normalizeVisionPrompt(content);
    return NextResponse.json({ prompt: normalized.text, parsed: normalized.parsed, model });
  } catch (e) {
    const msg = e instanceof VisionError ? e.message : (e as Error)?.message || "视觉解析失败";
    const detail = e instanceof VisionError ? e.detail : undefined;
    return NextResponse.json({ error: msg, detail }, { status: 502 });
  }
}
