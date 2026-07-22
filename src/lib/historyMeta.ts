// Generation-params sidecar (data/history-meta.json): jobId -> GenMeta.
// Lets the history panel show prompt/model for each saved image.

import { promises as fs } from "fs";
import path from "path";
import type { GenMeta } from "./types";

const DATA_DIR = path.join(process.cwd(), "data");
const META_PATH = path.join(DATA_DIR, "history-meta.json");

export async function readMetaMap(): Promise<Record<string, GenMeta>> {
  try {
    const raw = await fs.readFile(META_PATH, "utf-8");
    return JSON.parse(raw) as Record<string, GenMeta>;
  } catch {
    return {};
  }
}

export async function appendMeta(ids: string[], meta: Omit<GenMeta, "createdAt">): Promise<void> {
  const map = await readMetaMap();
  const stamped: GenMeta = { ...meta, createdAt: Date.now() };
  for (const id of ids) map[id] = stamped;
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(META_PATH, JSON.stringify(map, null, 2), "utf-8");
}

// ── Video sidecar (data/video-meta.json): taskId -> VideoMeta ────────────────

import type { VideoMeta } from "./types";

const VIDEO_META_PATH = path.join(DATA_DIR, "video-meta.json");

export async function readVideoMetaMap(): Promise<Record<string, VideoMeta>> {
  try {
    const raw = await fs.readFile(VIDEO_META_PATH, "utf-8");
    return JSON.parse(raw) as Record<string, VideoMeta>;
  } catch {
    return {};
  }
}

export async function appendVideoMeta(meta: VideoMeta): Promise<void> {
  const map = await readVideoMetaMap();
  map[meta.taskId] = meta;
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(VIDEO_META_PATH, JSON.stringify(map, null, 2), "utf-8");
}
