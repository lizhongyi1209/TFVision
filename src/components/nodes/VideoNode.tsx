"use client";

// 视频节点：画布上只保留预览卡片；选中预览后，在卡片下方展开独立的
// 生成设置对话框。交互层级与图片节点保持一致。

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useKeyPress, useReactFlow, type NodeProps } from "@xyflow/react";
import type { AppNode } from "@/lib/store";
import { useStudio } from "@/lib/store";
import type {
  VideoAspectRatio,
  VideoAudioMode,
  VideoFrameRole,
  VideoInputMode,
  VideoModel,
  VideoNodeData,
  VideoReferenceAsset,
  VideoReferenceKind,
  VideoResolution,
  ShotSegment,
} from "@/lib/types";
import { VIDEO_MODELS, VIDEO_MODEL_RESOLUTIONS, videoDurationsFor } from "@/lib/models";
import { allowedVideoAspectRatios, isSeedanceModel, supportsShots } from "@/lib/videoGateway";
import { cn, downloadUrl } from "@/lib/utils";
import {
  forgetVideoReferenceBlob,
  readVideoReferenceBlob,
  rememberVideoReferenceBlob,
} from "@/lib/videoReferenceStorage";
import { Icon } from "../icons";
import { NodeShell, RunningVeil } from "./NodeShell";
import { Chip, Spinner } from "../ui";

const VIDEO_REFERENCE_ACCEPT = "image/png,image/jpeg,image/webp,video/mp4,video/quicktime,audio/wav,audio/mpeg";
const VIDEO_KEYFRAME_ACCEPT = "image/png,image/jpeg,image/webp";
const KLING_OMNI_REFERENCE_ACCEPT = "image/png,image/jpeg,video/mp4,video/quicktime";
const KLING_OMNI_KEYFRAME_ACCEPT = "image/png,image/jpeg";

const isMultiSelectClick = (event: Pick<React.MouseEvent, "ctrlKey" | "metaKey" | "shiftKey">) =>
  event.ctrlKey || event.metaKey || event.shiftKey;

function referenceKind(file: File): VideoReferenceKind | null {
  if (file.type.startsWith("image/") || /\.(?:png|jpe?g|webp)$/i.test(file.name)) return "image";
  if (file.type.startsWith("video/") || /\.(?:mp4|mov)$/i.test(file.name)) return "video";
  if (file.type.startsWith("audio/") || /\.(?:wav|mp3)$/i.test(file.name)) return "audio";
  return null;
}

function readVisualMetadata(file: File, kind: "image" | "video"): Promise<Pick<VideoReferenceAsset, "width" | "height" | "duration">> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    let timeout = 0;
    const finish = (error?: Error, value?: Pick<VideoReferenceAsset, "width" | "height" | "duration">) => {
      window.clearTimeout(timeout);
      URL.revokeObjectURL(objectUrl);
      if (error) reject(error);
      else resolve(value ?? {});
    };
    timeout = window.setTimeout(() => finish(new Error("读取素材信息超时")), 10_000);
    if (kind === "image") {
      const image = new Image();
      image.onload = () => finish(undefined, { width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => finish(new Error("无法读取图片尺寸"));
      image.src = objectUrl;
      return;
    }
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => finish(undefined, {
      width: video.videoWidth,
      height: video.videoHeight,
      duration: video.duration,
    });
    video.onerror = () => finish(new Error("无法读取视频信息"));
    video.src = objectUrl;
    video.load();
  });
}

async function inspectReferenceFile(
  file: File,
  kind: VideoReferenceKind,
  model: VideoModel,
): Promise<Pick<VideoReferenceAsset, "mimeType" | "sizeBytes" | "width" | "height" | "duration">> {
  const base = { mimeType: file.type, sizeBytes: file.size };
  if (model !== "v3-omni") return base;
  if (kind === "audio") throw new Error("可灵 Omni 不支持参考音频");
  if (kind === "image" && !/^(?:image\/jpeg|image\/png)$/i.test(file.type) && !/\.(?:jpe?g|png)$/i.test(file.name)) {
    throw new Error("可灵 Omni 图片仅支持 JPG、JPEG 或 PNG");
  }
  if (kind === "image" && file.size > 50 * 1024 * 1024) throw new Error("可灵 Omni 图片不能超过 50MB");
  if (kind === "video" && file.size > 200 * 1024 * 1024) throw new Error("可灵 Omni 视频不能超过 200MB");
  const metadata = await readVisualMetadata(file, kind);
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  const ratio = height ? width / height : 0;
  if (kind === "image") {
    if (width < 300 || height < 300) throw new Error("可灵 Omni 图片宽高均不能小于 300px");
    if (ratio < 0.4 || ratio > 2.5) throw new Error("可灵 Omni 图片宽高比必须在 1:2.5 到 2.5:1 之间");
  } else {
    const duration = metadata.duration ?? 0;
    if (duration < 3 || duration > 15.5) throw new Error("参考视频时长必须在 3-15.5 秒之间");
    if (width < 700 || height < 700 || width > 4553 || height > 4553) throw new Error("参考视频宽高必须在 700-4553px 之间");
    if (width * height > 8_294_400) throw new Error("参考视频总像素不能超过 8294400");
    if (ratio < 0.4 || ratio > 2) throw new Error("参考视频宽高比必须在 0.4-2 之间");
  }
  return { ...base, ...metadata };
}

function createVideoFirstFrame(file: File): Promise<string | undefined> {
  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const video = document.createElement("video");
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout>;

    const finish = (preview?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(objectUrl);
      resolve(preview);
    };
    const capture = () => {
      if (!video.videoWidth || !video.videoHeight) return finish();
      const scale = Math.min(1, 480 / video.videoWidth, 270 / video.videoHeight);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) return finish();
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      finish(canvas.toDataURL("image/jpeg", 0.78));
    };

    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.onseeked = capture;
    video.onloadeddata = () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0.08) capture();
    };
    video.onloadedmetadata = () => {
      try {
        video.currentTime = Math.min(0.12, Math.max(0, video.duration / 10));
      } catch {
        capture();
      }
    };
    video.onerror = () => finish();
    timeoutId = setTimeout(() => finish(), 8_000);
    video.src = objectUrl;
    video.load();
  });
}

function countReferences(assets: VideoReferenceAsset[]) {
  return {
    image: assets.filter((asset) => asset.kind === "image").length,
    video: assets.filter((asset) => asset.kind === "video").length,
    audio: assets.filter((asset) => asset.kind === "audio").length,
  };
}

function referenceCompatibilityError(model: VideoModel, assets: VideoReferenceAsset[]) {
  const counts = countReferences(assets);
  if (model === "v3-omni") {
    if (counts.audio) return "可灵 v3 Omni 暂不支持参考音频，请移除音频或切换 Seedance";
    if (counts.video > 1) return "可灵 v3 Omni 最多支持 1 段参考视频";
    const imageLimit = counts.video ? 4 : 7;
    if (counts.image > imageLimit) return `当前组合下可灵 v3 Omni 最多支持 ${imageLimit} 张参考图`;
  }
  if (model === "seedance-2.0" || model === "seedance-2.0-fast") {
    if (counts.image > 9) return "Seedance 最多支持 9 张参考图";
    if (counts.video > 3) return "Seedance 最多支持 3 段参考视频";
    if (counts.audio > 3) return "Seedance 最多支持 3 段参考音频";
  }
  return null;
}

function keyframeCompatibilityError(assets: VideoReferenceAsset[]) {
  if (assets.some((asset) => asset.kind !== "image")) return "首尾帧模式只支持图片素材";
  if (assets.length > 2) return "首尾帧模式最多添加 2 张图片";
  const firstFrames = assets.filter((asset) => asset.role === "first_frame").length;
  const lastFrames = assets.filter((asset) => asset.role === "last_frame").length;
  if (firstFrames > 1 || lastFrames > 1) return "首帧和尾帧各只能添加 1 张图片";
  return null;
}

