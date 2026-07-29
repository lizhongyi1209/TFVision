// Video gateway helpers (ported from TVision src/lib/videoGateway.ts).
// Builds Kling / Seedance request bodies and extracts task ids / video URLs.

import type { VideoAspectRatio, VideoBillingEntry, VideoInputMode, VideoJobParams, VideoModel, VideoReferenceAsset, VideoResolution } from "./types";
import { assignVideoPromptReferences } from "./videoPromptReferences.ts";

export const VIDEO_MODEL_IDS: Record<VideoModel, string> = {
  "v3": "kling-v3",
  "v2-6": "kling-v2-6",
  "v3-omni": "kling-v3-omni",
  "v3-motion-control": "kling-3.0",
  "seedance-2.0": "seedance-2.0",
  "seedance-2.0-fast": "seedance-2.0-fast",
  "seedance-2.0-mini": "seedance-2.0-mini",
};

const SEEDANCE_MODELS = new Set<VideoModel>(["seedance-2.0", "seedance-2.0-fast", "seedance-2.0-mini"]);

const MODEL_RESOLUTIONS: Record<VideoModel, readonly VideoResolution[]> = {
  "v3": ["720p", "1080p", "4K"],
  "v2-6": ["720p", "1080p"],
  "v3-omni": ["720p", "1080p", "4K"],
  "v3-motion-control": ["720p", "1080p"],
  "seedance-2.0": ["720p", "1080p", "4K"],
  "seedance-2.0-fast": ["720p"],
  "seedance-2.0-mini": ["720p"],
};

const SEEDANCE_RATIOS = new Set<VideoAspectRatio>(["智能", "16:9", "4:3", "1:1", "3:4", "9:16"]);
const KLING_OMNI_RATIOS = new Set<VideoAspectRatio>(["智能", "16:9", "9:16", "1:1"]);

export function isSeedanceModel(model: string): boolean {
  return SEEDANCE_MODELS.has(model as VideoModel);
}

export function isVideoModel(model: string): model is VideoModel {
  return Object.prototype.hasOwnProperty.call(VIDEO_MODEL_IDS, model);
}

export function allowedVideoResolutions(model: VideoModel): readonly VideoResolution[] {
  return MODEL_RESOLUTIONS[model];
}

export function allowedVideoDurations(model: VideoModel): readonly number[] {
  if (model === "v2-6") return [5, 10];
  if (model === "v3-motion-control") {
    return [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30];
  }
  if (isSeedanceModel(model)) return [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  return [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
}

export function allowedVideoAspectRatios(model: VideoModel): readonly VideoAspectRatio[] {
  if (isSeedanceModel(model)) return Array.from(SEEDANCE_RATIOS);
  if (model === "v3-omni") return Array.from(KLING_OMNI_RATIOS);
  return [];
}

export function supportsShots(model: VideoModel): boolean {
  return model !== "v2-6" && model !== "v3-motion-control" && !isSeedanceModel(model);
}

export function shouldUseConnectedImageAsFirstFrame(
  model: VideoModel,
  inputMode: VideoInputMode,
  hasExplicitFirstFrame: boolean,
): boolean {
  if (hasExplicitFirstFrame) return false;
  return model === "v3" || model === "v2-6" || inputMode === "keyframes";
}

export function resolveKeyframeSlots(
  explicitAssets: readonly VideoReferenceAsset[],
  connectedImages: readonly VideoReferenceAsset[],
): {
  firstFrame?: VideoReferenceAsset;
  lastFrame?: VideoReferenceAsset;
  connectedFrameIds: string[];
} {
  let firstFrame = explicitAssets.find((asset) => asset.kind === "image" && asset.role === "first_frame");
  let lastFrame = explicitAssets.find((asset) => asset.kind === "image" && asset.role === "last_frame");
  const openRoles = [
    ...(!firstFrame ? ["first_frame" as const] : []),
    ...(!lastFrame ? ["last_frame" as const] : []),
  ];
  const connectedFrameIds: string[] = [];

  for (const asset of connectedImages) {
    const role = openRoles.shift();
    if (!role) break;
    const assigned = { ...asset, role };
    connectedFrameIds.push(asset.id);
    if (role === "first_frame") firstFrame = assigned;
    else lastFrame = assigned;
  }

  return { firstFrame, lastFrame, connectedFrameIds };
}

export function videoStatusEndpoint(model: VideoModel, taskId: string): string {
  const encodedTaskId = encodeURIComponent(taskId);
  if (model === "v3-omni") return `/kling/omni-video/kling-3.0-omni/${encodedTaskId}`;
  if (model === "v3-motion-control") return `/kling/motion-control/kling-3.0/${encodedTaskId}`;
  if (isSeedanceModel(model)) return `/v1/video/generations/${encodedTaskId}`;
  return `/kling/v1/videos/image2video/${encodedTaskId}`;
}

export function maxReferenceImages(model: VideoModel): number {
  return isSeedanceModel(model) ? 9 : 7;
}

export function maxReferenceVideos(model: VideoModel): number {
  if (isSeedanceModel(model)) return 3;
  if (model === "v3-omni" || model === "v3-motion-control") return 1;
  return 0;
}

function cleanUrls(values: unknown, limit: number): string[] {
  if (!Array.isArray(values)) return [];
  const urls = values
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  if (urls.length > limit) throw new Error(`参考素材数量超过 ${limit} 个上限`);
  for (const url of urls) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("参考素材 URL 格式无效");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("参考素材 URL 只支持 HTTP 或 HTTPS");
    }
  }
  return urls;
}

