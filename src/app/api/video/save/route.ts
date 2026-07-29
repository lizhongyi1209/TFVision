// 将生成的视频从远端 URL 下载保存到 output/（PLAN-VIDEO 的单机版）。
// POST { videoUrl, taskId, meta? } → { localUrl }
// 文件名：video-<taskId>.mp4，幂等。

import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { promisify } from "util";
import { appendVideoMeta } from "@/lib/historyMeta";
import { copyFileToLocalDirectory } from "@/lib/localMedia.server";
import type { VideoMeta } from "@/lib/types";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OUTPUT_DIR = path.join(process.cwd(), "output");
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
const execFileAsync = promisify(execFile);

function parseFrameRate(value: unknown): number {
  const [numerator, denominator = 1] = String(value ?? "0/1").split("/", 2).map(Number);
  return denominator ? numerator / denominator : 0;
}

async function probeSavedVideo(filePath: string) {
  try {
    const { stdout } = await execFileAsync(ffprobeInstaller.path, [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height,avg_frame_rate,r_frame_rate:format=duration",
      "-of", "json",
      filePath,
    ], { timeout: 20_000, windowsHide: true, maxBuffer: 1024 * 1024 });
    const payload = JSON.parse(stdout) as {
      streams?: Array<{ width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string }>;
      format?: { duration?: string };
    };
    const stream = payload.streams?.[0];
    const width = Number(stream?.width);
    const height = Number(stream?.height);
    const duration = Number(payload.format?.duration);
    const frameRate = parseFrameRate(stream?.avg_frame_rate ?? stream?.r_frame_rate);
    if (![width, height, duration, frameRate].every(Number.isFinite) || width <= 0 || height <= 0 || frameRate <= 0) {
      return undefined;
    }
    return { width, height, duration, frameRate: Math.round(frameRate * 100) / 100 };
  } catch {
    return undefined;
  }
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    videoUrl?: string;
    taskId?: string;
    meta?: Partial<VideoMeta>;
    outputDirectory?: string;
  };
  const { videoUrl, taskId, meta, outputDirectory } = body;
  if (!videoUrl) return NextResponse.json({ error: "缺少 videoUrl" }, { status: 400 });
  if (!/^https?:\/\//i.test(videoUrl)) return NextResponse.json({ error: "视频地址不合法" }, { status: 400 });

  const safe = taskId ? `video-${taskId.replace(/[^a-zA-Z0-9_-]/g, "_")}` : `video-${Date.now()}`;
  const filename = `${safe}.mp4`;
  const target = path.join(OUTPUT_DIR, filename);

  try {
    await fs.access(target);
    if (meta && taskId) {
      await appendVideoMeta({ ...meta, taskId, createdAt: meta.createdAt ?? Date.now() } as VideoMeta);
    }
    const exportedPath = outputDirectory
      ? await copyFileToLocalDirectory(target, outputDirectory, "tfvision-video")
      : undefined;
    return NextResponse.json({
      localUrl: `/api/media/${filename}`,
      exportedPath,
      media: await probeSavedVideo(target),
    });
  } catch {
    // not saved yet — download below
  }

  const res = await fetch(videoUrl, { headers: { "User-Agent": "TFvision/1.0" } }).catch((e: Error) => e);
  if (res instanceof Error) return NextResponse.json({ error: `下载失败：${res.message}` }, { status: 500 });
  if (!res.ok) return NextResponse.json({ error: `下载失败 HTTP ${res.status}` }, { status: 500 });
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) return NextResponse.json({ error: "下载内容为空" }, { status: 500 });
  if (buf.length > MAX_VIDEO_BYTES) return NextResponse.json({ error: "视频超过 500MB 上限" }, { status: 413 });

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(target, buf);

  if (meta && taskId) {
    await appendVideoMeta({ ...meta, taskId, createdAt: meta.createdAt ?? Date.now() } as VideoMeta);
  }

  const exportedPath = outputDirectory
    ? await copyFileToLocalDirectory(target, outputDirectory, "tfvision-video")
    : undefined;
  return NextResponse.json({
    localUrl: `/api/media/${filename}`,
    exportedPath,
    media: await probeSavedVideo(target),
  });
}
