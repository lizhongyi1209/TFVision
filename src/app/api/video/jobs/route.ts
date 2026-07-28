// 视频任务提交（移植自 TVision）：接收前端传来的已上传素材 URL，组装
// Kling image2video / omni-video 或 Seedance 统一协议请求体并提交。
//   v3 / v2-6  → POST /kling/v1/videos/image2video
//   v3-omni    → POST /kling/omni-video/kling-3.0-omni (contents/settings/options)
//   seedance-* → POST /v1/video/generations

import { NextResponse } from "next/server";
import { readSettings } from "@/lib/settings";
import { resolveBaseUrl } from "@/lib/o1key";
import {
  VIDEO_MODEL_IDS,
  allowedVideoAspectRatios,
  allowedVideoDurations,
  allowedVideoResolutions,
  buildKlingOmniGenerationBody,
  buildSeedanceGenerationBody,
  extractVideoTaskId,
  isSeedanceModel,
  isVideoModel,
} from "@/lib/videoGateway";
import type { VideoJobParams } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ENDPOINT_IMAGE2VIDEO = "/kling/v1/videos/image2video";
const ENDPOINT_OMNI = "/kling/omni-video/kling-3.0-omni";
const ENDPOINT_UNIFIED = "/v1/video/generations";
const MAX_BODY_BYTES = 128 * 1024;

