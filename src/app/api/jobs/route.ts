import { NextResponse } from "next/server";
import { readSettings } from "@/lib/settings";
import {
  buildGptImageSubmitBody,
  buildModelId,
  buildSubmitBody,
  isGptImage2,
  MAX_BODY_BYTES,
  resolveBaseUrl,
  submitTask,
} from "@/lib/o1key";
import { appendMeta } from "@/lib/historyMeta";
import { MAX_REF_IMAGES } from "@/lib/models";
import type { Billing, ModelName, Quality, Resolution } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Submit one or more generation tasks. Returns the upstream task ids as job
// ids; the client polls GET /api/jobs/{id} for each.
export async function POST(req: Request) {
  const s = await readSettings();
  if (!s.apiKey) {
    return NextResponse.json({ error: "未设置 API 令牌，请先在设置中填入 o1key 令牌" }, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const prompt = String(body.prompt ?? "").trim();
  const model = String(body.model ?? s.defaults.model);
  const resolution = String(body.resolution ?? s.defaults.resolution);
  const aspectRatio = String(body.aspectRatio ?? s.defaults.aspectRatio);
  const billing = String(body.billing ?? s.defaults.billing);
  const count = Math.max(1, Math.min(4, Number(body.count) || 1));
  const quality = String(body.quality ?? "auto");
  // images[]: 参考图（节点连线注入 + 手动上传），顺序即提示词中「第 N 张图」的顺序。
  const images = Array.isArray(body.images)
    ? body.images.filter((x): x is string => typeof x === "string" && !!x).slice(0, MAX_REF_IMAGES + 1)
    : [];

  if (!prompt) return NextResponse.json({ error: "缺少提示词" }, { status: 400 });

  let modelId: string;
  try {
    modelId = buildModelId(model, resolution, billing);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const submitBody = isGptImage2(model)
    ? buildGptImageSubmitBody({
        modelId,
        prompt,
        resolution,
        aspectRatio,
        images,
        quality: (["auto", "high", "medium", "low"] as const).includes(quality as Quality)
          ? (quality as Quality)
          : "auto",
      })
    : buildSubmitBody({ modelId, prompt, resolution, aspectRatio, images });

  const bytes = Buffer.byteLength(JSON.stringify(submitBody), "utf-8");
  if (bytes > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: `请求体 ${(bytes / 1e6).toFixed(1)}MB 超过 20MB 上限，请使用更小的图片` },
      { status: 400 },
    );
  }

  const baseUrl = resolveBaseUrl(s.route);
  try {
    const ids = await Promise.all(
      Array.from({ length: count }, () => submitTask(baseUrl, s.apiKey, submitBody)),
    );
    await appendMeta(ids, {
      prompt,
      model: model as ModelName,
      resolution: resolution as Resolution,
      aspectRatio,
      billing: billing as Billing,
      count,
      refCount: images.length,
      quality: isGptImage2(model) ? (quality as Quality) : undefined,
    });
    return NextResponse.json({ jobs: ids.map((id, index) => ({ id, index })), modelId });
  } catch (e) {
    return NextResponse.json({ error: (e as Error)?.message || "提交失败" }, { status: 500 });
  }
}
