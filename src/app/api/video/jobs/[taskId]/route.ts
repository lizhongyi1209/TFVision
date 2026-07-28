// 视频任务轮询：每个模型只调用服务器指定的任务端点，不做跨协议回退。

import { NextResponse } from "next/server";
import { readSettings } from "@/lib/settings";
import { resolveBaseUrl } from "@/lib/o1key";
import { extractGeneratedVideoUrl, isVideoModel, videoStatusEndpoint } from "@/lib/videoGateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUCCESS = new Set(["succeed", "success", "succeeded", "completed", "done", "finished"]);
const FAILURE = new Set(["failed", "failure", "fail", "error", "expired", "timeout", "canceled", "cancelled", "rejected"]);
const RUNNING = new Set(["created", "queued", "pending", "running", "processing", "in_progress", "in-progress", "submitted"]);

function collectDicts(p: unknown): Record<string, unknown>[] {
  const dicts: Record<string, unknown>[] = [];
  const queue: unknown[] = [p];
  const seen = new Set<unknown>();
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    const record = current as Record<string, unknown>;
    dicts.push(record);
    queue.push(...Object.values(record));
  }
  return dicts;
}

function extractStatus(p: unknown): string {
  const found: string[] = [];
  for (const src of collectDicts(p)) {
    for (const key of ["status", "task_status", "state"]) {
      const v = src[key];
      if (v != null && String(v).trim()) found.push(String(v).trim().toLowerCase());
    }
  }
  const failure = found.find((st) => FAILURE.has(st) || st.includes("fail") || st.includes("error"));
  if (failure) return failure;
  const running = found.find((st) => RUNNING.has(st));
  if (running) return running;
  return found.find((st) => SUCCESS.has(st)) ?? found[0] ?? "";
}

function extractProgress(p: unknown): number {
  for (const src of collectDicts(p)) {
    const v = src["progress"];
    if (v != null) {
      const n = parseFloat(String(v));
      if (!isNaN(n)) return Math.max(0, Math.min(100, n > 0 && n < 1 ? n * 100 : n));
    }
  }
  return 0;
}

function extractVideoUrlDeep(p: unknown): string | null {
  for (const src of collectDicts(p)) {
    for (const key of ["video_url", "result_url", "download_url"]) {
      const v = src[key];
      if (v && typeof v === "string" && /^https?:\/\//i.test(v)) return v;
    }
    const genericUrl = src.url;
    const mediaHint = String(src.type ?? src.kind ?? src.mime_type ?? src.content_type ?? "").toLowerCase();
    if (
      typeof genericUrl === "string" &&
      /^https?:\/\//i.test(genericUrl) &&
      (mediaHint.includes("video") || /\.(?:mp4|mov|webm)(?:[?#]|$)/i.test(genericUrl))
    ) {
      return genericUrl;
    }
    const taskResult = src.task_result;
    if (taskResult && typeof taskResult === "object") {
      const tr = taskResult as Record<string, unknown>;
      const videos = tr.videos;
      if (Array.isArray(videos) && videos.length) {
        const first = videos[0] as Record<string, unknown>;
        const v = first.url ?? first.video_url;
        if (v && typeof v === "string") return v;
      }
    }
  }
  return null;
}

function extractError(p: unknown): string {
  const dicts = collectDicts(p);
  const failedTask = dicts.find((src) => {
    const status = String(src.status ?? src.task_status ?? src.state ?? "").toLowerCase();
    return FAILURE.has(status) || status.includes("fail") || status.includes("error");
  });
  if (failedTask) {
    for (const key of ["message", "fail_reason", "failure_reason", "task_status_msg", "detail"]) {
      if (failedTask[key]) return String(failedTask[key]);
    }
  }
  for (const src of dicts) {
    const err = src.error;
    if (err && typeof err === "object") {
      const e = err as Record<string, unknown>;
      for (const k of ["message", "msg", "detail"]) {
        if (e[k]) return String(e[k]);
      }
    } else if (err) return String(err);
    for (const k of ["fail_reason", "failure_reason", "task_status_msg", "message", "detail"]) {
      if (src[k]) return String(src[k]);
    }
  }
  return "未知错误";
}

export async function GET(req: Request, ctx: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await ctx.params;
  const s = await readSettings();
  if (!s.apiKey) return NextResponse.json({ error: "未设置 API 令牌" }, { status: 400 });

  const requestedModel = new URL(req.url).searchParams.get("model") ?? "";
  if (!isVideoModel(requestedModel)) {
    return NextResponse.json({ error: "状态查询缺少有效的视频模型" }, { status: 400 });
  }

  const baseUrl = resolveBaseUrl(s.route);
  const headers = { Authorization: `Bearer ${s.apiKey}` };

  const endpoint = videoStatusEndpoint(requestedModel, taskId);
  const requestedUrl = `${baseUrl}${endpoint}`;

  let response: Response;
  try {
    response = await fetch(requestedUrl, { headers, signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "网络连接失败";
    return NextResponse.json({ status: "running", progress: 0, error: `状态查询暂时失败：${message}` });
  }
  const responseText = await response.text().catch(() => "");
  if (response.status === 429 || response.status >= 500) {
    return NextResponse.json({ status: "running", progress: 0 });
  }
  if (!response.ok) {
    return NextResponse.json({
      status: "failed",
      progress: 0,
      error: `状态查询失败 HTTP ${response.status}${responseText ? `：${responseText.slice(0, 500)}` : ""}`,
    });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(responseText);
  } catch {
    return NextResponse.json({
      status: "failed",
      progress: 0,
      error: `状态接口返回了非 JSON 内容。请求地址：${requestedUrl}\n响应内容：${responseText.slice(0, 500) || "（空）"}`,
    });
  }

  const rawStatus = extractStatus(payload);
  const progress = Math.round(extractProgress(payload));

  if (FAILURE.has(rawStatus) || rawStatus.includes("fail") || rawStatus.includes("error")) {
    return NextResponse.json({ status: "failed", progress, error: extractError(payload) });
  }
  if (SUCCESS.has(rawStatus)) {
    const videoUrl = extractGeneratedVideoUrl(payload) ?? extractVideoUrlDeep(payload);
    if (!videoUrl) {
      return NextResponse.json({ status: "failed", progress: 100, error: "成功但未返回视频 URL" });
    }
    const dicts = collectDicts(payload);
    const root = dicts[0];
    const videoOutput = dicts.find((entry) => String(entry.type ?? "").toLowerCase() === "video" && entry.url === videoUrl);
    const task = dicts.find((entry) => String(entry.id ?? "") === taskId && entry.status != null);
    const billing = Array.isArray(task?.billing)
      ? task.billing.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object" && !Array.isArray(entry))
      : [];
    return NextResponse.json({
      status: "success",
      progress: 100,
      videoUrl,
      watermarkUrl: typeof videoOutput?.watermark_url === "string" ? videoOutput.watermark_url : undefined,
      outputDuration: videoOutput?.duration != null ? String(videoOutput.duration) : undefined,
      requestId: typeof root?.request_id === "string" ? root.request_id : undefined,
      billing,
    });
  }

  return NextResponse.json({ status: "running", progress });
}