export function buildKlingMotionControlGenerationBody(params: VideoJobParams): Record<string, unknown> {
  if (params.model !== "v3-motion-control") throw new Error("不是可灵 3.0 动作控制模型");
  if (!allowedVideoResolutions(params.model).includes(params.mode)) {
    throw new Error(`可灵动作控制不支持 ${params.mode} 分辨率`);
  }

  const prompt = (params.prompt ?? "").trim();
  if (!prompt) throw new Error("提示词不能为空");
  if (prompt.length > 2500) throw new Error("可灵动作控制提示词不能超过 2500 字符");

  const imageUrls = cleanUrls(params.refUrls, 1);
  const videoUrls = cleanUrls(params.videoUrls, 1);
  if (videoUrls.length !== 1) throw new Error("可灵动作控制必须提供 1 段动作参考视频");

  const elementId = typeof params.elementId === "string" ? params.elementId.trim() : "";
  if (elementId) throw new Error("当前版本暂不支持 Element，请使用形象参考图");
  if (imageUrls.length !== 1) throw new Error("请提供 1 张形象参考图");

  const requestedOrientation = params.characterOrientation === "image" ? "image" : "video";
  const audio = params.audioMode === "original" ? "original" : "off";

  const contents: Record<string, unknown>[] = [{ type: "prompt", text: prompt }];
  contents.push({ type: "image", url: imageUrls[0] });
  contents.push({ type: "video", url: videoUrls[0] });

  const options: Record<string, unknown> = {
    watermark_info: { enabled: false },
  };

  return {
    contents,
    settings: {
      character_orientation: requestedOrientation,
      audio,
      resolution: params.mode,
    },
    options,
  };
}

