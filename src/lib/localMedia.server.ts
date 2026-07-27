import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveCodingWorkspaceRoot } from "./codingTools.server";

const OUTPUT_DIR = path.join(process.cwd(), "output");
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

function extensionForContentType(contentType: string) {
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("gif")) return ".gif";
  if (contentType.includes("mp4")) return ".mp4";
  return ".jpg";
}

async function uniqueTarget(directory: string, extension: string, prefix = "tfvision") {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (let index = 0; index < 1000; index += 1) {
    const suffix = index ? `-${index + 1}` : "";
    const target = path.join(directory, `${prefix}-${stamp}${suffix}${extension}`);
    try {
      await fs.access(target);
    } catch {
      return target;
    }
  }
  throw new Error("目标目录中重名文件过多");
}

export async function copyFileToLocalDirectory(sourcePath: string, rawDirectory: unknown, prefix?: string) {
  const directory = await resolveCodingWorkspaceRoot(rawDirectory);
  const extension = path.extname(sourcePath).toLowerCase() || ".bin";
  const target = await uniqueTarget(directory, extension, prefix);
  await fs.copyFile(sourcePath, target);
  return target;
}

export async function exportImageUrlsToLocalDirectory(urls: string[], rawDirectory: unknown) {
  const directory = await resolveCodingWorkspaceRoot(rawDirectory);
  const saved: string[] = [];

  for (const [index, source] of urls.entries()) {
    let bytes: Buffer;
    let extension: string;
    if (source.startsWith("/api/media/")) {
      const filename = decodeURIComponent(source.slice("/api/media/".length));
      if (!filename || path.basename(filename) !== filename) throw new Error("本地媒体路径无效");
      const localPath = path.join(OUTPUT_DIR, filename);
      bytes = await fs.readFile(localPath);
      extension = path.extname(filename).toLowerCase() || ".png";
    } else if (/^https:\/\//i.test(source)) {
      const response = await fetch(source, { headers: { "User-Agent": "TFvision/1.0" } });
      if (!response.ok) throw new Error(`下载生成图片失败 HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
      extension = extensionForContentType(response.headers.get("content-type") || "");
    } else {
      throw new Error("生成图片地址不受支持");
    }
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error(`第 ${index + 1} 张图片大小异常`);
    const target = await uniqueTarget(directory, extension);
    await fs.writeFile(target, bytes, { flag: "wx" });
    saved.push(target);
  }

  return saved;
}
