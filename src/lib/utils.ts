import { clsx, type ClassValue } from "clsx";

export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Read a file/blob as-is into a data URL — no re-encoding. Browser-only. */
export function fileToDataURL(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

export interface DownscaledImage {
  dataUrl: string;
  width: number;
  height: number;
}

/**
 * Downscale + recompress an image to a JPEG data URL under a max dimension.
 * Keeps request bodies small (the o1key server caps payloads at 20 MB).
 * Transparent areas flatten onto white. Browser-only.
 */
export async function fileToDownscaledDataURL(
  file: File | Blob,
  maxDim = 1600,
  quality = 0.92,
): Promise<DownscaledImage> {
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  const scale = Math.min(1, maxDim / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close?.();
    throw new Error("无法创建画布上下文");
  }
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  return { dataUrl, width: w, height: h };
}

/** Load an <img> from a src, resolving once decoded. Browser-only. */
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("加载图片失败"));
    img.src = src;
  });
}

/**
 * Downscale an existing src (data URL or same-origin URL) to a JPEG data URL.
 * Sits at the network/submit boundary only — the node keeps the original.
 */
export async function downscaleImageSrc(
  src: string,
  maxDim = 1600,
  quality = 0.92,
): Promise<DownscaledImage> {
  const img = await loadImage(src);
  const { naturalWidth: width, naturalHeight: height } = img;
  const scale = Math.min(1, maxDim / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建画布上下文");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const dataUrl = canvas.toDataURL("image/jpeg", quality);
  return { dataUrl, width: w, height: h };
}

/**
 * Piecewise-linear "believable wait" curve tuned to a 20-60s generation.
 * Returns 0-96; the caller snaps to 100 when the job actually finishes.
 */
export function fakeProgressCurve(seconds: number): number {
  const t = Math.max(0, seconds);
  if (t <= 2) return (t / 2) * 8;
  if (t <= 15) return 8 + ((t - 2) / 13) * (45 - 8);
  if (t <= 40) return 45 + ((t - 15) / 25) * (78 - 45);
  if (t <= 70) return 78 + ((t - 40) / 30) * (90 - 78);
  return Math.min(96, 90 + (t - 70) * 0.08);
}

/** Coarse stage copy for the progress overlay. progress is 0-100. */
export function progressStageLabel(progress: number): string {
  if (progress < 15) return "正在理解提示词…";
  if (progress < 50) return "正在构图…";
  if (progress < 85) return "正在绘制细节…";
  return "即将完成…";
}

export function downloadUrl(url: string, filename: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** HH:MM (24h local) for history rows. */
export function formatClock(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
