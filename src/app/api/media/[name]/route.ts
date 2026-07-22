import { promises as fs } from "fs";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const OUTPUT_DIR = path.join(process.cwd(), "output");
const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
};

// Stream a generated file from /output. Path is basename-sanitized.
export async function GET(_req: Request, ctx: { params: Promise<{ name: string }> }) {
  const { name } = await ctx.params;
  const safe = path.basename(name);
  const ext = path.extname(safe).toLowerCase();
  const type = TYPES[ext];
  if (!type) return new Response("Not found", { status: 404 });

  try {
    const buf = await fs.readFile(path.join(OUTPUT_DIR, safe));
    return new Response(new Uint8Array(buf), {
      headers: { "Content-Type": type, "Cache-Control": "public, max-age=31536000, immutable" },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