export function buildKlingOmniGenerationBody(params: VideoJobParams): Record<string, unknown> {
  if (params.model !== "v3-omni") throw new Error("不是可灵 3.0 Omni 模型");
  if (!allowedVideoResolutions(params.model).includes(params.mode)) {
    throw new Error(`可灵 Omni 不支持 ${params.mode} 分辨率`);
  }
  if (!allowedVideoDurations(params.model).includes(params.duration)) {
    throw new Error("可灵 Omni 时长仅支持 3-15 秒的整数");
  }

  const shots = Array.isArray(params.shots) ? params.shots : [];
  const shotMode = params.shotMode ?? (shots.length ? "custom" : "single");
  let promptText = (params.prompt ?? "").trim();
  if (shots.length) {
    if (shots.length > 6) throw new Error("可灵 Omni 最多支持 6 段分镜");
    if (shots.some((shot) => !shot.prompt.trim() || shot.prompt.length > 512 || !Number.isInteger(shot.duration) || shot.duration < 1)) {
      throw new Error("每段分镜需包含不超过 512 字的提示词和至少 1 秒的整数时长");
    }
    const total = shots.reduce((sum, shot) => sum + shot.duration, 0);
    if (total !== params.duration) throw new Error(`分镜总时长 ${total}s 必须等于视频时长 ${params.duration}s`);
    promptText = shots.map((shot, index) => `shot ${index + 1}, ${shot.duration}, ${shot.prompt.trim()};`).join(" ");
  }
  if (!promptText) throw new Error("提示词不能为空");
  if (promptText.length > 3072) throw new Error("可灵 Omni 提示词不能超过 3072 字符");

  const firstUrl = cleanUrls(params.imageUrl ? [params.imageUrl] : [], 1)[0];
  const lastUrl = cleanUrls(params.tailUrl ? [params.tailUrl] : [], 1)[0];
  const referenceUrls = cleanUrls(params.refUrls, 7);
  const videoUrls = cleanUrls(params.videoUrls, 1);
  const audioUrls = cleanUrls(params.audioUrls, 1);
  if (audioUrls.length) throw new Error("可灵 Omni 不支持参考音频");
  if (lastUrl && !firstUrl) throw new Error("可灵 Omni 不支持仅尾帧，请先添加首帧");

  const referType = params.referType === "base" ? "base" : "feature";
  const hasVideo = videoUrls.length > 0;
  const hasBaseVideo = hasVideo && referType === "base";
  const hasFeatureVideo = hasVideo && referType === "feature";
  const imageTotal = referenceUrls.length + (firstUrl ? 1 : 0) + (lastUrl ? 1 : 0);
  if (imageTotal > (hasVideo ? 4 : 7)) {
    throw new Error(`当前组合最多支持 ${hasVideo ? 4 : 7} 张图片`);
  }
  if (hasBaseVideo && (firstUrl || lastUrl)) throw new Error("基础视频编辑模式不支持首尾帧");
  if (hasBaseVideo && shotMode !== "single") throw new Error("基础视频编辑模式不支持多镜头");

  const audioMode = params.audioMode
    ?? (params.keepOriginalSound ? "original" : params.sound ? "native" : "off");
  if (hasFeatureVideo && audioMode === "native") throw new Error("特征参考视频模式不能生成原生音频，可选择保留原声或关闭声音");
  if (hasBaseVideo && audioMode === "native") throw new Error("基础视频编辑模式不支持生成原生音频");
  if (!hasVideo && audioMode === "original") throw new Error("没有参考视频时不能保留原声");

  const ratio = params.aspectRatio ?? "智能";
  if (!KLING_OMNI_RATIOS.has(ratio)) throw new Error("可灵 Omni 宽高比无效");
  if (!firstUrl && !hasVideo && ratio === "智能") {
    throw new Error("没有首帧或参考视频时必须选择 16:9、9:16 或 1:1");
  }

  const contentReferences = assignVideoPromptReferences([
    ...(firstUrl ? [{ key: "first-frame", kind: "image" as const, name: firstUrl, role: "first_frame" as const }] : []),
    ...(lastUrl ? [{ key: "last-frame", kind: "image" as const, name: lastUrl, role: "last_frame" as const }] : []),
    ...referenceUrls.map((url, index) => ({ key: `reference-image-${index}`, kind: "image" as const, name: url, role: "reference" as const })),
    ...(hasVideo ? [{ key: "reference-video", kind: "video" as const, name: videoUrls[0], role: "reference" as const }] : []),
  ]);
  const contents: Record<string, unknown>[] = [{ type: "prompt", text: promptText }];
  for (const reference of contentReferences) {
    if (reference.kind === "image") {
      const type = reference.role === "first_frame"
        ? "first_frame"
        : reference.role === "last_frame" ? "last_frame" : "refer_image";
      contents.push({ type, url: reference.name, id: reference.promptId });
    } else if (reference.kind === "video") {
      contents.push({
        type: hasBaseVideo ? "base_video" : "feature_video",
        url: reference.name,
        id: reference.promptId,
      });
    }
  }

  const settings: Record<string, unknown> = {
    multi_shot: hasFeatureVideo ? true : hasBaseVideo ? false : shotMode !== "single",
    audio: audioMode,
    resolution: params.mode === "4K" ? "4k" : params.mode,
    duration: params.duration,
  };
  if (ratio !== "智能") settings.aspect_ratio = ratio;

  return {
    contents,
    settings,
    options: { watermark_info: { enabled: false } },
  };
}

