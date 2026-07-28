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

function parseRate(value: unknown): number {
  const [numerator, denominator = 1] = String(value ?? "0/1").split("/", 2).map(Number);
  return denominator ? numerator / denominator : 0;
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
    const { stdout } = await execFileAsync(ffprobeInstaller.path, [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height,avg_frame_rate,r_frame_rate:format=duration",
      "-of", "json",
      tempPath,
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
    return NextResponse.json({ width, height, duration, frameRate: Math.round(frameRate * 100) / 100 });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message || "无法读取视频信息" }, { status: 400 });
  } finally {
    await fs.unlink(tempPath).catch(() => undefined);
  }
}