const MODE_MAP: Record<string, string> = { "720p": "std", "1080p": "pro", "4K": "4k" };
export async function POST(req: Request) {
  const s = await readSettings();
  if (!s.apiKey) return NextResponse.json({ error: "未设置 API 令牌" }, { status: 400 });

  const rawBody = await req.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "视频任务参数过大" }, { status: 413 });
  }
  let p: VideoJobParams;
  try {
    p = JSON.parse(rawBody) as VideoJobParams;
  } catch {
    return NextResponse.json({ error: "请求 JSON 格式错误" }, { status: 400 });
  }
  const rawModel = String(p.model ?? "v3");
  if (!isVideoModel(rawModel)) return NextResponse.json({ error: "不支持的视频模型" }, { status: 400 });
  const model = rawModel;
  const modeValue = typeof p.mode === "string" ? p.mode : "720p";
  if (!(allowedVideoResolutions(model) as readonly string[]).includes(modeValue)) {
    return NextResponse.json({ error: `${model} 不支持 ${modeValue} 分辨率` }, { status: 400 });
  }
  const mode = modeValue as VideoJobParams["mode"];
  const requestedDuration = typeof p.duration === "number" && Number.isFinite(p.duration) ? p.duration : 5;
  if (!allowedVideoDurations(model).includes(requestedDuration)) {
    return NextResponse.json({ error: `${model} 不支持该生成时长` }, { status: 400 });
  }
  const duration = requestedDuration;
  const prompt = typeof p.prompt === "string" ? p.prompt.trim() : "";
  const negPrompt = typeof p.negativePrompt === "string" ? p.negativePrompt.trim() : "";
  const sound = p.sound === true;
  const webSearch = p.webSearch === true;
  const cameraFixed = p.cameraFixed === true;
  if (p.seed !== undefined && (!Number.isInteger(p.seed) || typeof p.seed !== "number")) {
    return NextResponse.json({ error: "随机种子必须是整数" }, { status: 400 });
  }
  const seed = typeof p.seed === "number" && Number.isInteger(p.seed) ? p.seed : undefined;
  const imageUrl = typeof p.imageUrl === "string" ? p.imageUrl : "";
  const tailUrl = typeof p.tailUrl === "string" ? p.tailUrl : "";
  const cleanStringArray = (value: unknown) => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const refUrls = cleanStringArray(p.refUrls);
  const videoUrls = cleanStringArray(p.videoUrls);
  const audioUrls = cleanStringArray(p.audioUrls);
  const referType = p.referType === "base" ? "base" : "feature";
  const keepOriginalSound = p.keepOriginalSound === true;
  const aspectValue = typeof p.aspectRatio === "string" ? p.aspectRatio : "智能";
  const modelRatios = allowedVideoAspectRatios(model) as readonly string[];
  if (modelRatios.length && !modelRatios.includes(aspectValue)) {
    return NextResponse.json({ error: "不支持的视频宽高比" }, { status: 400 });
  }
  const aspectRatio = aspectValue as NonNullable<VideoJobParams["aspectRatio"]>;
  const rawShots = Array.isArray(p.shots) ? p.shots : [];
  const shots = rawShots.map((shot, index) => ({
    index: index + 1,
    prompt: typeof shot?.prompt === "string" ? shot.prompt.trim() : "",
    duration: Number(shot?.duration),
  }));
  const shotMode = p.shotMode === "auto" || p.shotMode === "custom" ? p.shotMode : "single";

  if (!imageUrl && model !== "v3-omni" && !isSeedanceModel(model)) {
    return NextResponse.json({ error: "缺少起始帧图片" }, { status: 400 });
  }
  if (!prompt && !shots.length) return NextResponse.json({ error: "提示词不能为空" }, { status: 400 });
  if (shots.length) {
    if (model === "v2-6" || isSeedanceModel(model)) {
      return NextResponse.json({ error: `${model} 不支持分镜模式` }, { status: 400 });
    }
    if (shots.length > 6 || shots.some((shot) => !shot.prompt || !Number.isInteger(shot.duration) || shot.duration < 1)) {
      return NextResponse.json({ error: "分镜参数无效（最多 6 段，且每段提示词和整数时长必填）" }, { status: 400 });
    }
    const shotDuration = shots.reduce((sum, shot) => sum + shot.duration, 0);
    if (shotDuration !== duration) {
      return NextResponse.json({ error: `分镜总时长 ${shotDuration}s 必须等于视频时长 ${duration}s` }, { status: 400 });
    }
  }

  if (model === "v2-6" && ![5, 10].includes(duration)) {
    return NextResponse.json({ error: "v2-6 时长仅支持 5s 或 10s" }, { status: 400 });
  }
  if (!isSeedanceModel(model) && refUrls.length > 7) {
    return NextResponse.json({ error: "可灵参考图最多 7 张" }, { status: 400 });
  }
  if (model === "v3-omni") {
    const frameCount = (imageUrl ? 1 : 0) + (tailUrl ? 1 : 0);
    const imageTotal = frameCount + refUrls.length;
    const imageCap = videoUrls.length ? 4 : 7;
    if (imageTotal > imageCap) {
      return NextResponse.json({ error: "可灵 omni 图片总数超限" }, { status: 400 });
    }
  }
  if (!isSeedanceModel(model) && audioUrls.length) {
    return NextResponse.json({ error: "当前模型不支持参考音频" }, { status: 400 });
  }
  if (!isSeedanceModel(model) && model !== "v3-omni" && videoUrls.length) {
    return NextResponse.json({ error: "当前模型不支持参考视频" }, { status: 400 });
  }
  if (model === "v3-omni" && videoUrls.length > 1) {
    return NextResponse.json({ error: "可灵 v3-omni 至多支持 1 段参考视频" }, { status: 400 });
  }
  if (model === "v3-omni" && videoUrls.length && referType === "base" && shots.length) {
    return NextResponse.json({ error: "视频编辑（base）模式不支持分镜" }, { status: 400 });
  }

  const baseUrl = resolveBaseUrl(s.route);
  const headers = { Authorization: `Bearer ${s.apiKey}`, "Content-Type": "application/json" };

  const modelName = VIDEO_MODEL_IDS[model];
  const modeApi = MODE_MAP[mode] ?? "std";
  let body: Record<string, unknown>;
  let endpoint: string;

  if (isSeedanceModel(model)) {
    endpoint = ENDPOINT_UNIFIED;
    try {
      body = buildSeedanceGenerationBody({
        ...p,
        model,
        mode,
        duration,
        prompt,
        sound,
        webSearch,
        cameraFixed,
        seed,
        imageUrl: imageUrl || undefined,
        tailUrl: tailUrl || undefined,
        refUrls,
        videoUrls,
        audioUrls,
      });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Seedance 参数无效" },
        { status: 400 },
      );
    }
  } else if (model === "v3-omni") {
    endpoint = ENDPOINT_OMNI;
    try {
      body = buildKlingOmniGenerationBody({
        ...p,
        model,
        mode,
        duration,
        prompt,
        sound,
        aspectRatio,
        imageUrl: imageUrl || undefined,
        tailUrl: tailUrl || undefined,
        refUrls,
        videoUrls,
        audioUrls,
        referType,
        keepOriginalSound,
        shotMode,
        shots,
      });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "可灵 Omni 参数无效" },
        { status: 400 },
      );
    }
  } else {
    endpoint = ENDPOINT_IMAGE2VIDEO;
    body = {
      model_name: modelName,
      image: imageUrl,
      prompt: shots.length ? shots[0].prompt : prompt,
      negative_prompt: negPrompt,
      duration: String(duration),
      mode: modeApi,
      sound: sound ? "on" : "off",
      watermark_info: { enabled: false },
    };
    if (shots.length) {
      body.multi_shot = true;
      body.shot_type = "customize";
      body.multi_prompt = shots.map((shot, index) => ({
        index: index + 1,
        prompt: shot.prompt,
        duration: String(shot.duration),
      }));
    } else if (tailUrl) {
      body.image_tail = tailUrl;
    }
  }

  const submitRes = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  }).catch((e) => e as Error);
  if (submitRes instanceof Error) {
    return NextResponse.json({ error: `网络连接失败: ${submitRes.message}` }, { status: 500 });
  }

  const text = await submitRes.text();
  if (![200, 201, 202].includes(submitRes.status)) {
    return NextResponse.json({ error: `提交失败 HTTP ${submitRes.status}: ${text.slice(0, 300)}` }, { status: 500 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: `响应非 JSON: ${text.slice(0, 200)}` }, { status: 500 });
  }

  const responseCode = payload.code;
  if (responseCode !== undefined && Number(responseCode) !== 0) {
    return NextResponse.json(
      { error: String(payload.message ?? `可灵接口错误 code=${String(responseCode)}`) },
      { status: 502 },
    );
  }

  const taskId = extractVideoTaskId(payload);
  if (!taskId) {
    return NextResponse.json({ error: `API 未返回 task_id: ${JSON.stringify(payload).slice(0, 200)}` }, { status: 500 });
  }

  return NextResponse.json({
    taskId,
    model,
    mode,
    duration,
    prompt: shots.length ? "" : prompt,
    shots,
    sound,
    audioMode: p.audioMode,
    aspectRatio,
    webSearch,
    cameraFixed,
    seed,
  });
}
