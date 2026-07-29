import { execFile } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { NextResponse } from "next/server";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const OUTPUT_DIR = path.join(process.cwd(), "output");

function parseRate(value: unknown): number {
  const [numerator, denominator = 1] = String(value ?? "0/1").split("/", 2).map(Number);
  return denominator ? numerator / denominator : 0;
}

async function probeVideoPath(filePath: string) {
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
  const frameRate = parseRate(stream?.avg_frame_rate ?? stream?.r_frame_rate);
  if (![width, height, duration, frameRate].every(Number.isFinite) || width <= 0 || height <= 0 || frameRate <= 0) {
    throw new Error("视频轨道信息不完整");
  }
  return { width, height, duration, frameRate: Math.round(frameRate * 100) / 100 };
}

export async function GET(request: Request) {
  const mediaUrl = new URL(request.url).searchParams.get("url") ?? "";
  const match = /^\/api\/media\/([^/?#]+\.mp4)$/i.exec(mediaUrl);
  if (!match) return NextResponse.json({ error: "仅支持读取本地 MP4 元数据" }, { status: 400 });
  try {
    const decodedName = decodeURIComponent(match[1]);
    const safeName = path.basename(decodedName);
    if (safeName !== decodedName) return NextResponse.json({ error: "视频路径不合法" }, { status: 400 });
    return NextResponse.json(await probeVideoPath(path.join(OUTPUT_DIR, safeName)));
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message || "无法读取视频信息" }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof Blob)) return NextResponse.json({ error: "缺少视频文件" }, { status: 400 });
  if (file.size <= 0 || file.size > MAX_VIDEO_BYTES) {
    return NextResponse.json({ error: "视频为空或超过 200MB" }, { status: 400 });
  }
  const extension = file.type.includes("quicktime") ? "mov" : "mp4";
  const tempPath = path.join(os.tmpdir(), `tfvision-metadata-${crypto.randomUUID()}.${extension}`);
  try {
    await fs.writeFile(tempPath, Buffer.from(await file.arrayBuffer()));
    return NextResponse.json(await probeVideoPath(tempPath));
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message || "无法读取视频信息" }, { status: 400 });
  } finally {
    await fs.unlink(tempPath).catch(() => undefined);
  }
}
