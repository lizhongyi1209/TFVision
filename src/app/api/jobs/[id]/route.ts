import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { readSettings } from "@/lib/settings";
import { fetchResultBytes, pollTaskOnce, resolveBaseUrl } from "@/lib/o1key";
import type { JobStatusResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OUTPUT_DIR = path.join(process.cwd(), "output");

async function findExisting(nameNoExt: string): Promise<string | null> {
  for (const ext of [".png", ".jpg", ".webp"]) {
    try {
      await fs.access(path.join(OUTPUT_DIR, nameNoExt + ext));
      return nameNoExt + ext;
    } catch {
      // keep looking
    }
  }
  return null;
}

// Poll one task upstream. On success, download the result image(s) to /output
// and return local media URLs. Idempotent: re-polling a saved job reuses files.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const s = await readSettings();

  const fail = (error: string): JobStatusResponse => ({ id, status: "failed", progress: null, images: [], error });
  if (!s.apiKey) return NextResponse.json(fail("未设置 API 令牌"));

  const baseUrl = resolveBaseUrl(s.route);
  try {
    const poll = await pollTaskOnce(baseUrl, s.apiKey, id);

    if (poll.status === "success") {
      await fs.mkdir(OUTPUT_DIR, { recursive: true });
      const saved: string[] = [];
      for (let i = 0; i < poll.images.length; i++) {
        const nameNoExt = `${id}${poll.images.length > 1 ? `_${i}` : ""}`;
        const existing = await findExisting(nameNoExt);
        if (existing) {
          saved.push(`/api/media/${existing}`);
          continue;
        }
        try {
          const { bytes, ext } = await fetchResultBytes(poll.images[i], s.apiKey);
          const fname = `${nameNoExt}${ext}`;
          await fs.writeFile(path.join(OUTPUT_DIR, fname), bytes);
          saved.push(`/api/media/${fname}`);
        } catch {
          if (poll.images[i].kind === "url") saved.push(poll.images[i].value); // fallback to upstream URL
        }
      }
      const res: JobStatusResponse = { id, status: "success", progress: 1, images: saved };
      return NextResponse.json(res);
    }

    if (poll.status === "failed") {
      return NextResponse.json(fail(poll.error || "生成失败"));
    }

    const res: JobStatusResponse = { id, status: "running", progress: poll.progress, images: [] };
    return NextResponse.json(res);
  } catch (e) {
    return NextResponse.json(fail((e as Error)?.message || "查询失败"));
  }
}
