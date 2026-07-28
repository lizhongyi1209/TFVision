import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { tagAmazonAiImage } from "@/lib/amazonAiMetadata.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OUTPUT_DIR = path.join(process.cwd(), "output");
const MAX_FILES = 10;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

type SuccessfulFile = {
  index: number;
  originalName: string;
  name: string;
  url: string;
  bytes: number;
  format: "jpeg" | "png";
  status: "tagged" | "already-tagged";
};

function safeStem(value: string, fallback: string) {
  const withoutExtension = value.replace(/\.[^.]+$/, "");
  const normalized = withoutExtension
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return normalized || fallback;
}

async function uniqueOutputName(stem: string, extension: string) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (let index = 0; index < 1000; index += 1) {
    const suffix = index ? `-${index + 1}` : "";
    const name = `${stem}-${stamp}${suffix}${extension}`;
    try {
      await fs.access(path.join(OUTPUT_DIR, name));
    } catch {
      return name;
    }
  }
  throw new Error("输出目录中的同名文件过多");
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const files = form.getAll("files").filter((value): value is File => value instanceof File);
    if (!files.length) return NextResponse.json({ error: "没有收到图片" }, { status: 400 });
    if (files.length > MAX_FILES) return NextResponse.json({ error: `每次最多处理 ${MAX_FILES} 张图片` }, { status: 400 });

    const rawNames = form.get("names");
    const names = typeof rawNames === "string"
      ? (JSON.parse(rawNames) as unknown[]).map((value) => String(value))
      : [];
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (files.some((file) => file.size > MAX_FILE_BYTES) || totalBytes > MAX_TOTAL_BYTES) {
      return NextResponse.json({ error: "图片体积过大，单张上限 50 MB，单批上限 200 MB" }, { status: 413 });
    }

    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    const successful: SuccessfulFile[] = [];
    const failed: Array<{ index: number; originalName: string; error: string }> = [];

    for (const [index, file] of files.entries()) {
      const originalName = names[index] || file.name || `图片-${index + 1}`;
      try {
        const result = tagAmazonAiImage(Buffer.from(await file.arrayBuffer()));
        const extension = result.format === "png" ? ".png" : ".jpg";
        const stem = `${safeStem(originalName, `图片-${index + 1}`)}-amazon-ready`;
        const outputName = await uniqueOutputName(stem, extension);
        await fs.writeFile(path.join(OUTPUT_DIR, outputName), result.bytes, { flag: "wx" });
        successful.push({
          index,
          originalName,
          name: outputName,
          url: `/api/media/${encodeURIComponent(outputName)}`,
          bytes: result.bytes.length,
          format: result.format,
          status: result.status,
        });
      } catch (error) {
        failed.push({ index, originalName, error: error instanceof Error ? error.message : "处理失败" });
      }
    }

    return NextResponse.json({
      successful,
      failed,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "元数据处理失败" },
      { status: 500 },
    );
  }
}