function omniAssetMetadataError(assets: VideoReferenceAsset[]) {
  for (const asset of assets) {
    if (asset.kind === "audio") return "可灵 Omni 不支持参考音频";
    if (asset.kind === "image") {
      if (asset.mimeType === "image/webp" || /\.webp$/i.test(asset.name)) return `${asset.name}：Omni 仅支持 JPG、JPEG 或 PNG`;
      if (asset.sizeBytes && asset.sizeBytes > 50 * 1024 * 1024) return `${asset.name}：图片不能超过 50MB`;
      if (asset.width && asset.height) {
        const ratio = asset.width / asset.height;
        if (asset.width < 300 || asset.height < 300) return `${asset.name}：图片宽高均不能小于 300px`;
        if (ratio < 0.4 || ratio > 2.5) return `${asset.name}：图片宽高比超出 Omni 范围`;
      }
    }
    if (asset.kind === "video") {
      if (asset.sizeBytes && asset.sizeBytes > 200 * 1024 * 1024) return `${asset.name}：视频不能超过 200MB`;
      if (asset.duration && (asset.duration < 3 || asset.duration > 15.5)) return `${asset.name}：视频时长必须在 3-15.5 秒之间`;
      if (asset.width && asset.height) {
        const ratio = asset.width / asset.height;
        if (asset.width < 700 || asset.height < 700 || asset.width > 4553 || asset.height > 4553) return `${asset.name}：视频宽高必须在 700-4553px 之间`;
        if (asset.width * asset.height > 8_294_400) return `${asset.name}：视频总像素超过 8294400`;
        if (ratio < 0.4 || ratio > 2) return `${asset.name}：视频宽高比必须在 0.4-2 之间`;
      }
    }
  }
  return null;
}

function formatVideoTime(seconds: number) {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds - minutes * 60;
  return `${minutes}:${remainder.toFixed(2).padStart(5, "0")}`;
}

function defaultShots(duration: number): ShotSegment[] {
  return [
    { index: 1, prompt: "", duration: Math.ceil(duration / 2) },
    { index: 2, prompt: "", duration: Math.floor(duration / 2) },
  ];
}

function ShotEditor({ data, nodeId }: { data: VideoNodeData; nodeId: string }) {
  const updateNode = useStudio((s) => s.updateNode);
  const shots = Array.isArray(data.shots) && data.shots.length ? data.shots : defaultShots(data.duration);
  const setShots = (next: ShotSegment[]) => updateNode(nodeId, { shots: next });
  const total = shots.reduce((sum, shot) => sum + shot.duration, 0);

  const updateShot = (index: number, patch: Partial<ShotSegment>) => {
    setShots(shots.map((shot, shotIndex) => shotIndex === index ? { ...shot, ...patch } : shot));
  };

  const removeShot = (index: number) => {
    setShots(shots.filter((_, shotIndex) => shotIndex !== index).map((shot, shotIndex) => ({ ...shot, index: shotIndex + 1 })));
  };

  return (
    <div className="mb-3 space-y-2 rounded-[12px] border border-line bg-ink/25 p-2.5">
      {shots.map((shot, index) => (
        <div key={index} className="flex items-start gap-2">
          <span className="mt-2 w-4 shrink-0 text-right text-[10px] text-fg-mute">{index + 1}</span>
          <textarea
            value={shot.prompt}
            onChange={(event) => updateShot(index, { prompt: event.target.value })}
            placeholder={`第 ${index + 1} 段提示词`}
            rows={2}
            className="nowheel min-h-[52px] flex-1 resize-y rounded-[9px] border border-line bg-panel-2/70 p-2 text-[11px] leading-relaxed text-fg outline-none placeholder:text-fg-mute focus:border-line-2"
          />
          <label className="flex w-12 shrink-0 flex-col items-center gap-1 text-[8px] text-fg-mute">
            <input
              type="number"
              min={1}
              max={data.duration}
              value={shot.duration}
              onChange={(event) => updateShot(index, { duration: Math.max(1, Number(event.target.value) || 1) })}
              className="h-7 w-full rounded-[8px] border border-line bg-panel-2/70 px-1 text-center text-[10px] text-fg outline-none focus:border-line-2"
            />
            秒
          </label>
          {shots.length > 1 ? (
            <button type="button" title="删除分镜" onClick={() => removeShot(index)} className="mt-1.5 text-fg-mute hover:text-danger">
              <Icon name="X" size={11} />
            </button>
          ) : null}
        </div>
      ))}
      <div className="flex items-center gap-2 pl-6">
        {shots.length < 6 ? (
          <button
            type="button"
            onClick={() => setShots([...shots, { index: shots.length + 1, prompt: "", duration: 1 }])}
            className="flex items-center gap-1 text-[10px] text-fg-mute hover:text-fg"
          >
            <Icon name="Plus" size={10} /> 添加分镜
          </button>
        ) : null}
        <span className={cn("ml-auto text-[10px]", total === data.duration ? "text-fg-mute" : "text-danger")}>
          {total}s / {data.duration}s{total === data.duration ? "" : " · 时长需一致"}
        </span>
      </div>
    </div>
  );
}

