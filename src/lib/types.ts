// Shared types across client and server.

// ── Image generation (o1key async API) ──────────────────────────────────────

export type RouteName = "全球加速";
export type Billing = "特价" | "官方";
export type Resolution = "512" | "1K" | "2K" | "4K";
export type ModelName = "Nano Banana Pro" | "Nano Banana 2" | "Nano Banana" | "GPT Image 2";
/** Only meaningful for GPT Image 2 — the nano-banana family has no quality knob. */
export type Quality = "auto" | "high" | "medium" | "low";

export interface SettingsDefaults {
  model: ModelName;
  resolution: Resolution;
  billing: Billing;
  aspectRatio: string;
}

export interface Settings {
  apiKey: string;
  route: RouteName;
  defaults: SettingsDefaults;
}

export type PublicSettings = Omit<Settings, "apiKey"> & {
  hasApiKey: boolean;
  apiKeyMasked: string;
};

export type JobStatus = "running" | "success" | "failed";

export interface JobStatusResponse {
  id: string;
  status: JobStatus;
  progress: number | null;
  images: string[]; // local media URLs
  error?: string;
}

export interface GenMeta {
  prompt: string;
  model: ModelName;
  resolution: Resolution;
  aspectRatio: string;
  billing: Billing;
  count: number;
  createdAt: number;
  refCount?: number;
  quality?: Quality;
}

// ── Video generation (Kling / Seedance via o1key gateway) ───────────────────

export type KlingModel = "v3" | "v2-6" | "v3-omni";
export type SeedanceModel = "seedance-2.0" | "seedance-2.0-fast";
export type VideoModel = KlingModel | SeedanceModel;
export type VideoResolution = "480p" | "720p" | "1080p" | "4K";
export type VideoAspectRatio = "智能" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16" | "21:9";

/** 前端发给 /api/video/jobs 的请求体。 */
export interface VideoJobParams {
  model: VideoModel;
  mode: VideoResolution;
  duration: number;
  prompt: string;
  negativePrompt?: string;
  sound: boolean;
  aspectRatio?: VideoAspectRatio;
  watermark?: boolean;
  webSearch?: boolean;
  cameraFixed?: boolean;
  seed?: number;
  imageUrl?: string;
  tailUrl?: string;
  refUrls?: string[];
  videoUrls?: string[];
  audioUrls?: string[];
}

/** 视频生成任务的参数快照（写入 data/video-meta.json sidecar）。 */
export interface VideoMeta {
  taskId: string;
  model: string;
  mode: string;
  duration: number;
  prompt: string;
  sound: boolean;
  aspectRatio: string;
  createdAt: number;
}

// ── History ──────────────────────────────────────────────────────────────────

export interface HistoryItem {
  name: string;
  url: string;
  kind: "image" | "video";
  createdAt: number;
  size: number;
  meta?: GenMeta;
  videoMeta?: VideoMeta;
}

// ── Canvas node data (client-side, persisted in boards.json) ────────────────

export type NodeKind = "text" | "image" | "video";
export type NodeStatus = "idle" | "running" | "success" | "failed";

export type TextNodeData = {
  label: string;
  text: string;
  /** 富文本 HTML（内联编辑器的源）；text 始终保存对应的纯文本，供下游取提示词。 */
  html?: string;
  reversing: boolean;
  error?: string;
  /** 节点卡片宽度（右下角把手拖拽调整），高度随内容自适应。 */
  width?: number;
  /** 内容区显式高度（右下角把手拖拽调整）；未设置时随内容自适应。 */
  height?: number;
  [key: string]: unknown;
};

export type ImageNodeData = {
  label: string;
  url: string | null;
  urls: string[];
  activeIndex: number;
  status: NodeStatus;
  progress: number;
  error?: string;
  startedAt?: number;
  jobIds: string[];
  prompt: string;
  styleId: string;
  model: ModelName;
  resolution: Resolution;
  aspectRatio: string;
  billing: Billing;
  quality: Quality;
  count: number;
  width?: number;
  height?: number;
  [key: string]: unknown;
};

export type VideoNodeData = {
  label: string;
  url: string | null;
  remoteUrl?: string;
  status: NodeStatus;
  progress: number;
  error?: string;
  startedAt?: number;
  taskId?: string;
  prompt: string;
  model: VideoModel;
  mode: VideoResolution;
  duration: number;
  aspectRatio: VideoAspectRatio;
  sound: boolean;
  cameraFixed: boolean;
  width?: number;
  height?: number;
  [key: string]: unknown;
};

export type AnyNodeData = TextNodeData | ImageNodeData | VideoNodeData;

// ── Board persistence (data/boards.json) ────────────────────────────────────

export interface BoardContent {
  /** React Flow node/edge snapshots. Kept loosely typed server-side. */
  nodes: unknown[];
  edges: unknown[];
  counters: Record<string, number>;
}

export interface BoardRecord extends BoardContent {
  id: string;
  name: string;
  updatedAt: number;
}

export interface WorkspaceFile {
  workspaceName: string;
  activeId: string;
  boards: BoardRecord[];
}
