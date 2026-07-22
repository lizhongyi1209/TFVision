// 视频素材上传代理：转发到上游网关的预签名上传（/v1/storage/presign），
// 返回上游可抓取的公网 URL。移植自 TVision 的网关直传分支（无 R2 配置时的
// 本地开发路径）。

import { NextResponse } from "next/server";
import { readSettings } from "@/lib/settings";
import { resolveBaseUrl } from "@/lib/o1key";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MB = 1024 * 1024;
const MEDIA_TYPES: Record<string, { contentType: string; extension: string; maxBytes: number; kind: string }> = {
  "image/jpeg": { contentType: "image/jpeg", extension: "jpg", maxBytes: 30 * MB, kind: "image" },
  "image/jpg": { contentType: "image/jpeg", extension: "jpg", maxBytes: 30 * MB, kind: "image" },
  "image/png": { contentType: "image/png", extension: "png", maxBytes: 30 * MB, kind: "image" },
  "image/webp": { contentType: "image/webp", extension: "webp", maxBytes: 30 * MB, kind: "image" },
  "video/mp4": { contentType: "video/mp4", extension: "mp4", maxBytes: 200 * MB, kind: "video" },
  "video/quicktime": { contentType: "video/quicktime", extension: "mov", maxBytes: 200 * MB, kind: "video" },
  "audio/wav": { contentType: "audio/wav", extension: "wav", maxBytes: 15 * MB, kind: "audio" },
  "audio/mpeg": { contentType: "audio/mpeg", extension: "mp3", maxBytes: 15 * MB, kind: "audio" },
  "audio/mp3": { contentType: "audio/mpeg", extension: "mp3", maxBytes: 15 * MB, kind: "audio" },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parsePresign(payload: unknown): { uploadUrl: string; publicUrl: string; method: "PUT" | "POST"; provider: string; headers: Record<string, string> } {
  if (!isRecord(payload)) throw new Error("预签名响应格式异常");
  const candidates = [payload, payload.data, payload.result].filter(isRecord);
  for (const candidate of candidates) {
    const uploadUrl = candidate.upload_url ?? candidate.uploadUrl;
    const publicUrl = candidate.public_url ?? candidate.publicUrl ?? candidate.url;
    if (typeof uploadUrl !== "string" || typeof publicUrl !== "string") continue;
    const rawMethod = String(candidate.method ?? "PUT").toUpperCase();
    if (rawMethod !== "PUT" && rawMethod !== "POST") throw new Error(`不支持的上传方法: ${rawMethod}`);
    const headers = isRecord(candidate.headers)
      ? Object.fromEntries(
          Object.entries(candidate.headers)
            .filter(([, v]) => v != null)
            .map(([k, v]) => [k, String(v)]),
        )
      : {};
    return { uploadUrl, publicUrl, method: rawMethod, provider: String(candidate.provider ?? "r2").toLowerCase(), headers };
  }
  throw new Error("预签名响应缺少上传地址或公网地址");
}

export async function POST(req: Request) {
  const s = await readSettings();
  if (!s.apiKey) return NextResponse.json({ error: "未设置 API 令牌" }, { status: 400 });

  const formData = await req.formData().catch(() => null);
  if (!formData) return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  const file = formData.get("file");
  if (!(file instanceof Blob)) return NextResponse.json({ error: "缺少 file 字段" }, { status: 400 });

  const declared = (file.type || "").toLowerCase().split(";", 1)[0];
  const spec = MEDIA_TYPES[declared];
  if (!spec) return NextResponse.json({ error: "仅支持图片、MP4/MOV 视频和 WAV/MP3 音频" }, { status: 400 });
  if (file.size <= 0) return NextResponse.json({ error: "素材文件为空" }, { status: 400 });
  if (file.size > spec.maxBytes) {
    return NextResponse.json({ error: `素材大小超过 ${spec.maxBytes / MB}MB 上限` }, { status: 400 });
  }

  const baseUrl = resolveBaseUrl(s.route);
  const filename = `${crypto.randomUUID()}.${spec.extension}`;

  try {
    const presignRes = await fetch(`${baseUrl}/v1/storage/presign`, {
      method: "POST",
      headers: { Authorization: `Bearer ${s.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ filename, content_type: spec.contentType, size: file.size }),
      signal: AbortSignal.timeout(10_000),
    });
    const presignText = await presignRes.text();
    if (!presignRes.ok) {
      return NextResponse.json({ error: `预签名失败 (${presignRes.status}): ${presignText.slice(0, 200)}` }, { status: 500 });
    }
    const presign = parsePresign(JSON.parse(presignText));
    const uploadUrl = new URL(presign.uploadUrl, baseUrl).toString();

    const headers = { ...presign.headers };
    const hasHeader = (n: string) => Object.keys(headers).some((k) => k.toLowerCase() === n);
    if (!hasHeader("content-type")) headers["Content-Type"] = spec.contentType;
    if (presign.provider === "local") {
      if (!hasHeader("authorization")) headers.Authorization = `Bearer ${s.apiKey}`;
    } else {
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === "authorization") delete headers[key];
      }
    }

    const bytes = Buffer.from(await file.arrayBuffer());
    const uploadRes = await fetch(uploadUrl, {
      method: presign.method,
      headers,
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(180_000),
    });
    if (![200, 201, 204].includes(uploadRes.status)) {
      const text = await uploadRes.text();
      return NextResponse.json({ error: `素材上传失败 (${uploadRes.status}): ${text.slice(0, 200)}` }, { status: 500 });
    }
    return NextResponse.json({ url: presign.publicUrl, kind: spec.kind });
  } catch (e) {
    return NextResponse.json({ error: (e as Error)?.message || "素材上传失败" }, { status: 500 });
  }
}
