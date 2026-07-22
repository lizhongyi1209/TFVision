import type { Billing, ModelName, Quality, Resolution, VideoModel, VideoResolution } from "./types";

// ── Image models (o1key async API, ported from TVision) ─────────────────────

export interface ModelInfo {
  name: ModelName;
  /** User-facing TFvision name. Keep `name` unchanged because it is also the API model key. */
  label: string;
  resolutions: Resolution[];
  blurb: string;
}

export const MODELS: ModelInfo[] = [
  { name: "Nano Banana Pro", label: "TF NB Pro", resolutions: ["1K", "2K", "4K"], blurb: "质量最佳 · 推荐" },
  { name: "Nano Banana 2", label: "TF NB 2", resolutions: ["512", "1K", "2K", "4K"], blurb: "快速批量 · 最新" },
  { name: "Nano Banana", label: "TF NB", resolutions: ["1K"], blurb: "普通质量 · 初代" },
  { name: "GPT Image 2", label: "TF Image 2", resolutions: ["1K", "2K", "4K"], blurb: "文字和真实感出色" },
];

export function modelLabel(model: ModelName): string {
  return MODELS.find((item) => item.name === model)?.label ?? model;
}

/** GPT Image 2 has no aspect_ratio param — exact pixel size for a tier+ratio
 *  comes from this table. Ratios not listed are disabled in the UI for this
 *  model; "auto" sends the tier string straight through as `size`. */
export const GPT_IMAGE_2_SIZE_TABLE: Record<string, Record<string, string>> = {
  "1K": {
    "1:1": "1024x1024",
    "3:2": "1536x1024",
    "2:3": "1024x1536",
    "4:3": "1360x1024",
    "3:4": "1024x1360",
    "16:9": "1824x1024",
    "9:16": "1024x1824",
  },
  "2K": {
    "1:1": "2048x2048",
    "3:2": "3072x2048",
    "2:3": "2048x3072",
    "4:3": "2736x2048",
    "3:4": "2048x2736",
    "16:9": "3648x2048",
    "9:16": "2048x3648",
  },
  "4K": {
    "1:1": "2880x2880",
    "3:2": "3504x2336",
    "2:3": "2336x3504",
    "4:3": "3264x2448",
    "3:4": "2448x3264",
    "16:9": "3840x2160",
    "9:16": "2160x3840",
  },
};

export const GPT_IMAGE_2_RATIOS = ["auto", "1:1", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9"];

export const QUALITY_OPTIONS: { value: Quality; label: string }[] = [
  { value: "auto", label: "自动" },
  { value: "high", label: "高" },
  { value: "medium", label: "中" },
  { value: "low", label: "低" },
];

export const BILLINGS: Billing[] = ["特价", "官方"];

export const ASPECT_RATIOS = ["auto", "1:1", "1:2", "2:1", "9:16", "16:9", "3:4", "4:3", "3:2", "2:3", "5:4", "4:5", "21:9", "9:21"];

/** Free-form multi-reference cap: refs in addition to the base image. */
export const MAX_REF_IMAGES = 8;

export function resolutionsFor(model: ModelName): Resolution[] {
  return MODELS.find((m) => m.name === model)?.resolutions ?? (["2K"] as Resolution[]);
}

/** Mirror buildModelId's validity rules so the UI can gate invalid combos before spending credits. */
export function comboError(
  model: ModelName,
  resolution: Resolution,
  _billing: Billing,
  aspectRatio?: string,
): string | null {
  if (!resolutionsFor(model).includes(resolution)) return `${model} 不支持 ${resolution}`;
  if (model === "GPT Image 2" && aspectRatio && aspectRatio !== "auto" && !GPT_IMAGE_2_RATIOS.includes(aspectRatio)) {
    return `GPT Image 2 不支持 ${aspectRatio} 比例`;
  }
  return null;
}

// ── Video models (Kling / Seedance, ported from TVision) ────────────────────

export interface VideoModelInfo {
  value: VideoModel;
  label: string;
  blurb: string;
}

export const VIDEO_MODELS: VideoModelInfo[] = [
  { value: "v3", label: "可灵 v3", blurb: "图生视频 · 分镜" },
  { value: "v2-6", label: "可灵 v2.6", blurb: "快速 · 5/10s" },
  { value: "v3-omni", label: "可灵 v3 Omni", blurb: "多模态参考" },
  { value: "seedance-2.0", label: "Seedance 2.0", blurb: "多参考 · 4K" },
  { value: "seedance-2.0-fast", label: "Seedance 2.0 Fast", blurb: "极速 720p" },
];

export const VIDEO_MODEL_RESOLUTIONS: Record<VideoModel, readonly VideoResolution[]> = {
  "v3": ["720p", "1080p", "4K"],
  "v2-6": ["720p", "1080p"],
  "v3-omni": ["720p", "1080p", "4K"],
  "seedance-2.0": ["720p", "1080p", "4K"],
  "seedance-2.0-fast": ["720p"],
};

export function videoDurationsFor(model: VideoModel): readonly number[] {
  if (model === "v2-6") return [5, 10];
  if (model === "seedance-2.0" || model === "seedance-2.0-fast") {
    return [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  }
  return [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
}

// ── Style presets (TFvision 特色：电商风格一键注入) ──────────────────────────
// 每个风格是一段追加到用户提示词后的英文风格描述。以电商摄影为主。

export interface StylePreset {
  id: string;
  label: string;
  hint: string;
  suffix: string;
}

export const STYLE_PRESETS: StylePreset[] = [
  { id: "none", label: "无风格", hint: "完全按提示词生成", suffix: "" },
  {
    id: "ecom-white",
    label: "电商白底",
    hint: "纯白背景商品主图",
    suffix:
      "Clean pure white (#FFFFFF) seamless studio background, soft even lighting, subtle natural contact shadow, crisp commercial e-commerce product photography, sharp focus, high detail.",
  },
  {
    id: "studio",
    label: "影棚灯光",
    hint: "深色影棚质感大片",
    suffix:
      "Professional dark studio photography, dramatic softbox lighting, rich shadows, premium editorial look, shallow depth of field, high-end commercial photography.",
  },
  {
    id: "outdoor",
    label: "户外实景",
    hint: "自然光生活方式",
    suffix:
      "Natural outdoor lifestyle photography, golden hour sunlight, believable real-world environment, candid composition, warm natural color grade.",
  },
  {
    id: "flatlay",
    label: "平铺俯拍",
    hint: "俯视角平铺构图",
    suffix:
      "Top-down flat-lay composition, perfectly arranged on a clean background, photographed directly from above, soft even lighting, minimal props, editorial flat-lay styling.",
  },
  {
    id: "film",
    label: "胶片质感",
    hint: "复古胶片色调",
    suffix:
      "Analog film photography aesthetic, subtle grain, muted vintage color palette, soft highlights, Kodak Portra tones, nostalgic atmosphere.",
  },
  {
    id: "minimal",
    label: "极简留白",
    hint: "大量留白高级感",
    suffix:
      "Minimalist composition with generous negative space, single subject focus, muted neutral palette, clean geometry, premium brand aesthetic.",
  },
];

export function styleSuffix(styleId: string): string {
  return STYLE_PRESETS.find((s) => s.id === styleId)?.suffix ?? "";
}
