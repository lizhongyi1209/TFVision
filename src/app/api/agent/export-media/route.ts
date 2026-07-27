import { NextResponse } from "next/server";
import { exportImageUrlsToLocalDirectory } from "@/lib/localMedia.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { urls?: unknown; outputDirectory?: unknown };
  const urls = Array.isArray(body.urls)
    ? body.urls.filter((value): value is string => typeof value === "string" && Boolean(value)).slice(0, 4)
    : [];
  if (!urls.length) return NextResponse.json({ error: "缺少要导出的图片" }, { status: 400 });
  try {
    const paths = await exportImageUrlsToLocalDirectory(urls, body.outputDirectory);
    return NextResponse.json({ paths });
  } catch (error) {
    return NextResponse.json({ error: (error as Error)?.message || "导出图片失败" }, { status: 400 });
  }
}
