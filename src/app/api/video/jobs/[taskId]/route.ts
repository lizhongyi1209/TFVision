// 视频任务轮询（移植自 TVision）：依次探测 Seedance 统一协议与 Kling 原生
// 端点，返回归一化的 { status, progress, videoUrl, error }。

import { NextResponse } from "next/server";
import { readSettings } from "@/lib/settings";
import { resolveBaseUrl } from "@/lib/o1key";
import { extractGeneratedVideoUrl } from "@/lib/videoGateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUCCESS = new Set(["succeed", "success", "succeeded", "completed", "done", "finished"]);
const FAILURE = new Set(["failed", "failure", "fail", "error", "expired", "timeout", "canceled", "cancelled", "rejected"]);
const RUNNING = new Set(["created", "queued", "pending", "running", "processing", "in_progress", "in-progress", "submitted"]);

function collectDicts(p: unknown): Record<string, unknown>[] {
  const dicts: Record<string, unknown>[] = [];
  if (p && typeof p === "object") {
    const r = p as Record<string, unknown>;
    dicts.push(r);
    if (r.data && typeof r.data === "object") {
      const d = r.data as Record<string, unknown>;
      dicts.push(d);
      if (d.data && typeof d.data === "object") dicts.push(d.data as Record<string, unknown>);
    }
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
    for (const key of ["video_url", "result_url", "url", "download_url"]) {
      const v = src[key];
      if (v && typeof v === "string" && /^https?:\/\//i.test(v)) return v;
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
  for (const src of collectDicts(p)) {
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

export async function GET(_req: Request, ctx: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await ctx.params;
  const s = await readSettings();
  if (!s.apiKey) return NextResponse.json({ error: "未设置 API 令牌" }, { status: 400 });

  const baseUrl = resolveBaseUrl(s.route);
  const headers = { Authorization: `Bearer ${s.apiKey}` };

  const endpoints = [
    `/v1/video/generations/${encodeURIComponent(taskId)}`,
    `/v1/tasks/${encodeURIComponent(taskId)}`,
    `/kling/v1/videos/image2video/${encodeURIComponent(taskId)}`,
    `/kling/v1/videos/omni-video/${encodeURIComponent(taskId)}`,
  ];

  let payload: unknown = null;
  let retryableFailure = false;
  let terminalError = "";
  for (const ep of endpoints) {
    let res: Response;
    try {
      res = await fetch(`${baseUrl}${ep}`, { headers, signal: AbortSignal.timeout(15_000) });
    } catch {
      retryableFailure = true;
      continue;
    }
    if (res.status === 200) {
      const text = await res.text();
      try {
        const candidate = JSON.parse(text);
        const candidateStatus = extractStatus(candidate);
        const candidateError = extractError(candidate);
        const notFound = /not\s*found|not\s*exist|不存在|未找到/i.test(candidateError);
        if ((candidateStatus || extractGeneratedVideoUrl(candidate)) && !notFound) payload = candidate;
        else if (!notFound) terminalError = candidateError;
      } catch {
        retryableFailure = true;
      }
      if (payload) break;
      continue;
    }
    if (res.status === 404 || res.status === 405) continue;
    if (res.status === 429 || res.status >= 500) {
      retryableFailure = true;
      continue;
    }
    const text = await res.text().catch(() => "");
    terminalError = `状态查询失败 HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ""}`;
  }

  if (!payload) {
    if (retryableFailure) return NextResponse.json({ status: "running", progress: 0 });
    return NextResponse.json({ status: "failed", progress: 0, error: terminalError || "状态查询失败" });
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
    return NextResponse.json({ status: "success", progress: 100, videoUrl });
  }

  return NextResponse.json({ status: "running", progress });
}