export function buildSeedanceGenerationBody(params: VideoJobParams): Record<string, unknown> {
  if (!isSeedanceModel(params.model)) throw new Error("不是 Seedance 2.0 模型");

  const prompt = (params.prompt ?? "").trim();
  if (!prompt) throw new Error("提示词不能为空");

  const resolutions = allowedVideoResolutions(params.model);
  if (!resolutions.includes(params.mode)) {
    throw new Error(`${params.model} 不支持 ${params.mode} 分辨率`);
  }

  const duration = params.duration ?? 5;
  if (!Number.isInteger(duration) || duration < 4 || duration > 15) {
    throw new Error("Seedance 时长仅支持 4-15 秒的整数");
  }

  const ratio = params.aspectRatio ?? "智能";
  if (!SEEDANCE_RATIOS.has(ratio)) throw new Error("Seedance 宽高比无效");

  const firstUrl = cleanUrls(params.imageUrl ? [params.imageUrl] : [], 1)[0];
  const lastUrl = cleanUrls(params.tailUrl ? [params.tailUrl] : [], 1)[0];
  const referenceUrls = cleanUrls(params.refUrls, 9);
  const videoUrls = cleanUrls(params.videoUrls, 3);
  const audioUrls = cleanUrls(params.audioUrls, 3);

  if ((firstUrl || lastUrl) && (referenceUrls.length || videoUrls.length || audioUrls.length)) {
    throw new Error("首尾帧模式不能与多模态参考素材混用");
  }
  if (audioUrls.length && !firstUrl && !referenceUrls.length && !videoUrls.length) {
    throw new Error("参考音频不能单独提交，请同时添加图片或视频");
  }

  const images: Record<string, unknown>[] = [];
  if (firstUrl) images.push({ url: firstUrl, role: "first_frame" });
  if (lastUrl) images.push({ url: lastUrl, role: "last_frame" });
  for (const url of referenceUrls) images.push({ url, role: "reference_image" });

  const body: Record<string, unknown> = {
    model: VIDEO_MODEL_IDS[params.model],
    prompt,
    resolution: params.mode === "4K" ? "4k" : params.mode,
    duration,
    camera_fixed: params.cameraFixed === true,
    generate_audio: params.sound === true,
    web_search: params.webSearch === true,
  };
  if (ratio !== "智能") body.ratio = ratio;
  if (params.seed !== undefined && params.seed !== null) {
    if (!Number.isInteger(params.seed)) throw new Error("随机种子必须是整数");
    body.seed = params.seed;
  }
  if (images.length) body.images = images;
  if (videoUrls.length) body.videos = videoUrls;
  if (audioUrls.length) body.audios = audioUrls;
  return body;
}

function* payloadObjects(payload: unknown): Generator<Record<string, unknown>> {
  const queue: unknown[] = [payload];
  const seen = new Set<unknown>();
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      queue.push(...current);
      continue;
    }
    const record = current as Record<string, unknown>;
    yield record;
    queue.push(...Object.values(record));
  }
}

export function extractVideoTaskId(payload: unknown): string | null {
  const sources = Array.from(payloadObjects(payload));
  for (const source of sources) {
    for (const key of ["task_id", "taskId"]) {
      const value = source[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  for (const source of sources) {
    const value = source.id;
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

export function extractGeneratedVideoUrl(payload: unknown): string | null {
  const sources = Array.from(payloadObjects(payload));
  for (const source of sources) {
    for (const key of ["video_url", "result_url", "download_url"]) {
      const value = source[key];
      if (typeof value === "string" && /^https?:\/\//i.test(value)) return value;
    }
  }
  for (const source of sources) {
    const value = source.url;
    if (typeof value !== "string" || !/^https?:\/\//i.test(value)) continue;
    const mediaHint = String(source.type ?? source.kind ?? source.mime_type ?? source.content_type ?? "").toLowerCase();
    if (mediaHint.includes("video") || /\.(?:mp4|mov|webm)(?:[?#]|$)/i.test(value)) return value;
  }
  return null;
}

export interface VideoResultMetadata {
  videoUrl: string | null;
  watermarkUrl?: string;
  outputDuration?: string;
  requestId?: string;
  billing: VideoBillingEntry[];
}

/** Normalize both legacy nested task responses and the compact Kling Omni result. */
export function extractVideoResultMetadata(payload: unknown, taskId?: string): VideoResultMetadata {
  const sources = Array.from(payloadObjects(payload));
  const root = sources[0];
  const videoUrl = extractGeneratedVideoUrl(payload);
  const videoSource = videoUrl
    ? sources.find((source) => {
        const candidate = source.video_url ?? source.result_url ?? source.download_url ?? source.url;
        return candidate === videoUrl;
      })
    : undefined;
  const taskSource = taskId
    ? sources.find((source) => (source.task_id ?? source.taskId ?? source.id) === taskId)
    : undefined;
  const billingSource = taskSource ?? root;
  const nestedBilling = Array.isArray(billingSource?.billing)
    ? billingSource.billing.filter(
        (entry): entry is VideoBillingEntry => !!entry && typeof entry === "object" && !Array.isArray(entry),
      )
    : [];
  const compactCost = root?.cost;
  const billing = nestedBilling.length
    ? nestedBilling
    : compactCost != null && String(compactCost).trim()
      ? [{ charge_type: "unit", amount: String(compactCost) }]
      : [];
  const duration = videoSource?.duration ?? root?.duration;
  const requestId = sources.find((source) => typeof source.request_id === "string")?.request_id;

  return {
    videoUrl,
    watermarkUrl: typeof videoSource?.watermark_url === "string" ? videoSource.watermark_url : undefined,
    outputDuration: duration != null ? String(duration) : undefined,
    requestId: typeof requestId === "string" ? requestId : undefined,
    billing,
  };
}
