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

export interface AgentImagePlan {
  prompt: string;
  aspectRatio: string;
  resolution: Resolution;
  count: number;
  note: string;
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
export type NodeStatus = "idle" | "running" | "success" | "failed" | "cancelled";

export type GroupColor = "graphite" | "slate" | "teal" | "amber" | "rose";

export type GroupNodeData = {
  label: string;
  color: GroupColor;
  [key: string]: unknown;
};

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

export const MAX_IMAGE_REFERENCES = 10;
export const MAX_BATCH_PROMPTS = 100;
export const MAX_COMBINATION_GROUPS = 8;

export type CombinationOption = {
  id: string;
  /** 该选项专属参考图；与其他分类各取一项后按顺序附加。 */
  image?: string;
};

export type CombinationGroup = {
  id: string;
  name: string;
  options: CombinationOption[];
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
  /** 与 jobIds / urls 对齐的组合来源标签。 */
  jobLabels?: string[];
  resultLabels?: string[];
  prompt: string;
  promptHeight?: number;
  /** 批量模式下，每个非空条目都是一次独立并发提交。 */
  batchPromptEnabled?: boolean;
  batchPrompts?: string[];
  /** 通用组合模式：节点参考图优先作为第一分类，再与上传分类做笛卡尔积。 */
  combinationEnabled?: boolean;
  combinationGroups?: CombinationGroup[];
  /** 结果节点记录本批实际提交的提示词套数。 */
  batchSize?: number;
  submissionFailures?: number;
  /** 每次提交创建的只读结果节点；任务状态与生成图片只写入该节点。 */
  isGeneratedResult?: boolean;
  /** 发起本次生成的参数/参考图片节点。 */
  generationSourceId?: string;
  cancelledAt?: number;
  /** 局部编辑的透明蒙版与带高亮的 AI 引导图。 */
  editMask?: string;
  editGuide?: string;
  editMaskImageIndex?: number;
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

export type AnyNodeData = TextNodeData | ImageNodeData | VideoNodeData | GroupNodeData;

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