function VideoParamPopover({ data, nodeId, onClose }: { data: VideoNodeData; nodeId: string; onClose: () => void }) {
  const updateNode = useStudio((s) => s.updateNode);
  const set = (patch: Partial<VideoNodeData>) => updateNode(nodeId, patch);
  const durations = videoDurationsFor(data.model);
  const resolutions = VIDEO_MODEL_RESOLUTIONS[data.model];
  const ratios = allowedVideoAspectRatios(data.model);
  const seedance = isSeedanceModel(data.model);
  const omni = data.model === "v3-omni";
  const hasOmniVideo = Array.isArray(data.referenceAssets) && data.referenceAssets.some((asset) => asset.kind === "video");
  const selectedAudioMode: VideoAudioMode = data.audioMode ?? (data.keepOriginalSound ? "original" : data.sound ? "native" : "off");
  const audioModes: Array<{ value: VideoAudioMode; label: string }> = !hasOmniVideo
    ? [{ value: "off", label: "关闭音频" }, { value: "native", label: "生成原生音频" }]
    : data.referType === "base"
      ? [{ value: "off", label: "关闭音频" }, { value: "original", label: "保留原声" }]
      : [{ value: "off", label: "关闭音频" }];

  return (
    <div className="glass tf-node-popover popover-enter absolute bottom-full left-0 z-[80] mb-2 w-[340px] origin-bottom-left rounded-panel p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-[11px] font-medium text-fg">视频参数</div>
          <div className="mt-0.5 text-[9px] text-fg-mute">根据当前模型显示可用选项</div>
        </div>
        <button type="button" title="关闭参数" onClick={onClose} className="rounded p-1 text-fg-mute hover:bg-white/[0.06] hover:text-fg">
          <Icon name="X" size={12} />
        </button>
      </div>

      <div className="mb-1.5 text-[10px] font-medium tracking-wide text-fg-mute">分辨率</div>
      <div className="mb-3 flex gap-1.5">
        {resolutions.map((resolution) => (
          <Chip key={resolution} active={data.mode === resolution} onClick={() => set({ mode: resolution as VideoResolution })}>
            {resolution}
          </Chip>
        ))}
      </div>

      <div className="mb-1.5 text-[10px] font-medium tracking-wide text-fg-mute">时长</div>
      <div className="nowheel mb-3 flex max-h-[86px] flex-wrap gap-1.5 overflow-y-auto">
        {durations.map((duration) => (
          <Chip key={duration} active={data.duration === duration} onClick={() => set({ duration })}>
            {duration}s
          </Chip>
        ))}
      </div>

      {ratios.length ? (
        <>
          <div className="mb-1.5 text-[10px] font-medium tracking-wide text-fg-mute">
            画面比例 <span className="font-normal text-fg-mute/65">· {seedance ? "Seedance" : "可灵 Omni"} 专属范围</span>
          </div>
          <div className="mb-3 grid grid-cols-3 gap-1.5">
            {ratios.map((ratio) => (
              <button
                key={ratio}
                type="button"
                onClick={() => set({ aspectRatio: ratio as VideoAspectRatio })}
                className={cn(
                  "h-8 rounded-control border text-[10px] transition-colors",
                  data.aspectRatio === ratio
                    ? "border-accent/55 bg-accent/10 text-accent"
                    : "border-line bg-white/[0.02] text-fg-dim hover:border-line-2 hover:text-fg",
                )}
              >
                {ratio}
              </button>
            ))}
          </div>
        </>
      ) : null}

      <div className="flex flex-wrap gap-1.5 border-t border-line pt-3">
        {omni ? audioModes.map((mode) => (
          <Chip
            key={mode.value}
            active={selectedAudioMode === mode.value}
            onClick={() => set({
              audioMode: mode.value,
              sound: mode.value === "native",
              keepOriginalSound: mode.value === "original",
            })}
          >
            <Icon name="MusicNotes" size={11} /> {mode.label}
          </Chip>
        )) : (
          <Chip active={data.sound} onClick={() => set({ sound: !data.sound })}>
            <Icon name="MusicNotes" size={11} /> 生成音效
          </Chip>
        )}
        {seedance ? (
          <>
            <Chip active={data.webSearch === true} onClick={() => set({ webSearch: data.webSearch !== true })}>
              <Icon name="Globe" size={11} /> 联网搜索
            </Chip>
            <Chip active={data.cameraFixed === true} onClick={() => set({ cameraFixed: data.cameraFixed !== true })}>
              <Icon name="VideoCamera" size={11} /> 固定镜头
            </Chip>
            <input
              type="text"
              inputMode="numeric"
              value={data.seedText ?? ""}
              onChange={(event) => set({ seedText: event.target.value.replace(/[^\d]/g, "").slice(0, 10) })}
              placeholder="随机种子"
              title="相同种子和参数可复现相近效果；留空则随机"
              className="h-7 w-[86px] rounded-full border border-line bg-panel-2/80 px-2.5 text-center text-[9px] text-fg outline-none placeholder:text-fg-mute focus:border-line-2"
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

export const VideoNode = memo(function VideoNode({ id, selected, dragging, data }: NodeProps<AppNode>) {
  const d = data as VideoNodeData;
  const updateNode = useStudio((s) => s.updateNode);
  const generateVideo = useStudio((s) => s.generateVideo);
  const addNode = useStudio((s) => s.addNode);
  const showToast = useStudio((s) => s.showToast);
  const nodes = useStudio((s) => s.nodes);
  const referenceFileRef = useRef<HTMLInputElement>(null);
  const primaryVideoRef = useRef<HTMLVideoElement>(null);
  const revivedLocalKeysRef = useRef(new Set<string>());
  const modelAreaRef = useRef<HTMLDivElement>(null);
  const paramAreaRef = useRef<HTMLDivElement>(null);
  const [popover, setPopover] = useState<"none" | "params" | "model">("none");
  const [composerOpen, setComposerOpen] = useState(false);
  const [frameExtractorOpen, setFrameExtractorOpen] = useState(false);
  const [fileDragActive, setFileDragActive] = useState(false);
  const [requestedFrameRole, setRequestedFrameRole] = useState<VideoFrameRole | null>(null);
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoCurrentTime, setVideoCurrentTime] = useState(0);
  const [extractingFrame, setExtractingFrame] = useState(false);
  const selectionModifierPressed = useKeyPress(["Control", "Meta", "Shift"]);
  const multipleNodesSelected = nodes.reduce((count, node) => count + (node.selected ? 1 : 0), 0) > 1;
  const rf = useReactFlow();

  const sourceVideo = d.sourceVideo;
  const isGeneratedResult = d.isGeneratedResult === true;
  const referenceAssets = Array.isArray(d.referenceAssets) ? d.referenceAssets : [];
  const keyframeAssets = Array.isArray(d.keyframeAssets) ? d.keyframeAssets : [];
  const inputMode: VideoInputMode = d.inputMode === "keyframes" ? "keyframes" : "references";
  const activeAssets = inputMode === "keyframes" ? keyframeAssets : referenceAssets;
  const referenceCounts = countReferences(referenceAssets);
  const firstFrame = keyframeAssets.find((asset) => asset.role === "first_frame");
  const lastFrame = keyframeAssets.find((asset) => asset.role === "last_frame");
  const previewImage = inputMode === "keyframes"
    ? firstFrame?.localUrl ?? firstFrame?.url ?? null
    : (() => {
        const image = referenceAssets.find((asset) => asset.kind === "image");
        return image?.localUrl ?? image?.url ?? null;
      })();
  const playbackUrl = d.url ?? sourceVideo?.localUrl ?? sourceVideo?.url ?? null;
  const billingSummary = Array.isArray(d.billing)
    ? d.billing.map((entry) => entry.amount ? `${entry.amount}${entry.charge_type === "unit" ? " 单位" : ""}` : "").filter(Boolean).join(" + ")
    : "";
  const shotsEnabled = d.shotsEnabled === true && supportsShots(d.model);
  const shots = Array.isArray(d.shots) && d.shots.length ? d.shots : defaultShots(d.duration);
  const hasPrompt = shotsEnabled ? shots.every((shot) => Boolean(shot.prompt.trim())) : Boolean(d.prompt.trim());
  const running = d.status === "running";
  const needsFrame = d.model === "v3" || d.model === "v2-6";
  const modelInfo = VIDEO_MODELS.find((model) => model.value === d.model);
  const compatibilityError = inputMode === "keyframes"
    ? keyframeCompatibilityError(keyframeAssets)
    : referenceCompatibilityError(d.model, referenceAssets);
  const shotTotal = shots.reduce((sum, shot) => sum + shot.duration, 0);
  const omniAudioMode: VideoAudioMode = d.audioMode ?? (d.keepOriginalSound ? "original" : d.sound ? "native" : "off");
  const omniImageLimit = referenceCounts.video ? 4 : 7;
  const omniMetadataError = d.model === "v3-omni" ? omniAssetMetadataError([...keyframeAssets, ...referenceAssets]) : null;
  const omniCompatibilityError = d.model !== "v3-omni"
    ? null
    : omniMetadataError
      ? omniMetadataError
      : referenceCounts.audio
      ? "可灵 Omni 不支持参考音频"
      : referenceCounts.video > 1
        ? "可灵 Omni 最多支持 1 段参考视频"
        : referenceCounts.image + keyframeAssets.length > omniImageLimit
          ? `当前组合最多支持 ${omniImageLimit} 张图片`
          : lastFrame && !firstFrame
            ? "可灵 Omni 不支持仅尾帧，请先添加首帧"
            : referenceCounts.video > 0 && d.referType === "base" && keyframeAssets.length > 0
              ? "视频编辑（base）模式不支持首尾帧"
              : referenceCounts.video > 0 && d.referType === "base" && shotsEnabled
                ? "视频编辑（base）模式不支持分镜"
                : referenceCounts.video > 0 && d.referType !== "base" && omniAudioMode !== "off"
                  ? "视频参考（feature）模式必须关闭音频"
                  : referenceCounts.video > 0 && d.referType === "base" && omniAudioMode === "native"
                    ? "视频编辑（base）模式只能关闭音频或保留原声"
                    : (!referenceCounts.video || d.referType !== "base") && omniAudioMode === "original"
                      ? "只有视频编辑（base）模式可以保留原声"
                      : !firstFrame && !referenceCounts.video && d.aspectRatio === "智能"
                        ? "没有首帧或参考视频时必须选择画面比例"
                        : null;
  const generationError = shotsEnabled && shotTotal !== d.duration
    ? `分镜总时长 ${shotTotal}s 必须等于视频时长 ${d.duration}s`
    : shotsEnabled && d.model === "v3-omni" && shots.some((shot) => shot.prompt.length > 512)
      ? "每段分镜提示词不能超过 512 字符"
      : d.model === "v3-omni" && !shotsEnabled && d.prompt.length > 3072
        ? "可灵 Omni 提示词不能超过 3072 字符"
        : omniCompatibilityError
          ? omniCompatibilityError
      : inputMode === "references" && isSeedanceModel(d.model) && referenceCounts.audio > 0 && !referenceCounts.image && !referenceCounts.video
        ? "参考音频不能单独使用，请同时添加图片或视频"
        : hasPrompt && inputMode === "keyframes" && needsFrame && !firstFrame
    ? "请添加首帧图片"
    : hasPrompt && inputMode === "references" && needsFrame && !referenceCounts.image
      ? "该旧模型需要至少一张参考图作为首帧"
      : compatibilityError;
  const sendDisabled = running || !hasPrompt || Boolean(generationError);
  const nodeWidth = d.width || 430;
  const nodeHeight = d.height || 280;
  const referenceAccept = d.model === "v3-omni"
    ? inputMode === "keyframes" ? KLING_OMNI_KEYFRAME_ACCEPT : KLING_OMNI_REFERENCE_ACCEPT
    : inputMode === "keyframes" ? VIDEO_KEYFRAME_ACCEPT : VIDEO_REFERENCE_ACCEPT;

  const uploadReferenceFiles = async (files: File[] | FileList) => {
    if (running || isGeneratedResult) return;
    const parsedCandidates = Array.from(files)
      .map((file) => ({ file, kind: referenceKind(file) }))
      .filter((item): item is { file: File; kind: VideoReferenceKind } => Boolean(item.kind));
    if (inputMode === "keyframes" && parsedCandidates.some((item) => item.kind !== "image")) {
      showToast(`首尾帧模式只能添加 ${d.model === "v3-omni" ? "PNG 或 JPG" : "PNG、JPG 或 WebP"} 图片`, "error");
      return;
    }
    const candidates = inputMode === "keyframes"
      ? parsedCandidates.filter((item): item is { file: File; kind: "image" } => item.kind === "image")
      : parsedCandidates;
    if (!candidates.length) {
      showToast(inputMode === "keyframes"
        ? `请选择 ${d.model === "v3-omni" ? "PNG 或 JPG" : "PNG、JPG 或 WebP"} 图片`
        : d.model === "v3-omni" ? "请选择 PNG/JPG 图片或 MP4/MOV 视频" : "请选择 PNG/JPG/WebP、MP4/MOV 或 WAV/MP3 素材", "error");
      return;
    }

    const metadataByFile = new Map<File, Awaited<ReturnType<typeof inspectReferenceFile>>>();
    try {
      await Promise.all(candidates.map(async ({ file, kind }) => {
        metadataByFile.set(file, await inspectReferenceFile(file, kind, d.model));
      }));
    } catch (error) {
      showToast(error instanceof Error ? error.message : "素材信息校验失败", "error");
      return;
    }

    const availableRoles = (["first_frame", "last_frame"] as VideoFrameRole[])
      .filter((role) => !keyframeAssets.some((asset) => asset.role === role));
    if (requestedFrameRole && availableRoles.includes(requestedFrameRole)) {
      availableRoles.splice(availableRoles.indexOf(requestedFrameRole), 1);
      availableRoles.unshift(requestedFrameRole);
    }
    if (inputMode === "keyframes" && candidates.length > availableRoles.length) {
      showToast(`首尾帧模式还可添加 ${availableRoles.length} 张图片`, "error");
      return;
    }

    const proposed = [
      ...activeAssets,
      ...candidates.map(({ file, kind }, index) => ({
        id: `pending-${index}`,
        kind,
        name: file.name,
        url: "https://pending.invalid",
        role: inputMode === "keyframes" ? availableRoles[index] : undefined,
        ...metadataByFile.get(file),
      } satisfies VideoReferenceAsset)),
    ];
    const limitError = inputMode === "keyframes"
      ? keyframeCompatibilityError(proposed)
      : referenceCompatibilityError(d.model, proposed);
    if (limitError) {
      showToast(limitError, "error");
      return;
    }
    if (d.model === "v3-omni") {
      const proposedReferences = inputMode === "references" ? proposed : referenceAssets;
      const proposedKeyframes = inputMode === "keyframes" ? proposed : keyframeAssets;
      const counts = countReferences(proposedReferences);
      const imageTotal = counts.image + proposedKeyframes.length;
      const imageLimit = counts.video ? 4 : 7;
      if (counts.video > 1 || imageTotal > imageLimit) {
        showToast(`当前 Omni 素材组合最多支持 1 段视频和 ${imageLimit} 张图片`, "error");
        return;
      }
      if (counts.video && d.referType === "base" && proposedKeyframes.length) {
        showToast("视频编辑（base）模式不能与首尾帧同时使用", "error");
        return;
      }
    }

    setFileDragActive(false);
    const assetField = inputMode === "keyframes" ? "keyframeAssets" : "referenceAssets";
    const addedAssets = candidates.map(({ file, kind }, index) => {
      const assetId = `video-ref-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const localUrl = URL.createObjectURL(file);
      revivedLocalKeysRef.current.add(assetId);
      void rememberVideoReferenceBlob(assetId, file).catch(() => {
        showToast(`${file.name} 本地保存失败，刷新页面后需要重新添加`, "error");
      });
      if (kind === "video") {
        void createVideoFirstFrame(file).then((previewUrl) => {
          if (!previewUrl) return;
          const current = useStudio.getState().nodes.find((node) => node.id === id)?.data as VideoNodeData | undefined;
          const currentAssets = Array.isArray(current?.[assetField]) ? current[assetField] : [];
          updateNode(id, {
            [assetField]: currentAssets.map((asset) => asset.id === assetId ? { ...asset, previewUrl } : asset),
          });
        });
      }
      return {
        id: assetId,
        kind,
        name: file.name,
        localKey: assetId,
        localUrl,
        role: inputMode === "keyframes" ? availableRoles[index] : undefined,
        ...metadataByFile.get(file),
      } satisfies VideoReferenceAsset;
    });
    const current = useStudio.getState().nodes.find((node) => node.id === id)?.data as VideoNodeData | undefined;
    const currentAssets = Array.isArray(current?.[assetField]) ? current[assetField] : [];
    updateNode(id, {
      [assetField]: [...currentAssets, ...addedAssets],
      ...(d.model === "v3-omni" && addedAssets.some((asset) => asset.kind === "video")
        ? { audioMode: "off", sound: false, keepOriginalSound: false }
        : {}),
    });
    setRequestedFrameRole(null);
    setComposerOpen(true);
    showToast(inputMode === "keyframes" ? `已添加 ${addedAssets.length} 张帧图片` : `已添加 ${addedAssets.length} 个参考素材`, "success");
  };

  const removeReferenceAsset = (assetId: string) => {
    const assetField = inputMode === "keyframes" ? "keyframeAssets" : "referenceAssets";
    const asset = activeAssets.find((item) => item.id === assetId);
    if (asset?.localUrl?.startsWith("blob:")) URL.revokeObjectURL(asset.localUrl);
    if (asset?.localKey) void forgetVideoReferenceBlob(asset.localKey);
    revivedLocalKeysRef.current.delete(asset?.localKey ?? assetId);
    updateNode(id, { [assetField]: activeAssets.filter((asset) => asset.id !== assetId) });
  };

  useEffect(() => {
    let cancelled = false;
    const reviveCollection = async (
      assetField: "referenceAssets" | "keyframeAssets",
      assets: VideoReferenceAsset[],
    ) => {
      const pending = assets.filter((asset) => asset.localKey && !revivedLocalKeysRef.current.has(asset.localKey));
      if (!pending.length) return;
      for (const asset of pending) revivedLocalKeysRef.current.add(asset.localKey!);
      const replacements = new Map<string, string>();
      await Promise.all(pending.map(async (asset) => {
        const blob = await readVideoReferenceBlob(asset.localKey!);
        if (blob) replacements.set(asset.id, URL.createObjectURL(blob));
      }));
      if (cancelled || !replacements.size) {
        for (const localUrl of replacements.values()) URL.revokeObjectURL(localUrl);
        return;
      }
      const current = useStudio.getState().nodes.find((node) => node.id === id)?.data as VideoNodeData | undefined;
      const currentAssets = Array.isArray(current?.[assetField]) ? current[assetField] : [];
      updateNode(id, {
        [assetField]: currentAssets.map((asset) => {
          const localUrl = replacements.get(asset.id);
          return localUrl ? { ...asset, localUrl } : asset;
        }),
      });
    };
    void reviveCollection("referenceAssets", referenceAssets);
    void reviveCollection("keyframeAssets", keyframeAssets);
    const reviveSourceVideo = async () => {
      if (!sourceVideo?.localKey || revivedLocalKeysRef.current.has(sourceVideo.localKey)) return;
      revivedLocalKeysRef.current.add(sourceVideo.localKey);
      const blob = await readVideoReferenceBlob(sourceVideo.localKey);
      if (!blob) return;
      const localUrl = URL.createObjectURL(blob);
      if (cancelled) {
        URL.revokeObjectURL(localUrl);
        return;
      }
      const current = useStudio.getState().nodes.find((node) => node.id === id)?.data as VideoNodeData | undefined;
      if (!current?.sourceVideo || current.sourceVideo.id !== sourceVideo.id) {
        URL.revokeObjectURL(localUrl);
        return;
      }
      if (current.sourceVideo.localUrl?.startsWith("blob:")) URL.revokeObjectURL(current.sourceVideo.localUrl);
      updateNode(id, { sourceVideo: { ...current.sourceVideo, localUrl } });
    };
    void reviveSourceVideo();
    return () => {
      cancelled = true;
    };
  }, [id, keyframeAssets, referenceAssets, sourceVideo, updateNode]);

  useEffect(() => {
    if (popover === "none") return;
    const activeArea = popover === "model" ? modelAreaRef.current : paramAreaRef.current;
    const onPointerDown = (event: MouseEvent) => {
      if (activeArea?.contains(event.target as Node)) return;
      setPopover("none");
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPopover("none");
    };
    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [popover]);

  useEffect(() => {
    if (!selected || dragging || multipleNodesSelected) {
      setPopover("none");
      setComposerOpen(false);
      setFrameExtractorOpen(false);
    }
  }, [dragging, multipleNodesSelected, selected]);

  useEffect(() => {
    setVideoDuration(0);
    setVideoCurrentTime(0);
  }, [playbackUrl]);

  const seekVideo = useCallback((seconds: number) => {
    const video = primaryVideoRef.current;
    if (!video || !Number.isFinite(video.duration)) return;
    const nextTime = Math.min(Math.max(0, seconds), Math.max(0, video.duration - 0.001));
    video.currentTime = nextTime;
    setVideoCurrentTime(nextTime);
  }, []);

  const extractCurrentFrame = useCallback(() => {
    const video = primaryVideoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight || video.readyState < 2) {
      showToast("视频画面尚未加载完成", "error");
      return;
    }
    setExtractingFrame(true);
    try {
      const scale = Math.min(1, 2048 / video.videoWidth, 2048 / video.videoHeight);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法创建画面提取画布");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const frameUrl = canvas.toDataURL("image/png");
      const sourceNode = rf.getNode(id);
      const absolutePosition = rf.getInternalNode(id)?.internals.positionAbsolute ?? sourceNode?.position ?? { x: 0, y: 0 };
      addNode("image", { x: absolutePosition.x + nodeWidth + 80, y: absolutePosition.y }, {
        label: `${d.label} · ${formatVideoTime(video.currentTime)}`,
        url: frameUrl,
        urls: [frameUrl],
      });
      showToast(`已提取 ${formatVideoTime(video.currentTime)} 画面`, "success");
    } catch {
      showToast("当前视频无法提取画面，请确认视频可正常播放", "error");
    } finally {
      setExtractingFrame(false);
    }
  }, [addNode, d.label, id, nodeWidth, rf, showToast]);

  const clearSourceVideo = useCallback(() => {
    if (sourceVideo?.localUrl?.startsWith("blob:")) URL.revokeObjectURL(sourceVideo.localUrl);
    if (sourceVideo?.localKey) void forgetVideoReferenceBlob(sourceVideo.localKey);
    revivedLocalKeysRef.current.delete(sourceVideo?.localKey ?? sourceVideo?.id ?? "");
    updateNode(id, { sourceVideo: undefined });
    setFrameExtractorOpen(false);
  }, [id, sourceVideo, updateNode]);

  const videoToolbar = playbackUrl ? (
    <div className="flex w-max items-center gap-1 rounded-full border border-line bg-panel/95 p-1.5 shadow-[0_12px_34px_rgba(0,0,0,0.38)] backdrop-blur-xl">
      <button
        type="button"
        onClick={() => {
          setFrameExtractorOpen((open) => !open);
          setComposerOpen(false);
        }}
        className={cn(
          "flex h-8 items-center gap-1.5 rounded-full px-3 text-[11px] transition-colors hover:bg-white/[0.07] hover:text-fg",
          frameExtractorOpen ? "bg-white/[0.09] text-fg" : "text-fg-dim",
        )}
      >
        <Icon name="Image" size={12} />
        提取帧
      </button>
    </div>
  ) : undefined;

  return (
    <NodeShell
      id={id}
      selected={selected}
      label={d.label}
      icon="FilmSlate"
      width={nodeWidth}
      height={nodeHeight}
      running={running}
      frameless
      portTop={nodeHeight / 2}
      resizeHandleTop={Math.max(8, nodeHeight - 32)}
      onResizeBegin={() => {
        setComposerOpen(false);
        setFrameExtractorOpen(false);
      }}
      toolbar={selected && !multipleNodesSelected && playbackUrl && !running ? videoToolbar : undefined}
      showDuplicateAction={!isGeneratedResult && !sourceVideo?.localKey}
    >
      <div
        data-body
        style={{ height: nodeHeight }}
        className={cn(
          "relative flex min-h-[240px] cursor-pointer items-center justify-center overflow-hidden rounded-[12px] border bg-panel transition-[border-color,box-shadow] duration-200",
          fileDragActive
            ? "scale-[1.008] cursor-copy border-white/55 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12),0_18px_50px_rgba(0,0,0,0.38)]"
            : selected
              ? "border-white/30 shadow-[0_18px_50px_rgba(0,0,0,0.3)]"
              : "border-line hover:border-line-2",
        )}
        onDragEnter={(event) => {
          if (!event.dataTransfer.types.includes("Files") || running || isGeneratedResult) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "copy";
          setFileDragActive(true);
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes("Files") || running || isGeneratedResult) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "copy";
          setFileDragActive(true);
        }}
        onDragLeave={(event) => {
          const nextTarget = event.relatedTarget as globalThis.Node | null;
          if (!nextTarget || !event.currentTarget.contains(nextTarget)) setFileDragActive(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setFileDragActive(false);
          void uploadReferenceFiles(event.dataTransfer.files);
        }}
        onClick={(event) => {
          if (isGeneratedResult || selectionModifierPressed || isMultiSelectClick(event) || dragging) return;
          const target = event.target as HTMLElement;
          if (target.closest("button, video, input")) return;
          setFrameExtractorOpen(false);
          setComposerOpen(true);
        }}
      >
        <input
          ref={referenceFileRef}
          type="file"
          accept={referenceAccept}
          multiple
          className="hidden"
          aria-label={inputMode === "keyframes" ? "选择视频首尾帧图片" : "选择视频参考素材"}
          onChange={(event) => {
            if (event.target.files?.length) void uploadReferenceFiles(event.target.files);
            event.currentTarget.value = "";
          }}
        />

        {fileDragActive ? (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-ink/78 backdrop-blur-[3px]">
            <div className="tf-drop-target-enter flex flex-col items-center text-center">
              <span className="tf-drop-target-pulse mb-3 flex h-12 w-12 items-center justify-center rounded-full border border-white/30 bg-white/[0.08] text-fg">
                <Icon name="UploadSimple" size={21} weight="bold" />
              </span>
              <span className="text-[13px] font-medium text-fg">
                {inputMode === "keyframes" ? "松开以添加首尾帧" : "松开以添加多模态参考"}
              </span>
              <span className="mt-1 text-[9px] uppercase tracking-[0.12em] text-fg-mute">
                {inputMode === "keyframes" ? "FIRST FRAME · LAST FRAME" : "IMAGE · VIDEO · AUDIO"}
              </span>
            </div>
          </div>
        ) : null}

        {playbackUrl ? (
          <video
            ref={primaryVideoRef}
            src={playbackUrl}
            controls
            playsInline
            preload="metadata"
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              setVideoDuration(Number.isFinite(video.duration) ? video.duration : 0);
              setVideoCurrentTime(video.currentTime || 0);
            }}
            onDurationChange={(event) => {
              const duration = event.currentTarget.duration;
              if (Number.isFinite(duration)) setVideoDuration(duration);
            }}
            onTimeUpdate={(event) => setVideoCurrentTime(event.currentTarget.currentTime)}
            className="h-full w-full bg-black object-contain"
          />
        ) : previewImage ? (
          <>
            <img src={previewImage} alt="视频参考图" className="h-full w-full object-contain opacity-70" draggable={false} />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-ink/55 via-transparent to-transparent" />
            <div className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-1.5 rounded-full border border-white/14 bg-ink/78 px-2.5 py-1.5 text-[10px] text-fg-dim backdrop-blur-md">
              <Icon name={inputMode === "keyframes" ? "Image" : "Paperclip"} size={11} className="text-accent" />
              {inputMode === "keyframes" ? `首尾帧 ${keyframeAssets.length}/2` : `参考素材 ${referenceAssets.length}`}
            </div>
          </>
        ) : isGeneratedResult ? (
          <div className="flex flex-col items-center gap-2 px-8 py-10 text-center text-fg-dim">
            <span className="flex h-12 w-12 items-center justify-center rounded-full border border-white/10 bg-white/[0.04]">
              <Icon name="VideoCamera" size={22} />
            </span>
            <span className="text-[12px]">{d.status === "failed" ? "视频生成失败" : "等待视频结果"}</span>
            <span className="text-[9px] text-fg-mute">生成进度与成片会保留在此节点</span>
          </div>
        ) : activeAssets.length ? (
          <div className="flex flex-col items-center gap-2 text-center text-fg-dim">
            <span className="flex h-12 w-12 items-center justify-center rounded-full border border-white/10 bg-white/[0.04]">
              <Icon name={inputMode === "keyframes" ? "Image" : referenceCounts.video ? "VideoCamera" : "MusicNotes"} size={22} />
            </span>
            <span className="text-[12px]">
              {inputMode === "keyframes" ? `已添加 ${keyframeAssets.length} 张帧图片` : `已添加 ${referenceAssets.length} 个参考素材`}
            </span>
            <span className="text-[9px] text-fg-mute">点击查看和管理</span>
          </div>
        ) : (
          <div className="flex flex-col gap-2 px-8 py-10 text-center text-[12px] text-fg-mute">
            <span className="mb-1 flex h-11 w-11 items-center justify-center self-center rounded-full border border-white/10 bg-white/[0.035]">
              <Icon name="FilmSlate" size={22} className="text-fg-mute/70" />
            </span>
            <span className="text-fg-dim">点击配置视频生成</span>
            <span className="text-[10px] text-fg-mute/70">
              {inputMode === "keyframes"
                ? "可直接拖入首帧和尾帧图片"
                : d.model === "v3-omni" ? "可直接拖入 JPG/PNG 图片或 MP4/MOV 视频" : "可直接拖入图片、视频或音频作为参考"}
            </span>
          </div>
        )}

        {running ? <RunningVeil progress={d.progress} label="视频生成中，通常需要几分钟…" /> : null}

        {d.status === "failed" && d.error ? (
          <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-danger/15 px-3 py-1.5 text-[11px] text-danger backdrop-blur">
            <Icon name="Warning" size={12} className="shrink-0" />
            <span className="truncate" title={d.error}>{d.error}</span>
          </div>
        ) : null}

        {isGeneratedResult && playbackUrl && !running && (d.outputDuration || billingSummary || d.requestId) ? (
          <div
            className="pointer-events-none absolute bottom-2 left-2 flex max-w-[calc(100%-16px)] items-center gap-1.5 rounded-full border border-white/10 bg-ink/72 px-2.5 py-1 text-[9px] text-fg-dim backdrop-blur"
            title={d.requestId ? `请求 ID：${d.requestId}` : undefined}
          >
            {d.outputDuration ? <span>{d.outputDuration}s</span> : null}
            {d.outputDuration && billingSummary ? <span className="text-fg-mute/60">·</span> : null}
            {billingSummary ? <span>消耗 {billingSummary}</span> : null}
            {!d.outputDuration && !billingSummary && d.requestId ? <span>任务信息已记录</span> : null}
          </div>
        ) : null}

        {sourceVideo && !running && !isGeneratedResult ? (
          <div className="nodrag absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover/node:opacity-100">
            <button
              type="button"
              title="下载导入视频"
              onClick={(event) => {
                event.stopPropagation();
                if (playbackUrl) downloadUrl(playbackUrl, sourceVideo.name || `tfvision-${Date.now()}.mp4`);
              }}
              className="rounded-full border border-white/10 bg-ink/75 p-2 text-fg-dim backdrop-blur hover:text-fg"
            >
              <Icon name="Download" size={14} />
            </button>
            <button
              type="button"
              title="移除导入视频"
              onClick={(event) => {
                event.stopPropagation();
                clearSourceVideo();
              }}
              className="rounded-full border border-white/10 bg-ink/75 p-2 text-fg-dim backdrop-blur hover:text-danger"
            >
              <Icon name="X" size={14} />
            </button>
          </div>
        ) : null}
      </div>

      {frameExtractorOpen && selected && !dragging && !multipleNodesSelected && playbackUrl ? (
        <div
          role="dialog"
          aria-label="视频提取帧"
          className="relative left-1/2 z-[40] mt-3 w-[calc(100%+120px)] -translate-x-1/2 rounded-[16px] border border-line bg-card p-3.5 shadow-[0_18px_50px_rgba(0,0,0,0.3)] nodrag"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="mb-3 flex items-center justify-between">
            <div>
              <div className="text-[11px] font-medium text-fg">提取视频帧</div>
              <div className="mt-0.5 text-[9px] text-fg-mute">定位时间后，将当前画面创建为图片节点</div>
            </div>
            <button
              type="button"
              title="关闭提取帧"
              onClick={() => setFrameExtractorOpen(false)}
              className="rounded p-1 text-fg-mute hover:bg-white/[0.06] hover:text-fg"
            >
              <Icon name="X" size={12} />
            </button>
          </div>

          <div className="mb-2 flex items-center gap-3">
            <span className="w-[46px] shrink-0 text-[10px] tabular-nums text-fg-dim">{formatVideoTime(videoCurrentTime)}</span>
            <input
              type="range"
              min={0}
              max={Math.max(0.01, videoDuration)}
              step={0.01}
              value={Math.min(videoCurrentTime, Math.max(0.01, videoDuration))}
              disabled={!videoDuration}
              onChange={(event) => seekVideo(Number(event.target.value))}
              aria-label="视频帧时间轴"
              className="h-1.5 min-w-0 flex-1 cursor-pointer accent-white disabled:cursor-not-allowed disabled:opacity-35"
            />
            <span className="w-[46px] shrink-0 text-right text-[10px] tabular-nums text-fg-mute">{formatVideoTime(videoDuration)}</span>
          </div>

          <div className="flex items-center gap-1.5 border-t border-line pt-3">
            <Chip onClick={() => seekVideo(0)}>首帧</Chip>
            <Chip onClick={() => seekVideo(videoDuration / 2)}>中间帧</Chip>
            <Chip onClick={() => seekVideo(Math.max(0, videoDuration - 0.04))}>尾帧</Chip>
            <button
              type="button"
              disabled={!videoDuration || extractingFrame}
              onClick={extractCurrentFrame}
              className="ml-auto flex h-8 items-center gap-1.5 rounded-full bg-accent px-3.5 text-[11px] font-medium text-ink transition-colors hover:bg-accent-2 disabled:pointer-events-none disabled:opacity-35"
            >
              {extractingFrame ? <Spinner size={12} /> : <Icon name="Image" size={12} />}
              提取当前帧
            </button>
          </div>
        </div>
      ) : null}

      {!isGeneratedResult && composerOpen && selected && !dragging && !multipleNodesSelected ? (
        <div
          role="dialog"
          aria-label="视频生成设置"
          className="relative left-1/2 z-[40] mt-3 w-[calc(100%+192px)] -translate-x-1/2 rounded-[18px] border border-line bg-card p-3.5 shadow-[0_18px_50px_rgba(0,0,0,0.24)] nodrag"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="inline-flex rounded-full border border-line bg-ink/35 p-0.5" role="group" aria-label="视频参考模式">
              {([
                { value: "references", label: "多模态参考", icon: "Paperclip" },
                { value: "keyframes", label: "首尾帧", icon: "Image" },
              ] as const).map((mode) => (
                <button
                  key={mode.value}
                  type="button"
                  disabled={running}
                  onClick={() => updateNode(id, { inputMode: mode.value })}
                  className={cn(
                    "flex h-7 items-center gap-1.5 rounded-full px-3 text-[10px] transition-[background-color,color,box-shadow] disabled:pointer-events-none disabled:opacity-40",
                    inputMode === mode.value
                      ? "bg-white/[0.11] text-fg shadow-[0_2px_8px_rgba(0,0,0,0.22)]"
                      : "text-fg-mute hover:text-fg-dim",
                  )}
                >
                  <Icon name={mode.icon} size={11} />
                  {mode.label}
                </button>
              ))}
            </div>
            <span className="text-[9px] text-fg-mute">
              {inputMode === "keyframes"
                ? needsFrame ? "首帧必填 · 尾帧可选" : "可与参考素材组合 · 尾帧需搭配首帧"
                : d.model === "v3-omni" ? "可与首尾帧组合 · JPG/PNG · MP4/MOV" : "支持图片、视频与音频"}
            </span>
          </div>

          <div className="mb-3 flex items-center gap-1.5">
            {inputMode === "keyframes" ? (
              <>
                <Chip title="首帧图片状态">
                  <span className={cn("h-1.5 w-1.5 rounded-full", firstFrame ? "bg-[#70d69f]" : "bg-fg-mute/50")} />
                  首帧 {firstFrame ? "已添加" : "未添加"}
                </Chip>
                <Chip title="尾帧图片状态">
                  <span className={cn("h-1.5 w-1.5 rounded-full", lastFrame ? "bg-[#70d69f]" : "bg-fg-mute/50")} />
                  尾帧 {lastFrame ? "已添加" : "未添加"}
                </Chip>
              </>
            ) : (
              <>
                <Chip title="参考图片数量">
                  <Icon name="Image" size={11} />
                  图片 {referenceCounts.image}
                </Chip>
                <Chip title="参考视频数量">
                  <Icon name="VideoCamera" size={11} />
                  视频 {referenceCounts.video}
                </Chip>
                <Chip title="参考音频数量">
                  <Icon name="MusicNotes" size={11} />
                  音频 {referenceCounts.audio}
                </Chip>
              </>
            )}
            <button
              type="button"
              disabled={running || (inputMode === "keyframes" && keyframeAssets.length >= 2)}
              onClick={() => {
                setRequestedFrameRole(null);
                referenceFileRef.current?.click();
              }}
              className="ml-auto flex h-7 items-center gap-1.5 rounded-full border border-line bg-white/[0.03] px-2.5 text-[10px] text-fg-dim transition-colors hover:border-line-2 hover:text-fg disabled:pointer-events-none disabled:opacity-40"
            >
              <Icon name="Plus" size={11} weight="bold" />
              {inputMode === "keyframes" ? "添加帧图片" : "添加参考素材"}
            </button>
          </div>

          {inputMode === "keyframes" ? (
            <div className="mb-3 flex items-center justify-center gap-3 rounded-[12px] border border-line bg-ink/30 p-2.5">
              {([
                { role: "first_frame", label: "首帧", hint: needsFrame ? "必填" : "可选" },
                { role: "last_frame", label: "尾帧", hint: "可选" },
              ] as const).map((slot, index) => {
                const asset = keyframeAssets.find((item) => item.role === slot.role);
                return (
                  <div key={slot.role} className="contents">
                    {index ? <span className="shrink-0 text-[15px] text-fg-mute/55">→</span> : null}
                    <div className="group/reference relative h-[104px] w-[104px] shrink-0 overflow-hidden rounded-[10px] border border-white/10 bg-ink">
                      {asset ? (
                        <img src={asset.localUrl ?? asset.url} alt={`${slot.label} ${asset.name}`} className="h-full w-full object-contain" draggable={false} />
                      ) : (
                        <button
                          type="button"
                          disabled={running || (slot.role === "last_frame" && !firstFrame)}
                          onClick={() => {
                            setRequestedFrameRole(slot.role);
                            referenceFileRef.current?.click();
                          }}
                          className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-fg-mute transition-colors hover:bg-white/[0.035] hover:text-fg-dim disabled:pointer-events-none disabled:opacity-40"
                        >
                          <Icon name="Plus" size={14} />
                          <span className="text-[9px]">添加{slot.label}</span>
                        </button>
                      )}
                      <span className="pointer-events-none absolute bottom-1.5 left-1.5 rounded-full border border-white/10 bg-ink/82 px-1.5 py-0.5 text-[8px] text-fg-dim backdrop-blur">
                        {slot.label} · {slot.hint}
                        {d.model === "v3-omni" ? ` · @image_${slot.role === "first_frame" ? 1 : 2}` : ""}
                      </span>
                      {asset ? (
                        <button
                          type="button"
                          title={`移除${slot.label} ${asset.name}`}
                          onClick={() => removeReferenceAsset(asset.id)}
                          className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-white/10 bg-ink/80 text-fg-mute opacity-0 backdrop-blur transition-[opacity,color] hover:text-danger group-hover/reference:opacity-100 focus:opacity-100"
                        >
                          <Icon name="X" size={9} weight="bold" />
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : referenceAssets.length ? (
            <div className="nowheel mb-3 flex gap-2 overflow-x-auto rounded-[12px] border border-line bg-ink/30 p-2.5">
              {referenceAssets.map((asset, index) => (
                <div key={asset.id} className="group/reference relative h-[82px] w-[96px] shrink-0 overflow-hidden rounded-[10px] border border-white/10 bg-panel-2">
                  {asset.kind === "image" ? (
                    <img src={asset.localUrl ?? asset.url} alt={asset.name} className="h-full w-full object-cover" draggable={false} />
                  ) : asset.kind === "video" ? (
                    asset.previewUrl ? (
                      <img src={asset.previewUrl} alt={`${asset.name} 首帧`} className="h-full w-full object-cover" draggable={false} />
                    ) : (
                      <video
                        src={asset.localUrl ?? asset.url}
                        muted
                        playsInline
                        preload="auto"
                        onLoadedMetadata={(event) => {
                          const video = event.currentTarget;
                          if (Number.isFinite(video.duration) && video.duration > 0.08) {
                            video.currentTime = Math.min(0.12, video.duration / 10);
                          }
                        }}
                        aria-label={`${asset.name} 首帧预览`}
                        className="pointer-events-none h-full w-full object-cover"
                      />
                    )
                  ) : (
                    <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-fg-mute">
                      <Icon name="MusicNotes" size={20} />
                      <span className="max-w-[76px] truncate text-[9px]" title={asset.name}>{asset.name}</span>
                    </div>
                  )}
                  <span className="pointer-events-none absolute bottom-1.5 left-1.5 rounded-full border border-white/10 bg-ink/80 px-1.5 py-0.5 text-[8px] uppercase tracking-wide text-fg-dim backdrop-blur">
                    {asset.kind === "image"
                      ? d.model === "v3-omni"
                        ? `@image_${keyframeAssets.length + referenceAssets.slice(0, index + 1).filter((item) => item.kind === "image").length}`
                        : `图片 ${index + 1}`
                      : asset.kind === "video" && d.model === "v3-omni" ? "@video_1" : asset.kind === "video" ? "视频" : "音频"}
                  </span>
                  <button
                    type="button"
                    title={`移除参考素材 ${asset.name}`}
                    onClick={() => removeReferenceAsset(asset.id)}
                    className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-white/10 bg-ink/80 text-fg-mute opacity-0 backdrop-blur transition-[opacity,color] hover:text-danger group-hover/reference:opacity-100 focus:opacity-100"
                  >
                    <Icon name="X" size={9} weight="bold" />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <button
              type="button"
              disabled={running}
              onClick={() => {
                setRequestedFrameRole(null);
                referenceFileRef.current?.click();
              }}
              className="mb-3 flex h-11 w-full items-center justify-center gap-2 rounded-[11px] border border-dashed border-white/12 text-[10px] text-fg-mute transition-colors hover:border-white/25 hover:bg-white/[0.03] hover:text-fg disabled:pointer-events-none disabled:opacity-40"
            >
              <Icon name="UploadSimple" size={13} />
              拖入或选择多模态参考素材
              <span className="text-fg-mute/60">{d.model === "v3-omni" ? "JPG/PNG · MP4/MOV" : "图片 · 视频 · 音频"}</span>
            </button>
          )}

          {d.model === "v3-omni" && inputMode === "references" && referenceCounts.video > 0 ? (
            <div className="mb-3 flex flex-wrap items-center gap-1.5 rounded-[11px] border border-line bg-ink/25 p-2">
              <span className="mr-1 text-[9px] text-fg-mute">参考视频用途</span>
              <Chip
                active={(d.referType ?? "feature") === "feature"}
                onClick={() => updateNode(id, { referType: "feature", audioMode: "off", sound: false, keepOriginalSound: false })}
              >
                视频参考
              </Chip>
              <Chip
                active={d.referType === "base"}
                onClick={() => updateNode(id, {
                  referType: "base",
                  audioMode: omniAudioMode === "original" ? "original" : "off",
                  sound: false,
                  keepOriginalSound: omniAudioMode === "original",
                  shotsEnabled: false,
                })}
              >
                视频编辑
              </Chip>
              <span className="w-full text-[9px] leading-relaxed text-fg-mute/75">
                {d.referType === "base"
                  ? "在原视频上增删改内容；不支持分镜和首尾帧，可在参数中选择保留原声"
                  : "参考内容、风格与运镜生成新镜头；此模式必须关闭音频"}
              </span>
            </div>
          ) : null}

          {supportsShots(d.model) ? (
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[9px] text-fg-mute">提示词模式</span>
              <Chip
                active={shotsEnabled}
                onClick={() => updateNode(id, {
                  shotsEnabled: !shotsEnabled,
                  shots: shots.length ? shots : defaultShots(d.duration),
                })}
              >
                <Icon name="Scissors" size={10} /> 分镜
              </Chip>
            </div>
          ) : null}

          {shotsEnabled ? (
            <ShotEditor data={{ ...d, shots }} nodeId={id} />
          ) : (
            <textarea
              value={d.prompt}
              onChange={(event) => updateNode(id, { prompt: event.target.value })}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !sendDisabled) {
                  event.preventDefault();
                  void generateVideo(id);
                }
              }}
              placeholder="描述画面如何运动，如：镜头缓缓推近，人物转身微笑，衣摆随风轻摆"
              rows={3}
              className="tf-composer-prompt nodrag nowheel mb-3 min-h-[72px] max-h-[220px] w-full resize-y overflow-y-auto border-none bg-transparent text-[13px] leading-relaxed text-fg outline-none placeholder:text-fg-mute"
              spellCheck={false}
            />
          )}

          {!isSeedanceModel(d.model) && d.model !== "v3-omni" ? (
            <textarea
              value={d.negativePrompt ?? ""}
              onChange={(event) => updateNode(id, { negativePrompt: event.target.value })}
              placeholder="负向提示词（可选）：不希望出现的内容"
              rows={1}
              className="nowheel mb-3 min-h-[34px] w-full resize-y rounded-[9px] border border-line bg-ink/25 px-2.5 py-2 text-[10px] leading-relaxed text-fg outline-none placeholder:text-fg-mute focus:border-line-2"
              spellCheck={false}
            />
          ) : null}

          <div className="flex items-center justify-between gap-1">
            <div className="flex min-w-0 items-center gap-1">
              <div ref={modelAreaRef} className="relative shrink-0">
                {popover === "model" ? (
                  <div className="glass tf-node-popover popover-enter absolute bottom-full left-0 z-[80] mb-2 w-[300px] origin-bottom-left rounded-panel p-2">
                    <div className="mb-1 px-2 pb-1 pt-1 text-[9px] font-medium tracking-wide text-fg-mute">视频模型</div>
                    {VIDEO_MODELS.map((model) => (
                      <button
                        key={model.value}
                        type="button"
                        onClick={() => {
                          const patch: Partial<VideoNodeData> = { model: model.value as VideoModel };
                          const allowedResolutions = VIDEO_MODEL_RESOLUTIONS[model.value];
                          if (!allowedResolutions.includes(d.mode)) patch.mode = allowedResolutions[0];
                          const allowedDurations = videoDurationsFor(model.value);
                          if (!allowedDurations.includes(d.duration)) patch.duration = allowedDurations.includes(5) ? 5 : allowedDurations[0];
                          const allowedRatios = allowedVideoAspectRatios(model.value);
                          if (allowedRatios.length && !allowedRatios.includes(d.aspectRatio)) patch.aspectRatio = "智能";
                          if (!supportsShots(model.value)) patch.shotsEnabled = false;
                          if (model.value === "v3-omni") {
                            patch.audioMode = "off";
                            patch.sound = false;
                            patch.keepOriginalSound = false;
                            if (d.aspectRatio === "智能" && !firstFrame && !referenceCounts.video) patch.aspectRatio = "16:9";
                          }
                          updateNode(id, patch);
                          setPopover("none");
                        }}
                        className={cn(
                          "flex w-full items-center justify-between rounded-control px-3 py-2.5 text-left transition-colors",
                          d.model === model.value ? "bg-accent/10 text-accent" : "text-fg hover:bg-white/5",
                        )}
                      >
                        <span className="flex flex-col">
                          <span className="text-[12px] font-medium">{model.label}</span>
                          <span className="text-[10px] text-fg-mute">{model.blurb}</span>
                        </span>
                        {d.model === model.value ? <Icon name="Check" size={12} /> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
                <button
                  type="button"
                  onClick={() => setPopover(popover === "model" ? "none" : "model")}
                  className="flex h-8 items-center gap-1 rounded-full border border-line bg-panel-2/95 px-3 text-[11px] text-fg-dim transition-colors hover:border-line-2 hover:text-fg"
                >
                  <Icon name="FilmSlate" size={11} />
                  {modelInfo?.label ?? d.model}
                  <Icon name="CaretDown" size={9} />
                </button>
              </div>
              <div ref={paramAreaRef} className="relative min-w-0">
                {popover === "params" ? <VideoParamPopover data={d} nodeId={id} onClose={() => setPopover("none")} /> : null}
                <button
                  type="button"
                  onClick={() => setPopover(popover === "params" ? "none" : "params")}
                  className="flex h-8 min-w-0 items-center gap-1 truncate rounded-full border border-line bg-panel-2/95 px-3 text-[11px] text-fg-dim transition-colors hover:border-line-2 hover:text-fg"
                >
                  {d.mode} · {d.duration}s · {d.aspectRatio}
                  <Icon name="CaretDown" size={9} />
                </button>
              </div>
            </div>
            <button
              type="button"
              title={running ? "视频生成中" : !hasPrompt ? "请输入视频提示词" : generationError ?? "生成视频 (Ctrl+Enter)"}
              disabled={sendDisabled}
              onClick={() => void generateVideo(id)}
              className={cn(
                "flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-all active:scale-95",
                sendDisabled
                  ? "cursor-not-allowed bg-white/10 text-fg-mute"
                  : "bg-accent text-ink shadow-[0_6px_20px_-6px_rgba(255,255,255,0.4)] hover:bg-accent-2",
              )}
            >
              {running ? <Spinner size={14} /> : <Icon name="ArrowRight" size={14} weight="bold" />}
            </button>
          </div>
          {generationError && !running ? <div className="mt-1.5 text-[11px] text-danger">{generationError}</div> : null}
        </div>
      ) : null}
    </NodeShell>
  );
});
