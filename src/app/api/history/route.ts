import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { readMetaMap, readVideoMetaMap } from "@/lib/historyMeta";
import type { HistoryItem } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OUTPUT_DIR = path.join(process.cwd(), "output");

export async function GET() {
  try {
    const files = await fs.readdir(OUTPUT_DIR);
    const metaMap = await readMetaMap();
    const videoMetaMap = await readVideoMetaMap();
    const media = files.filter((f) => /\.(png|jpe?g|webp|mp4)$/i.test(f));
    const items: HistoryItem[] = await Promise.all(
      media.map(async (f) => {
        const st = await fs.stat(path.join(OUTPUT_DIR, f));
        const isVideo = /\.mp4$/i.test(f);
        // 文件名规则：图片 <taskId>[_N].ext；视频 video-<taskId>.mp4
        const stem = f.replace(/\.(png|jpe?g|webp|mp4)$/i, "").replace(/_\d+$/, "");
        const videoTaskId = stem.replace(/^video-/, "");
        return {
          name: f,
          url: `/api/media/${f}`,
          kind: isVideo ? ("video" as const) : ("image" as const),
          createdAt: st.mtimeMs,
          size: st.size,
          meta: isVideo ? undefined : metaMap[stem],
          videoMeta: isVideo ? videoMetaMap[videoTaskId] : undefined,
        };
      }),
    );
    items.sort((a, b) => b.createdAt - a.createdAt);
    return NextResponse.json({ items });
  } catch {
    return NextResponse.json({ items: [] });
  }
}

export async function DELETE(req: Request) {
  const { name } = (await req.json().catch(() => ({ name: null }))) as { name: string | null };
  if (!name) return NextResponse.json({ ok: false }, { status: 400 });
  try {
    await fs.unlink(path.join(OUTPUT_DIR, path.basename(name)));
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 404 });
  }
}
