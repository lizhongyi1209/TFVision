// 画布持久化：data/boards.json 保存整个工作区（多画布 + 节点/连线快照）。
// GET 读取全部；POST 全量覆盖写入（客户端防抖保存）。

import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import type { WorkspaceFile } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATA_DIR = path.join(process.cwd(), "data");
const BOARDS_PATH = path.join(DATA_DIR, "boards.json");
const MAX_BYTES = 200 * 1024 * 1024; // 画布里可能有 data URL 缩略图，给足空间

export async function GET() {
  try {
    const raw = await fs.readFile(BOARDS_PATH, "utf-8");
    return NextResponse.json(JSON.parse(raw));
  } catch {
    return NextResponse.json(null);
  }
}

export async function POST(req: Request) {
  const text = await req.text();
  if (Buffer.byteLength(text, "utf-8") > MAX_BYTES) {
    return NextResponse.json({ error: "画布数据过大" }, { status: 413 });
  }
  let parsed: WorkspaceFile;
  try {
    parsed = JSON.parse(text) as WorkspaceFile;
  } catch {
    return NextResponse.json({ error: "无效 JSON" }, { status: 400 });
  }
  if (!parsed || !Array.isArray(parsed.boards)) {
    return NextResponse.json({ error: "格式错误" }, { status: 400 });
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(BOARDS_PATH, text, "utf-8");
  return NextResponse.json({ ok: true });
}
