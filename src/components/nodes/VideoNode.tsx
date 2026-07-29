"use client";

// 视频节点：画布上只保留预览卡片；选中预览后，在卡片下方展开独立的
// 生成设置对话框。交互层级与图片节点保持一致。

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useKeyPress, useReactFlow, type NodeProps } from "@xyflow/react";
import type { AppNode } from "@/lib/store";
import { useStudio } from "@/lib/store";
import type {
  ImageNodeData,
  VideoAspectRatio,
  VideoAudioMode,
  VideoFrameRole,
  VideoInputMode,
  VideoModel,
  VideoNodeData,
  VideoReferenceAsset,
  VideoReferenceKind,
  VideoResolution,
  VideoShotMode,
  ShotSegment,
} from "@/lib/types";
import { VIDEO_MODELS, VIDEO_MODEL_RESOLUTIONS, videoDurationsFor } from "@/lib/models";
import {
  allowedVideoAspectRatios,
  isSeedanceModel,
  resolveKeyframeSlots,
  shouldUseConnectedImageAsFirstFrame,
  supportsShots,
} from "@/lib/videoGateway";
import { cn, createMediaNodeSizing, fitMediaNodeSize } from "@/lib/utils";
import {
  forgetVideoReferenceBlob,
  readVideoReferenceBlob,
  rememberVideoReferenceBlob,
} from "@/lib/videoReferenceStorage";
import { inspectVideoFile } from "@/lib/mediaMetadata";
import { Icon } from "../icons";
import { NodeShell, RunningVeil } from "./NodeShell";
import { Chip, Spinner } from "../ui";
import { ImeSafeTextarea } from "../ImeSafeTextarea";
import {
  activeVideoPromptMention,
  assignVideoPromptReferences,
  type VideoPromptReference,
  type VideoPromptReferenceInput,
} from "@/lib/videoPromptReferences";

const VIDEO_REFERENCE_ACCEPT = "image/png,image/jpeg,image/webp,video/mp4,video/quicktime,audio/wav,audio/mpeg";
const VIDEO_KEYFRAME_ACCEPT = "image/png,image/jpeg,image/webp";
const KLING_OMNI_REFERENCE_ACCEPT = "image/png,image/jpeg,video/mp4,video/quicktime";
const KLING_OMNI_KEYFRAME_ACCEPT = "image/png,image/jpeg";
const KLING_MOTION_REFERENCE_ACCEPT = "image/png,image/jpeg,video/mp4,video/quicktime";
const VIDEO_GENERATOR_HEADER_HEIGHT = 94;
const VIDEO_GENERATOR_MIN_HEIGHT = 330;

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
  characterOrientation: "image" | "video" = "video",
): Promise<Pick<VideoReferenceAsset, "mimeType" | "sizeBytes" | "width" | "height" | "duration" | "frameRate">> {
  const base = { mimeType: file.type, sizeBytes: file.size };
  const videoMetadata = kind === "video" ? await inspectVideoFile(file) : null;
  if (model !== "v3-omni" && model !== "v3-motion-control") return { ...base, ...(videoMetadata ?? {}) };
  const motionControl = model === "v3-motion-control";
  const modelLabel = motionControl ? "可灵动作控制" : "可灵 Omni";
  if (kind === "audio") throw new Error(`${modelLabel}不支持参考音频`);
  if (kind === "image" && !/^(?:image\/jpeg|image\/png)$/i.test(file.type) && !/\.(?:jpe?g|png)$/i.test(file.name)) {
    throw new Error(`${modelLabel}图片仅支持 JPG、JPEG 或 PNG`);
  }
  if (kind === "image" && file.size > 50 * 1024 * 1024) throw new Error(`${modelLabel}图片不能超过 50MB`);
  const maxVideoBytes = motionControl ? 100 : 200;
  if (kind === "video" && file.size > maxVideoBytes * 1024 * 1024) throw new Error(`${modelLabel}视频不能超过 ${maxVideoBytes}MB`);
  const metadata = videoMetadata ?? await readVisualMetadata(file, kind);
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  const ratio = height ? width / height : 0;
  if (kind === "image") {
    if (width < 300 || height < 300) throw new Error(`${modelLabel}图片宽高均不能小于 300px`);
    if (ratio < 0.4 || ratio > 2.5) throw new Error(`${modelLabel}图片宽高比必须在 1:2.5 到 2.5:1 之间`);
  } else {
    const duration = metadata.duration ?? 0;
    const maxDuration = motionControl ? characterOrientation === "image" ? 10 : 30 : 15.5;
    if (duration < 3 || duration > maxDuration) throw new Error(`参考视频时长必须在 3-${maxDuration} 秒之间`);
    if (motionControl) {
      if (width < 340 || height < 340 || width > 3850 || height > 3850) throw new Error("动作参考视频宽高必须在 340-3850px 之间");
    } else {
      if (width < 700 || height < 700 || width > 4553 || height > 4553) throw new Error("参考视频宽高必须在 700-4553px 之间");
      if (width * height > 8_294_400) throw new Error("参考视频总像素不能超过 8294400");
      if (ratio < 0.4 || ratio > 2) throw new Error("参考视频宽高比必须在 0.4-2 之间");
    }
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

function videoFailurePresentation(error?: string) {
  const raw = error?.trim() || "请求未完成，请稍后重试。";
  const status = raw.match(/\b([1-5]\d{2})\b/)?.[1];
  let message = raw;
  const jsonStart = raw.indexOf("{");

  if (jsonStart >= 0) {
    try {
      const payload = JSON.parse(raw.slice(jsonStart)) as {
        error?: { message?: unknown } | string;
        message?: unknown;
      };
      if (typeof payload.error === "object" && typeof payload.error?.message === "string") {
        message = payload.error.message;
      } else if (typeof payload.error === "string") {
        message = payload.error;
      } else if (typeof payload.message === "string") {
        message = payload.message;
      }
    } catch {
      // Keep the original response when the provider does not return valid JSON.
    }
  }

  const normalized = `${raw} ${message}`.toLowerCase();
  if (status === "401" || status === "403" || /invalid token|unauthorized|forbidden|token.*(?:invalid|expired)/i.test(normalized)) {
    message = "API 令牌无效，请在设置中更新后重试。";
  } else if (/insufficient|balance|quota|credit|余额|额度/.test(normalized)) {
    message = "账户额度不足，请充值或更换令牌后重试。";
  } else if (status === "429" || /rate.?limit|too many requests|请求过于频繁/.test(normalized)) {
    message = "请求过于频繁，请稍后再试。";
  } else if (/timeout|timed out|超时/.test(normalized)) {
    message = "服务响应超时，请稍后重试。";
  } else if (/非 json|non.?json|<!doctype html|<html|返回了网页/.test(normalized)) {
    message = "上游返回了网页内容，接口路由或反向代理配置可能异常。";
  } else if (/fetch failed|econn|network|网络|无法连接/.test(normalized)) {
    message = "网络连接异常，请检查网络后重试。";
  } else {
    message = message
      .replace(/\s*\(request id[:：]?[^)]*\)/gi, "")
      .replace(/\s*request id[:：]?\s*[\w-]+/gi, "")
      .replace(/^.+?\([45]\d{2}\)\s*:\s*/, "")
      .trim();
  }

  return { message: message || "请求未完成，请稍后重试。", status, raw };
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back to the legacy copy path when clipboard permission is denied.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("浏览器拒绝复制");
}

function referenceCompatibilityError(model: VideoModel, assets: VideoReferenceAsset[]) {
  const counts = countReferences(assets);
  if (model === "v3-omni") {
    if (counts.audio) return "可灵 v3 Omni 暂不支持参考音频，请移除音频或切换 Seedance";
    if (counts.video > 1) return "可灵 v3 Omni 最多支持 1 段参考视频";
    const imageLimit = counts.video ? 4 : 7;
    if (counts.image > imageLimit) return `当前组合下可灵 v3 Omni 最多支持 ${imageLimit} 张参考图`;
  }
  if (model === "v3-motion-control") {
    if (counts.audio) return "可灵动作控制不支持参考音频";
    if (counts.video > 1) return "可灵动作控制只能添加 1 段动作参考视频";
    if (counts.image > 1) return "可灵动作控制只能添加 1 张形象参考图";
  }
  if (isSeedanceModel(model)) {
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

function PromptReferencePreview({ reference, className }: { reference: VideoPromptReference; className: string }) {
  if (reference.previewUrl) {
    return <img src={reference.previewUrl} alt="" className={cn(className, "object-cover")} draggable={false} />;
  }
  if (reference.kind === "video" && reference.mediaUrl) {
    return (
      <video
        src={reference.mediaUrl}
        muted
        playsInline
        preload="metadata"
        onLoadedMetadata={(event) => {
          const video = event.currentTarget;
          if (Number.isFinite(video.duration) && video.duration > 0.08) video.currentTime = Math.min(0.12, video.duration / 10);
        }}
        className={cn(className, "object-cover")}
      />
    );
  }
  return (
    <span className={cn(className, "flex items-center justify-center bg-white/[0.035] text-fg-mute")}>
      <Icon name={reference.kind === "image" ? "Image" : reference.kind === "video" ? "VideoCamera" : "MusicNotes"} size={12} />
    </span>
  );
}

function promptReferenceTone(reference: VideoPromptReference) {
  if (reference.kind === "image") return "text-[#72c7ff]";
  if (reference.kind === "video") return "text-[#c6a7ff]";
  return "text-[#f4bd72]";
}

function PromptMentionTextarea({
  value,
  onValueChange,
  references,
  placeholder,
  rows,
  className,
  overlayClassName,
  wrapperClassName,
  onSubmit,
}: {
  value: string;
  onValueChange: (value: string) => void;
  references: VideoPromptReference[];
  placeholder: string;
  rows: number;
  className: string;
  overlayClassName: string;
  wrapperClassName?: string;
  onSubmit?: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [displayValue, setDisplayValue] = useState(value);
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollbarWidth, setScrollbarWidth] = useState(0);
  const [mention, setMention] = useState<ReturnType<typeof activeVideoPromptMention>>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const filteredReferences = mention
    ? references.filter((reference) => {
        if (!mention.query) return true;
        const haystack = `${reference.token} ${reference.name}`.toLocaleLowerCase();
        return haystack.includes(mention.query);
      })
    : [];
  const boundReferences = references.filter((reference) => {
    const escapedToken = reference.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`${escapedToken}(?![\\w-])`, "u").test(displayValue);
  });
  const referenceByToken = new Map(references.map((reference) => [reference.token, reference]));
  const escapedTokens = references
    .map((reference) => reference.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((left, right) => right.length - left.length);
  const highlightedParts = escapedTokens.length
    ? displayValue.split(new RegExp(`(${escapedTokens.join("|")})(?![\\w-])`, "gu"))
    : [displayValue];

  useEffect(() => {
    setDisplayValue(value);
  }, [value]);

  const syncScrollbarWidth = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const computed = window.getComputedStyle(textarea);
    const borderWidth = Number.parseFloat(computed.borderLeftWidth)
      + Number.parseFloat(computed.borderRightWidth);
    const nextWidth = Math.max(0, textarea.offsetWidth - textarea.clientWidth - borderWidth);
    setScrollbarWidth((current) => Math.abs(current - nextWidth) < 0.25 ? current : nextWidth);
  }, []);

  useLayoutEffect(() => {
    syncScrollbarWidth();
  }, [displayValue, boundReferences.length, syncScrollbarWidth]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncScrollbarWidth);
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [syncScrollbarWidth]);

  const refreshMention = (nextValue: string) => {
    const caret = textareaRef.current?.selectionStart ?? nextValue.length;
    const nextMention = activeVideoPromptMention(nextValue, caret);
    setMention(nextMention);
    setActiveIndex(0);
  };

  const insertReference = (reference: VideoPromptReference) => {
    const textarea = textareaRef.current;
    if (!textarea || !mention) return;
    textarea.focus();
    textarea.setSelectionRange(mention.start, mention.end);
    textarea.setRangeText(`${reference.token} `, mention.start, mention.end, "end");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    setMention(null);
  };

  const kindLabel = (reference: VideoPromptReference) => {
    if (reference.role === "first_frame") return "首帧";
    if (reference.role === "last_frame") return "尾帧";
    if (reference.kind === "image") return "参考图";
    if (reference.kind === "video") return "参考视频";
    return "参考音频";
  };

  return (
    <div className={cn("relative", wrapperClassName)}>
      <ImeSafeTextarea
        ref={textareaRef}
        value={value}
        onDraftValueChange={setDisplayValue}
        onValueChange={(nextValue) => {
          onValueChange(nextValue);
          refreshMention(nextValue);
        }}
        onClick={(event) => refreshMention(event.currentTarget.value)}
        onKeyUp={(event) => {
          if (["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) return;
          refreshMention(event.currentTarget.value);
        }}
        onBlur={() => window.setTimeout(() => setMention(null), 120)}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onKeyDown={(event) => {
          if (mention && filteredReferences.length) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const direction = event.key === "ArrowDown" ? 1 : -1;
              setActiveIndex((current) => (current + direction + filteredReferences.length) % filteredReferences.length);
              return;
            }
            if (event.key === "Enter" || event.key === "Tab") {
              event.preventDefault();
              insertReference(filteredReferences[activeIndex] ?? filteredReferences[0]);
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setMention(null);
              return;
            }
          }
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            onSubmit?.();
          }
        }}
        placeholder={placeholder}
        rows={rows}
        className={className}
        style={{
          color: "transparent",
          caretColor: "var(--color-fg)",
          ...(boundReferences.length ? { paddingTop: 49 } : {}),
        }}
        spellCheck={false}
      />
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-px z-[5] overflow-hidden whitespace-pre-wrap break-words text-fg",
          overlayClassName,
        )}
        style={{
          right: 1 + scrollbarWidth,
          ...(boundReferences.length ? { paddingTop: 49 } : {}),
        }}
      >
        <div
          style={{
            transform: `translateY(-${scrollTop}px)`,
            // Native textareas use text-rendering:auto. Matching it here keeps
            // the colored mirror layer aligned with the real caret.
            textRendering: "auto",
          }}
        >
          {highlightedParts.map((part, index) => {
            const reference = referenceByToken.get(part);
            return reference ? (
              <span key={`${part}-${index}`} className={promptReferenceTone(reference)}>{part}</span>
            ) : <span key={`text-${index}`}>{part}</span>;
          })}
        </div>
      </div>
      {boundReferences.length ? (
        <div
          className="nodrag nowheel absolute left-2 right-2 top-2 z-10 flex gap-1.5 overflow-x-auto pb-1"
          onMouseDown={(event) => {
            event.preventDefault();
            textareaRef.current?.focus();
          }}
        >
          {boundReferences.map((reference) => (
            <span
              key={`bound-${reference.key}-${reference.promptId}`}
              title={`${reference.name} · ${reference.token}`}
              className={cn("flex h-8 shrink-0 items-center gap-1.5 rounded-[9px] border border-white/[0.1] bg-[#151517]/94 p-1 pr-2 font-mono text-[9px] shadow-[0_5px_16px_rgba(0,0,0,0.22)] backdrop-blur", promptReferenceTone(reference))}
            >
              <PromptReferencePreview reference={reference} className="h-6 w-6 shrink-0 rounded-[6px]" />
              {reference.token}
            </span>
          ))}
        </div>
      ) : null}
      {mention && references.length ? (
        <div
          role="listbox"
          aria-label="引用参考素材"
          className="nodrag absolute bottom-full left-0 z-[90] mb-2 w-[min(320px,100%)] overflow-hidden rounded-[13px] border border-white/[0.11] bg-[#171719]/98 p-1.5 shadow-[0_18px_48px_rgba(0,0,0,0.52)] backdrop-blur-xl"
          onMouseDown={(event) => event.preventDefault()}
        >
          <div className="flex items-center justify-between px-2 pb-1.5 pt-1 text-[9px] text-fg-mute">
            <span>引用参考素材</span>
            <span>↑↓ 选择 · Enter 插入</span>
          </div>
          <div className="nowheel max-h-[210px] overflow-y-auto">
            {filteredReferences.length ? filteredReferences.map((reference, index) => (
              <button
                key={`${reference.key}-${reference.promptId}`}
                type="button"
                role="option"
                aria-selected={index === activeIndex}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  insertReference(reference);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-[9px] px-2 py-2 text-left transition-colors",
                  index === activeIndex ? "bg-white/[0.09] text-fg" : "text-fg-dim hover:bg-white/[0.055]",
                )}
              >
                <PromptReferencePreview reference={reference} className="h-8 w-8 shrink-0 rounded-[8px] border border-white/[0.08]" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[10px] text-fg">{reference.name}</span>
                  <span className="mt-0.5 block text-[9px] text-fg-mute">{kindLabel(reference)}</span>
                </span>
                <span className={cn("shrink-0 rounded-full border border-white/[0.08] bg-black/20 px-2 py-1 font-mono text-[9px]", promptReferenceTone(reference))}>
                  {reference.token}
                </span>
              </button>
            )) : (
              <div className="px-3 py-4 text-center text-[10px] text-fg-mute">没有匹配的素材</div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ShotEditor({ data, nodeId, references }: { data: VideoNodeData; nodeId: string; references: VideoPromptReference[] }) {
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
          <PromptMentionTextarea
            value={shot.prompt}
            onValueChange={(nextValue) => updateShot(index, { prompt: nextValue })}
            references={references}
            placeholder={`第 ${index + 1} 段提示词`}
            rows={2}
            className="nowheel min-h-[52px] flex-1 resize-y rounded-[9px] border border-line bg-panel-2/70 p-2 text-[11px] leading-relaxed text-fg outline-none placeholder:text-fg-mute focus:border-line-2"
            overlayClassName="p-2 text-[11px] leading-relaxed"
            wrapperClassName="min-w-0 flex-1"
          />
          <label className="relative w-20 shrink-0">
            <input
              type="number"
              min={1}
              max={data.duration}
              value={shot.duration}
              onChange={(event) => updateShot(index, { duration: Math.max(1, Number(event.target.value) || 1) })}
              aria-label={`第 ${index + 1} 段时长（秒）`}
              className="h-9 w-full appearance-none rounded-[9px] border border-line bg-panel-2/70 pl-3 pr-7 text-left text-[12px] tabular-nums text-fg outline-none focus:border-line-2 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[9px] text-fg-mute">秒</span>
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

function VideoParamPopover({
  data,
  nodeId,
  onClose,
  hasConnectedVideo = false,
}: {
  data: VideoNodeData;
  nodeId: string;
  onClose: () => void;
  hasConnectedVideo?: boolean;
}) {
  const updateNode = useStudio((s) => s.updateNode);
  const set = (patch: Partial<VideoNodeData>) => updateNode(nodeId, patch);
  const durations = videoDurationsFor(data.model);
  const resolutions = VIDEO_MODEL_RESOLUTIONS[data.model];
  const ratios = allowedVideoAspectRatios(data.model);
  const seedance = isSeedanceModel(data.model);
  const omni = data.model === "v3-omni";
  const motionControl = data.model === "v3-motion-control";
  const hasOmniVideo = hasConnectedVideo || Boolean(data.sourceVideo)
    || (Array.isArray(data.referenceAssets) && data.referenceAssets.some((asset) => asset.kind === "video"));
  const selectedAudioMode: VideoAudioMode = data.audioMode ?? (data.keepOriginalSound ? "original" : data.sound ? "native" : "off");
  const audioModes: Array<{ value: VideoAudioMode; label: string; disabled: boolean; reason?: string }> = [
    { value: "native", label: "生成声音", disabled: hasOmniVideo, reason: hasOmniVideo ? "包含参考视频时不能生成声音" : undefined },
    { value: "original", label: "保留原声", disabled: !hasOmniVideo, reason: !hasOmniVideo ? "需要先添加参考视频" : undefined },
    { value: "off", label: "关闭声音", disabled: false },
  ];
  const audioModeHint = !hasOmniVideo
    ? "添加参考视频并选择“视频编辑”，即可保留原声"
    : data.referType === "base"
      ? "生成时保留参考视频中的原声"
      : "视频参考模式只能关闭声音；切换到视频编辑后可保留原声";
  const configuredShotMode: VideoShotMode = data.shotsEnabled || data.shotMode === "custom"
    ? "custom"
    : data.shotModeExplicit !== true ? "auto" : data.shotMode ?? "single";
  const effectiveShotMode: VideoShotMode = omni && hasOmniVideo
    ? data.referType === "base" ? "single" : configuredShotMode === "single" ? "auto" : configuredShotMode
    : configuredShotMode;

  return (
    <div className="glass tf-node-popover popover-enter absolute bottom-full left-0 z-[80] mb-2 max-h-[72vh] w-[340px] origin-bottom-left overflow-y-auto rounded-panel p-4">
      <button type="button" title="关闭参数" onClick={onClose} className="absolute right-3 top-3 rounded p-1 text-fg-mute hover:bg-white/[0.06] hover:text-fg">
        <Icon name="X" size={12} />
      </button>

      <div className="mb-1.5 pr-7 text-[10px] font-medium tracking-wide text-fg-mute">分辨率</div>
      <div className="mb-3 flex gap-1.5">
        {resolutions.map((resolution) => (
          <Chip key={resolution} active={data.mode === resolution} onClick={() => set({ mode: resolution as VideoResolution })}>
            {resolution}
          </Chip>
        ))}
      </div>

      {motionControl ? (
        <div className="mb-3 rounded-[10px] border border-line bg-ink/25 px-3 py-2 text-[9px] leading-relaxed text-fg-mute">
          输出时长由动作参考视频决定：跟随形象图时最长 10 秒，跟随动作视频时最长 30 秒。
        </div>
      ) : (
        <>
          <div className="mb-1.5 text-[10px] font-medium tracking-wide text-fg-mute">时长</div>
          <div className="nowheel mb-3 flex max-h-[86px] flex-wrap gap-1.5 overflow-y-auto">
            {durations.map((duration) => (
              <Chip key={duration} active={data.duration === duration} onClick={() => set({ duration })}>
                {duration}s
              </Chip>
            ))}
          </div>
        </>
      )}

      {ratios.length ? (
        <>
          <div className="mb-1.5 text-[10px] font-medium tracking-wide text-fg-mute">画面比例</div>
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

      {omni && hasOmniVideo ? (
        <div className="mb-3 border-t border-line pt-3">
          <div className="mb-1.5 text-[10px] font-medium tracking-wide text-fg-mute">参考视频模式</div>
          <div className="flex gap-1.5">
            <Chip
              active={(data.referType ?? "feature") === "feature"}
              onClick={() => set({
                referType: "feature",
                audioMode: "off",
                sound: false,
                keepOriginalSound: false,
                shotMode: configuredShotMode === "custom" ? "custom" : "auto",
                shotsEnabled: configuredShotMode === "custom",
              })}
            >
              视频参考
            </Chip>
            <Chip
              active={data.referType === "base"}
              onClick={() => set({
                referType: "base",
                audioMode: selectedAudioMode === "original" ? "original" : "off",
                sound: false,
                keepOriginalSound: selectedAudioMode === "original",
                shotMode: "single",
                shotsEnabled: false,
              })}
            >
              视频编辑
            </Chip>
          </div>
          <div className="mt-1.5 text-[9px] leading-relaxed text-fg-mute/75">
            {data.referType === "base" ? "基于原视频增删改内容，可选择保留原声" : "参考内容、风格与运镜生成新镜头"}
          </div>
        </div>
      ) : null}

      {omni ? (
        <div className={cn("mb-3", !hasOmniVideo && "border-t border-line pt-3")}>
          <div className="mb-1.5 text-[10px] font-medium tracking-wide text-fg-mute">镜头模式</div>
          <div className="flex flex-wrap gap-1.5">
            {([
              { value: "single", label: "单镜头" },
              { value: "auto", label: "AI 自动多镜头" },
              { value: "custom", label: "自定义分镜" },
            ] as Array<{ value: VideoShotMode; label: string }>).map((mode) => {
              const disabled = hasOmniVideo
                && (data.referType === "base" ? mode.value !== "single" : mode.value === "single");
              return (
                <Chip
                  key={mode.value}
                  active={effectiveShotMode === mode.value}
                  disabled={disabled}
                  title={disabled ? data.referType === "base" ? "视频编辑仅支持单镜头" : "视频参考必须使用多镜头" : undefined}
                  onClick={() => set({
                    shotMode: mode.value,
                    shotModeExplicit: true,
                    shotsEnabled: mode.value === "custom",
                    shots: Array.isArray(data.shots) && data.shots.length ? data.shots : defaultShots(data.duration),
                  })}
                >
                  {mode.value === "custom" ? <Icon name="Scissors" size={10} /> : null} {mode.label}
                </Chip>
              );
            })}
          </div>
        </div>
      ) : null}

      {motionControl ? (
        <div className="mb-3 space-y-3 border-t border-line pt-3">
          <div>
            <div className="mb-1.5 text-[10px] font-medium tracking-wide text-fg-mute">角色朝向</div>
            <div className="flex gap-1.5">
              <Chip
                active={(data.characterOrientation ?? "video") === "image"}
                onClick={() => set({ characterOrientation: "image" })}
              >
                跟随形象图
              </Chip>
              <Chip active={(data.characterOrientation ?? "video") === "video"} onClick={() => set({ characterOrientation: "video" })}>
                跟随动作视频
              </Chip>
            </div>
          </div>
        </div>
      ) : null}

      <div className="border-t border-line pt-3">
        <div className="mb-1.5 text-[10px] font-medium tracking-wide text-fg-mute">声音</div>
        <div className="flex flex-wrap gap-1.5">
          {omni ? audioModes.map((mode) => (
            <Chip
              key={mode.value}
              active={selectedAudioMode === mode.value}
              disabled={mode.disabled}
              title={mode.reason}
              onClick={() => set({
                audioMode: mode.value,
                sound: mode.value === "native",
                keepOriginalSound: mode.value === "original",
              })}
            >
              <Icon name="MusicNotes" size={11} /> {mode.label}
            </Chip>
          )) : motionControl ? ([
            { value: "original" as const, label: "保留动作视频原声" },
            { value: "off" as const, label: "关闭声音" },
          ]).map((mode) => (
            <Chip
              key={mode.value}
              active={(data.audioMode === "original" ? "original" : "off") === mode.value}
              onClick={() => set({
                audioMode: mode.value,
                sound: false,
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
        </div>
        {omni ? <div className="mt-2 text-[9px] leading-relaxed text-fg-mute/80">{audioModeHint}</div> : null}
      </div>
      {seedance ? (
        <div className="mt-3 flex flex-wrap gap-1.5 border-t border-line pt-3">
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
        </div>
      ) : null}
    </div>
  );
}

export const VideoNode = memo(function VideoNode({ id, type, selected, dragging, data }: NodeProps<AppNode>) {
  const d = data as VideoNodeData;
  const generatorOnly = type === "videoGenerator";
  const assetOnly = type === "videoAsset";
  const updateNode = useStudio((s) => s.updateNode);
  const generateVideo = useStudio((s) => s.generateVideo);
  const addNode = useStudio((s) => s.addNode);
  const showToast = useStudio((s) => s.showToast);
  const nodes = useStudio((s) => s.nodes);
  const edges = useStudio((s) => s.edges);
  const referenceFileRef = useRef<HTMLInputElement>(null);
  const primaryVideoRef = useRef<HTMLVideoElement>(null);
  const revivedLocalKeysRef = useRef(new Set<string>());
  const modelAreaRef = useRef<HTMLDivElement>(null);
  const paramAreaRef = useRef<HTMLDivElement>(null);
  const [popover, setPopover] = useState<"none" | "params" | "model">("none");
  const [composerOpen, setComposerOpen] = useState(generatorOnly);
  const [frameExtractorOpen, setFrameExtractorOpen] = useState(false);
  const [trimOpen, setTrimOpen] = useState(false);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [trimPreviewPlaying, setTrimPreviewPlaying] = useState(false);
  const [fileDragActive, setFileDragActive] = useState(false);
  const [requestedFrameRole, setRequestedFrameRole] = useState<VideoFrameRole | null>(null);
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoCurrentTime, setVideoCurrentTime] = useState(0);
  const [extractingFrame, setExtractingFrame] = useState(false);
  const [errorCopied, setErrorCopied] = useState(false);
  const selectionModifierPressed = useKeyPress(["Control", "Meta", "Shift"]);
  const multipleNodesSelected = nodes.reduce((count, node) => count + (node.selected ? 1 : 0), 0) > 1;
  const rf = useReactFlow();

  const sourceVideo = d.sourceVideo;
  const isGeneratedResult = d.isGeneratedResult === true;
  const referenceAssets = Array.isArray(d.referenceAssets) ? d.referenceAssets : [];
  const generationReferenceAssets = d.model === "v3-omni" && sourceVideo
    ? [sourceVideo, ...referenceAssets.filter((asset) => asset.id !== sourceVideo.id)]
    : referenceAssets;
  const keyframeAssets = Array.isArray(d.keyframeAssets) ? d.keyframeAssets : [];
  const motionControl = d.model === "v3-motion-control";
  const inputMode: VideoInputMode = motionControl ? "references" : d.inputMode === "keyframes" ? "keyframes" : "references";
  const activeAssets = inputMode === "keyframes" ? keyframeAssets : referenceAssets;
  const upstreamNodes = edges
    .filter((edge) => edge.target === id && edge.data?.generation !== true)
    .map((edge) => nodes.find((node) => node.id === edge.source))
    .filter(Boolean);
  const hasUpstreamText = upstreamNodes.some((node) => node?.type === "text" && Boolean(String(node.data.text ?? "").trim()));
  const connectedImageAssets: VideoReferenceAsset[] = Array.from(new Map(upstreamNodes.flatMap((node) => {
    if (node?.type !== "imageAsset") return [];
    const image = node.data as ImageNodeData;
    const url = image.urls?.[image.activeIndex ?? 0] ?? image.url;
    if (!url) return [];
    return [[url, {
      id: `canvas-image-${node.id}`,
      kind: "image" as const,
      name: image.label || "连线参考图",
      url,
    } satisfies VideoReferenceAsset]];
  })).values());
  const upstreamImageCount = connectedImageAssets.length;
  const connectedVideoAssets: VideoReferenceAsset[] = Array.from(new Map(upstreamNodes.flatMap((node) => {
    if (node?.type !== "videoAsset") return [];
    const video = node.data as VideoNodeData;
    const source = video.sourceVideo;
    const url = source?.localUrl ?? source?.url ?? video.url ?? video.remoteUrl;
    if (!url) return [];
    return [[url, {
      ...(source ?? {}),
      id: `canvas-video-${node.id}`,
      kind: "video" as const,
      name: source?.name || video.label || "连线参考视频",
      url,
    } satisfies VideoReferenceAsset]];
  })).values());
  const upstreamVideoCount = connectedVideoAssets.length;
  const storedReferenceCounts = countReferences(generationReferenceAssets);
  const referenceCounts = {
    ...storedReferenceCounts,
    image: storedReferenceCounts.image + upstreamImageCount,
    video: storedReferenceCounts.video + upstreamVideoCount,
  };
  const {
    firstFrame,
    lastFrame,
    connectedFrameIds,
  } = resolveKeyframeSlots(keyframeAssets, inputMode === "keyframes" ? connectedImageAssets : []);
  const connectedFrameIdSet = new Set(connectedFrameIds);
  const previewImage = inputMode === "keyframes"
    ? firstFrame?.localUrl ?? firstFrame?.url ?? null
    : (() => {
        const image = referenceAssets.find((asset) => asset.kind === "image");
        return image?.localUrl ?? image?.url ?? connectedImageAssets[0]?.url ?? null;
      })();
  const playbackUrl = d.url ?? sourceVideo?.localUrl ?? sourceVideo?.url ?? null;
  const mediaWidth = sourceVideo?.width ?? d.mediaWidth;
  const mediaHeight = sourceVideo?.height ?? d.mediaHeight;
  const mediaFrameRate = sourceVideo?.frameRate ?? d.mediaFrameRate;
  const appliedClipDuration = d.clipEnd != null
    ? Math.max(0, d.clipEnd - (d.clipStart ?? 0))
    : sourceVideo?.trimEnd != null
      ? Math.max(0, sourceVideo.trimEnd - (sourceVideo.trimStart ?? 0))
      : 0;
  const mediaMeta = mediaWidth && mediaHeight
    ? `${mediaWidth} × ${mediaHeight}${mediaFrameRate ? ` · ${Number(mediaFrameRate.toFixed(2))} fps` : ""}${appliedClipDuration ? ` · 片段 ${appliedClipDuration.toFixed(2)}s` : ""}`
    : undefined;
  const configuredShotMode: VideoShotMode = d.shotsEnabled || d.shotMode === "custom"
    ? "custom"
    : d.model === "v3-omni" && d.shotModeExplicit !== true
      ? "auto"
      : d.shotMode ?? "single";
  const shotMode: VideoShotMode = d.model === "v3-omni" && referenceCounts.video > 0
    ? d.referType === "base" ? "single" : configuredShotMode === "single" ? "auto" : configuredShotMode
    : configuredShotMode;
  const shotsEnabled = shotMode === "custom" && supportsShots(d.model);
  const shots = Array.isArray(d.shots) && d.shots.length ? d.shots : defaultShots(d.duration);
  const hasPrompt = shotsEnabled ? shots.every((shot) => Boolean(shot.prompt.trim())) : Boolean(d.prompt.trim()) || hasUpstreamText;
  const running = d.status === "running";
  const failure = d.status === "failed" ? videoFailurePresentation(d.error) : null;
  const copyFailureDetail = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!failure) return;
    try {
      await copyText(failure.raw);
      setErrorCopied(true);
      window.setTimeout(() => setErrorCopied(false), 1_600);
      showToast("错误信息已复制", "success");
    } catch {
      showToast("复制失败，请手动选择错误详情", "error");
    }
  };
  const needsFrame = d.model === "v3" || d.model === "v2-6";
  const connectedFirstFrame = connectedImageAssets[0];
  const useConnectedAsFirstFrame = inputMode !== "keyframes" && Boolean(connectedFirstFrame)
    && shouldUseConnectedImageAsFirstFrame(d.model, inputMode, Boolean(firstFrame));
  const promptFirstFrame = firstFrame ?? (useConnectedAsFirstFrame ? connectedFirstFrame : undefined);
  const promptReferenceInputs: VideoPromptReferenceInput[] = [
    ...(promptFirstFrame
      ? [{
          key: promptFirstFrame.id,
          kind: "image" as const,
          name: promptFirstFrame.name || "首帧",
          role: "first_frame" as const,
          previewUrl: promptFirstFrame.localUrl ?? promptFirstFrame.previewUrl ?? promptFirstFrame.url,
        }]
      : []),
    ...(lastFrame ? [{
      key: lastFrame.id,
      kind: "image" as const,
      name: lastFrame.name || "尾帧",
      role: "last_frame" as const,
      previewUrl: lastFrame.localUrl ?? lastFrame.previewUrl ?? lastFrame.url,
    }] : []),
    ...generationReferenceAssets
      .filter((asset) => asset.kind === "image")
      .map((asset) => ({
        key: asset.id,
        kind: "image" as const,
        name: asset.name,
        role: "reference" as const,
        previewUrl: asset.localUrl ?? asset.previewUrl ?? asset.url,
      })),
    ...connectedImageAssets
      .filter((asset) => !connectedFrameIdSet.has(asset.id))
      .slice(useConnectedAsFirstFrame ? 1 : 0)
      .map((asset) => ({
        key: asset.id,
        kind: "image" as const,
        name: asset.name,
        role: "reference" as const,
        previewUrl: asset.localUrl ?? asset.previewUrl ?? asset.url,
      })),
    ...generationReferenceAssets
      .filter((asset) => asset.kind === "video")
      .map((asset) => ({
        key: asset.id,
        kind: "video" as const,
        name: asset.name,
        role: "reference" as const,
        previewUrl: asset.previewUrl,
        mediaUrl: asset.localUrl ?? asset.url,
      })),
    ...connectedVideoAssets
      .map((asset) => ({
        key: asset.id,
        kind: "video" as const,
        name: asset.name,
        role: "reference" as const,
        previewUrl: asset.previewUrl,
        mediaUrl: asset.localUrl ?? asset.url,
      })),
    ...generationReferenceAssets
      .filter((asset) => asset.kind === "audio")
      .map((asset) => ({ key: asset.id, kind: "audio" as const, name: asset.name, role: "reference" as const })),
  ];
  const promptReferences = d.model === "v3-omni" || isSeedanceModel(d.model)
    ? assignVideoPromptReferences(promptReferenceInputs).filter((reference) => d.model !== "v3-omni" || reference.kind !== "audio")
    : [];
  const promptReferenceByKey = new Map(promptReferences.map((reference) => [reference.key, reference]));
  const modelInfo = VIDEO_MODELS.find((model) => model.value === d.model);
  const compatibilityError = inputMode === "keyframes"
    ? keyframeCompatibilityError(keyframeAssets)
    : referenceCompatibilityError(d.model, generationReferenceAssets);
  const shotTotal = shots.reduce((sum, shot) => sum + shot.duration, 0);
  const omniAudioMode: VideoAudioMode = d.audioMode ?? (d.keepOriginalSound ? "original" : d.sound ? "native" : "off");
  const shotModeSummary = shotMode === "custom" ? "自定义分镜" : shotMode === "auto" ? "自动多镜头" : "单镜头";
  const audioModeSummary = d.model === "v3-omni"
    ? omniAudioMode === "native" ? "生成声音" : omniAudioMode === "original" ? "保留原声" : "关闭声音"
    : motionControl
      ? d.audioMode === "original" ? "保留原声" : "关闭声音"
    : d.sound ? "生成音效" : "关闭声音";
  const paramSummary = motionControl
    ? `${d.mode} · ${d.characterOrientation === "image" ? "跟随形象图" : "跟随动作视频"} · ${audioModeSummary}`
    : `${d.mode} · ${d.duration}s · ${d.aspectRatio} · ${shotModeSummary} · ${audioModeSummary}`;
  const omniImageLimit = referenceCounts.video ? 4 : 7;
  const omniMetadataError = d.model === "v3-omni" ? omniAssetMetadataError([...keyframeAssets, ...generationReferenceAssets]) : null;
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
              ? "视频编辑模式不支持首尾帧"
              : referenceCounts.video > 0 && d.referType === "base" && shotsEnabled
                ? "视频编辑模式不支持分镜"
                : referenceCounts.video > 0 && d.referType !== "base" && omniAudioMode === "native"
                  ? "视频参考模式不能生成原生音频"
                  : referenceCounts.video > 0 && d.referType === "base" && omniAudioMode === "native"
                    ? "视频编辑模式只能关闭声音或保留原声"
                    : !referenceCounts.video && omniAudioMode === "original"
                      ? "没有参考视频时不能保留原声"
                      : !firstFrame && !referenceCounts.video && d.aspectRatio === "智能"
                        ? "没有首帧或参考视频时必须选择画面比例"
                        : null;
  const motionVideo = [...generationReferenceAssets, ...connectedVideoAssets].find((asset) => asset.kind === "video");
  const motionVideoDuration = motionVideo?.duration != null
    ? Math.max(0, (motionVideo.trimEnd ?? motionVideo.duration) - (motionVideo.trimStart ?? 0))
    : undefined;
  const motionMaxDuration = d.characterOrientation === "image" ? 10 : 30;
  const motionCompatibilityError = !motionControl
    ? null
    : referenceCounts.audio
      ? "可灵动作控制不支持参考音频"
      : referenceCounts.video !== 1
        ? "请添加 1 段动作参考视频"
        : referenceCounts.image !== 1
          ? "请添加 1 张形象参考图"
              : motionVideoDuration != null && (motionVideoDuration < 3 || motionVideoDuration > motionMaxDuration)
                ? `动作参考视频时长必须在 3-${motionMaxDuration} 秒之间`
                : null;
  const generationError = motionControl && d.prompt.length > 2500
    ? "可灵动作控制提示词不能超过 2500 字符"
    : motionCompatibilityError
      ? motionCompatibilityError
    : shotsEnabled && shotTotal !== d.duration
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
  const mediaSizing = assetOnly && mediaWidth && mediaHeight
    ? createMediaNodeSizing(mediaWidth, mediaHeight, 520)
    : null;
  const fittedMediaSize = mediaSizing?.initialSize ?? null;
  const nodeWidth = d.width || (generatorOnly ? 460 : 430);
  const nodeHeight = generatorOnly
    ? Math.max(VIDEO_GENERATOR_MIN_HEIGHT, d.height ?? VIDEO_GENERATOR_MIN_HEIGHT)
    : d.height || 280;
  const mediaAreaHeight = generatorOnly ? VIDEO_GENERATOR_HEADER_HEIGHT : nodeHeight;
  const referenceAccept = assetOnly
    ? "video/mp4,video/quicktime,video/webm"
    : d.model === "v3-motion-control"
    ? KLING_MOTION_REFERENCE_ACCEPT
    : d.model === "v3-omni"
    ? inputMode === "keyframes" ? KLING_OMNI_KEYFRAME_ACCEPT : KLING_OMNI_REFERENCE_ACCEPT
    : inputMode === "keyframes" ? VIDEO_KEYFRAME_ACCEPT : VIDEO_REFERENCE_ACCEPT;

  useEffect(() => {
    if (!assetOnly || running || mediaFrameRate || !playbackUrl?.startsWith("/api/media/")) return;
    const controller = new AbortController();
    void fetch(`/api/video/metadata?url=${encodeURIComponent(playbackUrl)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json() as Promise<{ width?: number; height?: number; frameRate?: number }>;
      })
      .then((metadata) => {
        if (!metadata?.frameRate) return;
        updateNode(id, {
          mediaWidth: metadata.width || mediaWidth,
          mediaHeight: metadata.height || mediaHeight,
          mediaFrameRate: metadata.frameRate,
        });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [assetOnly, id, mediaFrameRate, mediaHeight, mediaWidth, playbackUrl, running, updateNode]);

  const uploadReferenceFiles = async (files: File[] | FileList) => {
    if (running || isGeneratedResult) return;
    const parsedCandidates = Array.from(files)
      .map((file) => ({ file, kind: referenceKind(file) }))
      .filter((item): item is { file: File; kind: VideoReferenceKind } => Boolean(item.kind));
    if (assetOnly && (parsedCandidates.length !== 1 || parsedCandidates[0].kind !== "video")) {
      showToast("视频素材节点一次只能加载一个 MP4、MOV 或 WebM 视频", "error");
      return;
    }
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
        : d.model === "v3-omni" || d.model === "v3-motion-control"
          ? "请选择 PNG/JPG 图片或 MP4/MOV 视频"
          : "请选择 PNG/JPG/WebP、MP4/MOV 或 WAV/MP3 素材", "error");
      return;
    }

    const metadataByFile = new Map<File, Awaited<ReturnType<typeof inspectReferenceFile>>>();
    try {
      await Promise.all(candidates.map(async ({ file, kind }) => {
        metadataByFile.set(file, await inspectReferenceFile(file, kind, d.model, d.characterOrientation ?? "video"));
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
            ...(current?.sourceVideo?.id === assetId
              ? { sourceVideo: { ...current.sourceVideo, previewUrl } }
              : {}),
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
    const editableVideo = inputMode === "references" && !playbackUrl && !sourceVideo
      ? addedAssets.find((asset) => asset.kind === "video")
      : undefined;
    const fittedEditableVideo = editableVideo?.width && editableVideo.height
      ? fitMediaNodeSize(editableVideo.width, editableVideo.height, 520)
      : undefined;
    updateNode(id, {
      [assetField]: [...currentAssets, ...addedAssets],
      ...(editableVideo
        ? {
            sourceVideo: editableVideo,
            mediaWidth: editableVideo.width,
            mediaHeight: editableVideo.height,
            mediaFrameRate: editableVideo.frameRate,
            ...(assetOnly && fittedEditableVideo ? { ...fittedEditableVideo, mediaLayoutFitted: true } : {}),
          }
        : {}),
      ...(d.model === "v3-omni" && addedAssets.some((asset) => asset.kind === "video")
        ? {
            audioMode: "off",
            sound: false,
            keepOriginalSound: false,
            shotMode: d.referType === "base" ? "single" : configuredShotMode === "custom" ? "custom" : "auto",
            shotsEnabled: configuredShotMode === "custom" && d.referType !== "base",
          }
        : {}),
    });
    setRequestedFrameRole(null);
    if (!assetOnly) setComposerOpen(true);
    showToast(assetOnly ? "视频已加载" : inputMode === "keyframes" ? `已添加 ${addedAssets.length} 张帧图片` : `已添加 ${addedAssets.length} 个参考素材`, "success");
  };

  const removeReferenceAsset = (assetId: string) => {
    const assetField = inputMode === "keyframes" ? "keyframeAssets" : "referenceAssets";
    const asset = activeAssets.find((item) => item.id === assetId);
    if (asset?.localUrl?.startsWith("blob:")) URL.revokeObjectURL(asset.localUrl);
    if (asset?.localKey) void forgetVideoReferenceBlob(asset.localKey);
    revivedLocalKeysRef.current.delete(asset?.localKey ?? assetId);
    const removesEditableVideo = sourceVideo?.id === assetId;
    updateNode(id, {
      [assetField]: activeAssets.filter((asset) => asset.id !== assetId),
      ...(removesEditableVideo
        ? {
            sourceVideo: undefined,
            mediaWidth: undefined,
            mediaHeight: undefined,
            mediaFrameRate: undefined,
            clipStart: undefined,
            clipEnd: undefined,
          }
        : {}),
    });
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
      const sourceLocalUrl = current?.sourceVideo ? replacements.get(current.sourceVideo.id) : undefined;
      updateNode(id, {
        [assetField]: currentAssets.map((asset) => {
          const localUrl = replacements.get(asset.id);
          return localUrl ? { ...asset, localUrl } : asset;
        }),
        ...(sourceLocalUrl && current?.sourceVideo
          ? { sourceVideo: { ...current.sourceVideo, localUrl: sourceLocalUrl } }
          : {}),
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
    if ((!selected && !generatorOnly) || dragging || multipleNodesSelected) {
      primaryVideoRef.current?.pause();
      setTrimPreviewPlaying(false);
      setPopover("none");
      if (!generatorOnly) setComposerOpen(false);
      setFrameExtractorOpen(false);
      setTrimOpen(false);
    }
  }, [dragging, generatorOnly, multipleNodesSelected, selected]);

  useEffect(() => {
    setVideoDuration(0);
    setVideoCurrentTime(0);
  }, [playbackUrl]);

  useEffect(() => {
    if (!sourceVideo) return;
    const start = d.clipStart ?? sourceVideo.trimStart;
    const end = d.clipEnd ?? sourceVideo.trimEnd;
    if (!Number.isFinite(start) || !Number.isFinite(end)) return;
    const matchingAsset = referenceAssets.find((asset) => asset.id === sourceVideo.id);
    if (!matchingAsset || (matchingAsset.trimStart === start && matchingAsset.trimEnd === end)) return;
    updateNode(id, {
      referenceAssets: referenceAssets.map((asset) => asset.id === sourceVideo.id
        ? { ...asset, trimStart: start, trimEnd: end }
        : asset),
    });
  }, [d.clipEnd, d.clipStart, id, referenceAssets, sourceVideo, updateNode]);

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
      addNode("imageAsset", { x: absolutePosition.x + nodeWidth + 80, y: absolutePosition.y }, {
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
    updateNode(id, {
      sourceVideo: undefined,
      clipStart: undefined,
      clipEnd: undefined,
      mediaWidth: undefined,
      mediaHeight: undefined,
      mediaFrameRate: undefined,
      mediaLayoutFitted: false,
      referenceAssets: sourceVideo
        ? referenceAssets.filter((asset) => asset.id !== sourceVideo.id)
        : referenceAssets,
    });
    setTrimPreviewPlaying(false);
    setFrameExtractorOpen(false);
    setTrimOpen(false);
  }, [id, referenceAssets, sourceVideo, updateNode]);

  const openTrimEditor = useCallback(() => {
    const duration = videoDuration || sourceVideo?.duration || 0;
    const start = Math.max(0, d.clipStart ?? sourceVideo?.trimStart ?? 0);
    const end = Math.min(duration || Number.MAX_SAFE_INTEGER, d.clipEnd ?? sourceVideo?.trimEnd ?? duration);
    const nextOpen = !trimOpen;
    primaryVideoRef.current?.pause();
    setTrimPreviewPlaying(false);
    setTrimStart(start);
    setTrimEnd(end);
    setTrimOpen(nextOpen);
    setFrameExtractorOpen(false);
    setComposerOpen(false);
    if (nextOpen) seekVideo(start);
  }, [d.clipEnd, d.clipStart, seekVideo, sourceVideo?.duration, sourceVideo?.trimEnd, sourceVideo?.trimStart, trimOpen, videoDuration]);

  const toggleTrimPreview = useCallback(async () => {
    const video = primaryVideoRef.current;
    if (!video || !Number.isFinite(video.duration) || trimEnd <= trimStart) {
      showToast("视频片段尚未准备好", "error");
      return;
    }
    if (!video.paused) {
      video.pause();
      setTrimPreviewPlaying(false);
      return;
    }
    if (video.currentTime < trimStart || video.currentTime >= trimEnd - 0.03) {
      video.currentTime = trimStart;
      setVideoCurrentTime(trimStart);
    }
    try {
      await video.play();
      setTrimPreviewPlaying(true);
    } catch {
      showToast("浏览器暂时无法播放该视频片段", "error");
    }
  }, [showToast, trimEnd, trimStart]);

  const applyTrim = useCallback(() => {
    const duration = videoDuration || sourceVideo?.duration || 0;
    const start = Math.max(0, Math.min(trimStart, Math.max(0, duration - 0.05)));
    const end = Math.min(duration, Math.max(start + 0.05, trimEnd));
    if (!duration || end <= start) {
      showToast("请先等待视频时长加载完成", "error");
      return;
    }
    primaryVideoRef.current?.pause();
    setTrimPreviewPlaying(false);
    const trimmedSource = sourceVideo ? { ...sourceVideo, trimStart: start, trimEnd: end } : sourceVideo;
    updateNode(id, {
      clipStart: start,
      clipEnd: end,
      sourceVideo: trimmedSource,
      referenceAssets: sourceVideo
        ? referenceAssets.map((asset) => asset.id === sourceVideo.id ? { ...asset, trimStart: start, trimEnd: end } : asset)
        : referenceAssets,
    });
    seekVideo(start);
    setTrimOpen(false);
    showToast(`已裁剪为 ${formatVideoTime(start)}–${formatVideoTime(end)}`, "success");
  }, [id, referenceAssets, seekVideo, showToast, sourceVideo, trimEnd, trimStart, updateNode, videoDuration]);

  const trimDuration = Math.max(0.05, videoDuration || sourceVideo?.duration || 0.05);
  const trimStartPercent = Math.max(0, Math.min(100, (trimStart / trimDuration) * 100));
  const trimEndPercent = Math.max(trimStartPercent, Math.min(100, (trimEnd / trimDuration) * 100));
  const playheadPercent = Math.max(0, Math.min(100, (videoCurrentTime / trimDuration) * 100));

  const videoToolbar = (
    <div className="relative">
      <div className="flex w-max items-center gap-1 rounded-full border border-line bg-panel/95 p-1.5 shadow-[0_12px_34px_rgba(0,0,0,0.38)] backdrop-blur-xl">
        <button
          type="button"
          onClick={openTrimEditor}
          disabled={!playbackUrl}
          title={playbackUrl ? "裁剪视频" : "请先导入视频"}
          className={cn(
            "flex h-8 items-center gap-1.5 rounded-full px-3 text-[11px] transition-colors hover:bg-white/[0.07] hover:text-fg",
            trimOpen ? "bg-white/[0.09] text-fg" : "text-fg-dim",
            !playbackUrl && "cursor-not-allowed opacity-35 hover:bg-transparent hover:text-fg-dim",
          )}
        >
          <Icon name="Scissors" size={12} />
          裁剪
        </button>
      <button
        type="button"
        disabled={!playbackUrl}
        title={playbackUrl ? "提取当前视频帧" : "请先导入视频"}
        onClick={() => {
          primaryVideoRef.current?.pause();
          setTrimPreviewPlaying(false);
          setFrameExtractorOpen((open) => !open);
          setTrimOpen(false);
          setComposerOpen(false);
        }}
        className={cn(
          "flex h-8 items-center gap-1.5 rounded-full px-3 text-[11px] transition-colors hover:bg-white/[0.07] hover:text-fg",
          frameExtractorOpen ? "bg-white/[0.09] text-fg" : "text-fg-dim",
          !playbackUrl && "cursor-not-allowed opacity-35 hover:bg-transparent hover:text-fg-dim",
        )}
      >
        <Icon name="Image" size={12} />
        提取帧
      </button>
      </div>
    </div>
  );

  return (
    <NodeShell
      id={id}
      selected={selected}
      dragging={dragging}
      label={d.label}
      icon="FilmSlate"
      width={nodeWidth}
      height={nodeHeight}
      running={running}
      frameless
      portTop="50%"
      resizePolicy={mediaSizing?.resizePolicy}
      onResizeBegin={() => {
        primaryVideoRef.current?.pause();
        setTrimPreviewPlaying(false);
        setComposerOpen(false);
        setFrameExtractorOpen(false);
        setTrimOpen(false);
      }}
      toolbar={assetOnly && playbackUrl && selected && !dragging && !multipleNodesSelected && !running ? videoToolbar : undefined}
      headerMeta={mediaMeta}
      showHeaderActions={false}
    >
      <div
        data-body
        style={{ height: mediaAreaHeight }}
        className={cn(
          "relative flex cursor-pointer items-center justify-center overflow-hidden border bg-panel transition-[border-color,box-shadow] duration-200",
          generatorOnly
            ? "min-h-[94px] rounded-t-[14px] rounded-b-none border-b-transparent bg-[linear-gradient(135deg,rgba(255,255,255,.035),rgba(255,255,255,.012))]"
            : fittedMediaSize ? "min-h-0 rounded-[12px]" : "min-h-[240px] rounded-[12px]",
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
          if (isGeneratedResult || generatorOnly || selectionModifierPressed || isMultiSelectClick(event) || dragging) return;
          const target = event.target as HTMLElement;
          if (target.closest("button, video, input")) return;
          setFrameExtractorOpen(false);
          referenceFileRef.current?.click();
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

        {generatorOnly ? (
          <div className="flex w-full items-center gap-3 px-4 text-left">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] border border-white/[0.09] bg-white/[0.035] text-fg-dim">
              <Icon name="VideoCamera" size={18} weight="duotone" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[12px] font-medium text-fg">编排动作、镜头与声音</span>
              <span className="mt-1 block truncate text-[10px] text-fg-mute">
                {referenceCounts.image + referenceCounts.video + referenceCounts.audio
                  ? `已连接 ${referenceCounts.image} 图 · ${referenceCounts.video} 视频 · ${referenceCounts.audio} 音频`
                  : "可连接图片、视频素材或文本作为输入"}
              </span>
            </span>
          </div>
        ) : playbackUrl ? (
          <>
          <video
            ref={primaryVideoRef}
            src={playbackUrl}
            controls
            playsInline
            preload="metadata"
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              setVideoDuration(Number.isFinite(video.duration) ? video.duration : 0);
              const start = Math.max(0, d.clipStart ?? sourceVideo?.trimStart ?? 0);
              if (start > 0 && video.currentTime < start) video.currentTime = start;
              setVideoCurrentTime(video.currentTime || start);
              const width = video.videoWidth;
              const height = video.videoHeight;
              const patch: Partial<VideoNodeData> = { mediaWidth: width, mediaHeight: height };
              if (sourceVideo) patch.sourceVideo = { ...sourceVideo, width, height, duration: video.duration };
              const shouldFitLayout = assetOnly && !d.mediaLayoutFitted && Boolean(width && height);
              if (shouldFitLayout) {
                Object.assign(patch, fitMediaNodeSize(width, height, 520), { mediaLayoutFitted: true });
              }
              if (width && height && (shouldFitLayout || mediaWidth !== width || mediaHeight !== height || sourceVideo?.duration !== video.duration)) updateNode(id, patch);
            }}
            onDurationChange={(event) => {
              const duration = event.currentTarget.duration;
              if (Number.isFinite(duration)) setVideoDuration(duration);
            }}
            onPlay={(event) => {
              const start = Math.max(0, trimOpen ? trimStart : d.clipStart ?? sourceVideo?.trimStart ?? 0);
              const end = trimOpen ? trimEnd : d.clipEnd ?? sourceVideo?.trimEnd;
              if (event.currentTarget.currentTime < start || (end && event.currentTarget.currentTime >= end)) event.currentTarget.currentTime = start;
              if (trimOpen) setTrimPreviewPlaying(true);
            }}
            onPause={() => setTrimPreviewPlaying(false)}
            onTimeUpdate={(event) => {
              const video = event.currentTarget;
              const start = Math.max(0, trimOpen ? trimStart : d.clipStart ?? sourceVideo?.trimStart ?? 0);
              const end = trimOpen ? trimEnd : d.clipEnd ?? sourceVideo?.trimEnd;
              if (end && video.currentTime >= end - 0.015) {
                video.pause();
                video.currentTime = start;
                setTrimPreviewPlaying(false);
              }
              setVideoCurrentTime(video.currentTime);
            }}
            title="播放视频"
            className="h-full w-full bg-black object-contain"
          />
          </>
        ) : previewImage ? (
          <>
            <img src={previewImage} alt="视频参考图" className="h-full w-full object-contain opacity-70" draggable={false} />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-ink/55 via-transparent to-transparent" />
            <div className="pointer-events-none absolute bottom-3 left-3 flex items-center gap-1.5 rounded-full border border-white/14 bg-ink/78 px-2.5 py-1.5 text-[10px] text-fg-dim backdrop-blur-md">
              <Icon name={inputMode === "keyframes" ? "Image" : "Paperclip"} size={11} className="text-accent" />
              {inputMode === "keyframes"
                ? `首尾帧 ${keyframeAssets.length}/2`
                : `参考素材 ${referenceCounts.image + referenceCounts.video + referenceCounts.audio}`}
            </div>
          </>
        ) : isGeneratedResult ? (
          <div className="flex flex-col items-center gap-2 px-8 py-10 text-center text-fg-dim">
            <span className="flex h-12 w-12 items-center justify-center rounded-full border border-white/10 bg-white/[0.04]">
              <Icon name="VideoCamera" size={22} />
            </span>
            <span className="text-[12px]">等待视频结果</span>
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
            <span className="text-fg-dim">{assetOnly ? "点击或拖入视频" : "点击配置视频生成"}</span>
            <span className="text-[10px] text-fg-mute/70">
              {assetOnly
                ? "MP4 · MOV · WEBM"
                : inputMode === "keyframes"
                ? "可直接拖入首帧和尾帧图片"
                : d.model === "v3-omni" || d.model === "v3-motion-control"
                  ? "可直接拖入 JPG/PNG 图片或 MP4/MOV 视频"
                  : "可直接拖入图片、视频或音频作为参考"}
            </span>
          </div>
        )}

        {running ? <RunningVeil progress={d.progress} label="视频生成中，通常需要几分钟…" /> : null}

        {failure ? (
          <div
            role="alert"
            aria-live="polite"
            className="absolute inset-0 z-10 flex items-center justify-center bg-panel/95 p-4 text-center backdrop-blur-[2px]"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="nodrag flex h-[210px] w-[360px] max-h-full max-w-full flex-col items-center justify-center">
              <span className="mb-2 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-danger/10 text-danger shadow-[0_8px_30px_rgba(255,86,86,0.08)]">
                <Icon name="Warning" size={18} />
              </span>
              <span className="text-[13px] font-medium text-fg">视频生成失败</span>
              <span className="mt-1 line-clamp-2 h-[36px] w-full text-[11px] leading-[18px] text-fg-mute">
                {failure.message}
              </span>
              <p
                title={failure.raw}
                className="mt-2 line-clamp-3 h-[48px] w-full overflow-hidden break-all text-[9px] leading-[16px] text-fg-mute/75"
              >
                {failure.raw}
              </p>
              <div className="mt-2 flex h-7 items-center gap-2">
                {failure.status ? <span className="font-mono text-[9px] text-danger/75">HTTP {failure.status}</span> : null}
                <button
                  type="button"
                  onClick={(event) => void copyFailureDetail(event)}
                  className="flex h-7 items-center gap-1.5 rounded-full bg-white/[0.05] px-3 text-[10px] text-fg-dim transition-colors hover:bg-white/[0.09] hover:text-fg"
                >
                  <Icon name={errorCopied ? "Check" : "Copy"} size={11} />
                  {errorCopied ? "完整错误已复制" : "复制完整错误"}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {sourceVideo && !running && !isGeneratedResult ? (
          <div className="nodrag absolute right-2 top-2 z-10 flex gap-1 opacity-0 transition-opacity group-hover/node:opacity-100">
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

      {trimOpen && selected && !dragging && !multipleNodesSelected && playbackUrl ? (
        <div
          role="dialog"
          aria-label="视频裁剪"
          className="relative left-1/2 z-[40] mt-3 w-[calc(100%+120px)] -translate-x-1/2 rounded-[16px] border border-line bg-card p-3.5 shadow-[0_18px_50px_rgba(0,0,0,0.3)] nodrag"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <div className="text-[11px] font-medium text-fg">裁剪视频</div>
              <div className="mt-0.5 text-[9px] text-fg-mute">拖动端点选择片段，可在应用前直接预览播放</div>
            </div>
            <button
              type="button"
              title="关闭裁剪"
              onClick={() => {
                primaryVideoRef.current?.pause();
                setTrimPreviewPlaying(false);
                setTrimOpen(false);
              }}
              className="rounded p-1 text-fg-mute hover:bg-white/[0.06] hover:text-fg"
            >
              <Icon name="X" size={12} />
            </button>
          </div>

          <div className="mb-3 flex gap-1.5">
            {[5, 10, 15].map((seconds) => (
              <button
                key={seconds}
                type="button"
                onClick={() => {
                  primaryVideoRef.current?.pause();
                  setTrimPreviewPlaying(false);
                  const nextEnd = Math.min(trimDuration, trimStart + seconds);
                  setTrimEnd(nextEnd);
                  seekVideo(trimStart);
                }}
                className="h-7 flex-1 rounded-full border border-line bg-white/[0.025] text-[10px] text-fg-dim hover:border-white/25 hover:text-fg"
              >
                {seconds}s
              </button>
            ))}
          </div>

          <div className="rounded-[12px] border border-line bg-ink/55 px-3 pb-2.5 pt-3">
            <div className="relative h-9">
              <div className="absolute inset-x-0 top-[14px] h-1.5 rounded-full bg-white/[0.08]" />
              <div
                className="absolute top-[14px] h-1.5 rounded-full bg-accent/75 shadow-[0_0_12px_rgba(98,181,255,.2)]"
                style={{ left: `${trimStartPercent}%`, right: `${100 - trimEndPercent}%` }}
              />
              <div className="pointer-events-none absolute top-[8px] h-[18px] w-px bg-white/70" style={{ left: `${playheadPercent}%` }} />
              <input
                aria-label="裁剪开始时间"
                type="range"
                min={0}
                max={trimDuration}
                step={0.05}
                value={Math.min(trimStart, trimDuration)}
                onChange={(event) => {
                  primaryVideoRef.current?.pause();
                  setTrimPreviewPlaying(false);
                  const next = Math.min(Number(event.target.value), Math.max(0, trimEnd - 0.05));
                  setTrimStart(next);
                  seekVideo(next);
                }}
                className="tf-trim-range tf-trim-range--start absolute inset-x-0 top-0 h-8 w-full"
              />
              <input
                aria-label="裁剪结束时间"
                type="range"
                min={0}
                max={trimDuration}
                step={0.05}
                value={Math.min(Math.max(trimEnd, 0.05), trimDuration)}
                onChange={(event) => {
                  primaryVideoRef.current?.pause();
                  setTrimPreviewPlaying(false);
                  const next = Math.max(Number(event.target.value), trimStart + 0.05);
                  setTrimEnd(next);
                  seekVideo(Math.max(trimStart, next - 0.03));
                }}
                className="tf-trim-range tf-trim-range--end absolute inset-x-0 top-0 h-8 w-full"
              />
            </div>
            <div className="flex items-center justify-between text-[10px] tabular-nums text-fg-dim">
              <span>{formatVideoTime(trimStart)}</span>
              <span className="rounded-full bg-white/[0.055] px-2 py-0.5 text-[9px] text-fg-mute">片段 {Math.max(0, trimEnd - trimStart).toFixed(2)}s</span>
              <span>{formatVideoTime(trimEnd)}</span>
            </div>
          </div>

          <div className="mt-3 flex items-center gap-2 border-t border-line pt-3">
            <button
              type="button"
              onClick={() => {
                primaryVideoRef.current?.pause();
                setTrimPreviewPlaying(false);
                updateNode(id, {
                  clipStart: undefined,
                  clipEnd: undefined,
                  sourceVideo: sourceVideo ? { ...sourceVideo, trimStart: undefined, trimEnd: undefined } : sourceVideo,
                  referenceAssets: sourceVideo
                    ? referenceAssets.map((asset) => asset.id === sourceVideo.id ? { ...asset, trimStart: undefined, trimEnd: undefined } : asset)
                    : referenceAssets,
                });
                setTrimStart(0);
                setTrimEnd(videoDuration);
                seekVideo(0);
              }}
              className="text-[10px] text-fg-mute hover:text-fg"
            >
              清除裁剪
            </button>
            <button
              type="button"
              disabled={!videoDuration || trimEnd <= trimStart}
              onClick={() => void toggleTrimPreview()}
              className={cn(
                "ml-auto flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-[11px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-35",
                trimPreviewPlaying
                  ? "border-white/20 bg-white/[0.1] text-fg hover:bg-white/[0.14]"
                  : "border-line-2 bg-white/[0.04] text-fg-dim hover:bg-white/[0.08] hover:text-fg",
              )}
            >
              <Icon name={trimPreviewPlaying ? "Pause" : "Play"} size={12} weight="fill" />
              {trimPreviewPlaying ? "暂停预览" : "播放片段"}
            </button>
            <button type="button" onClick={applyTrim} className="h-8 rounded-full bg-fg px-4 text-[10px] font-medium text-ink hover:bg-white">应用裁剪</button>
          </div>
        </div>
      ) : null}

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

      {!isGeneratedResult && (generatorOnly || (composerOpen && selected && !dragging)) && !multipleNodesSelected ? (
        <div
          role="dialog"
          aria-label="视频生成设置"
          className={cn(
            "relative left-1/2 z-[40] -translate-x-1/2 border border-line bg-card p-3.5 shadow-[0_18px_50px_rgba(0,0,0,0.24)] nodrag",
            generatorOnly ? "mt-0 flex w-full flex-col rounded-b-[14px] rounded-t-none" : "mt-3 w-[calc(100%+192px)] rounded-[18px]",
          )}
          style={generatorOnly ? { height: nodeHeight - VIDEO_GENERATOR_HEADER_HEIGHT } : undefined}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="mb-3 flex items-center gap-2">
            {motionControl ? (
              <div className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-white/[0.06] px-3 text-[10px] text-fg-dim">
                <Icon name="VideoCamera" size={11} /> 动作控制素材
              </div>
            ) : (
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
            )}
            {inputMode === "references" ? (
              <button
                type="button"
                disabled={running}
                onClick={() => {
                  setRequestedFrameRole(null);
                  referenceFileRef.current?.click();
                }}
                className="ml-auto flex h-7 items-center gap-1.5 rounded-full border border-line bg-white/[0.03] px-2.5 text-[10px] text-fg-dim transition-colors hover:border-line-2 hover:text-fg disabled:pointer-events-none disabled:opacity-40"
              >
                <Icon name="Plus" size={11} weight="bold" />
                添加参考素材
              </button>
            ) : null}
          </div>

          {inputMode === "keyframes" ? (
            <div className="mb-2 flex items-center justify-center gap-2 rounded-[10px] border border-line bg-ink/25 p-2">
              {([
                { role: "first_frame", label: "首帧" },
                { role: "last_frame", label: "尾帧" },
              ] as const).map((slot, index) => {
                const asset = slot.role === "first_frame" ? firstFrame : lastFrame;
                const manuallyAdded = asset && keyframeAssets.some((item) => item.id === asset.id);
                return (
                  <div key={slot.role} className="contents">
                    {index ? <Icon name="ArrowRight" size={11} className="shrink-0 text-fg-mute/45" /> : null}
                    <div className="group/reference relative h-[62px] w-[82px] shrink-0 overflow-hidden rounded-[8px] border border-white/10 bg-ink">
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
                          className="flex h-full w-full flex-col items-center justify-center gap-1 text-fg-mute transition-colors hover:bg-white/[0.035] hover:text-fg-dim disabled:pointer-events-none disabled:opacity-40"
                        >
                          <Icon name="Plus" size={12} />
                          <span className="text-[9px]">{slot.label}</span>
                        </button>
                      )}
                      {asset ? <span className="pointer-events-none absolute bottom-1 left-1 rounded-full bg-ink/78 px-1.5 py-0.5 font-mono text-[8px] text-fg-dim backdrop-blur">{promptReferenceByKey.get(asset.id)?.token ?? slot.label}</span> : null}
                      {manuallyAdded ? (
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
          ) : !generatorOnly && (referenceAssets.length || connectedImageAssets.length || connectedVideoAssets.length) ? (
            <div className="nowheel mb-3 flex gap-2 overflow-x-auto rounded-[12px] border border-line bg-ink/30 p-2.5">
              {referenceAssets.map((asset) => (
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
                    {promptReferenceByKey.get(asset.id)?.token
                      ?? (asset.kind === "image" ? "参考图" : asset.kind === "video" ? "参考视频" : "参考音频")}
                    {asset.kind === "video" && asset.trimEnd != null ? ` · ${(asset.trimEnd - (asset.trimStart ?? 0)).toFixed(2)}s` : ""}
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
              {connectedImageAssets.map((asset) => (
                <div key={asset.id} className="relative h-[82px] w-[96px] shrink-0 overflow-hidden rounded-[10px] border border-accent/25 bg-panel-2">
                  <img src={asset.url} alt={asset.name} className="h-full w-full object-cover" draggable={false} />
                  <span className="pointer-events-none absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-full border border-accent/20 bg-ink/82 px-1.5 py-0.5 text-[8px] text-accent backdrop-blur">
                    <Icon name="ShareNetwork" size={8} /> <span className="font-mono">{promptReferenceByKey.get(asset.id)?.token ?? "连线参考"}</span>
                  </span>
                </div>
              ))}
              {connectedVideoAssets.map((asset) => (
                <div key={asset.id} className="relative h-[82px] w-[96px] shrink-0 overflow-hidden rounded-[10px] border border-accent/25 bg-panel-2">
                  {asset.previewUrl ? (
                    <img src={asset.previewUrl} alt={`${asset.name} 首帧`} className="h-full w-full object-cover" draggable={false} />
                  ) : (
                    <video src={asset.localUrl ?? asset.url} muted playsInline className="pointer-events-none h-full w-full object-cover" />
                  )}
                  <span className="pointer-events-none absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-full border border-accent/20 bg-ink/82 px-1.5 py-0.5 text-[8px] text-accent backdrop-blur">
                    <Icon name="ShareNetwork" size={8} /> <span className="font-mono">{promptReferenceByKey.get(asset.id)?.token ?? "连线视频"}</span>
                  </span>
                </div>
              ))}
            </div>
          ) : null}

          {d.model !== "v3-omni" && supportsShots(d.model) ? (
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[9px] text-fg-mute">提示词模式</span>
              <Chip
                active={shotsEnabled}
                onClick={() => updateNode(id, {
                  shotMode: shotsEnabled ? "single" : "custom",
                  shotModeExplicit: true,
                  shotsEnabled: !shotsEnabled,
                  shots: shots.length ? shots : defaultShots(d.duration),
                })}
              >
                <Icon name="Scissors" size={10} /> 分镜
              </Chip>
            </div>
          ) : null}

          {shotsEnabled ? (
            <ShotEditor data={{ ...d, shots }} nodeId={id} references={promptReferences} />
          ) : (
            <PromptMentionTextarea
              value={d.prompt}
              onValueChange={(nextValue) => updateNode(id, { prompt: nextValue })}
              references={promptReferences}
              onSubmit={() => {
                if (!sendDisabled) void generateVideo(id);
              }}
              placeholder={promptReferences.length
                ? "描述画面如何运动；输入 @ 可精确引用参考图、视频或音频"
                : "描述画面如何运动，如：镜头缓缓推近，人物转身微笑，衣摆随风轻摆"}
              rows={3}
              className={cn(
                "tf-composer-prompt nodrag nowheel h-full min-h-[72px] w-full overflow-y-auto rounded-[12px] border border-white/[0.09] bg-white/[0.028] px-3 py-2.5 text-[13px] leading-relaxed text-fg outline-none transition-[border-color,background-color,box-shadow] placeholder:text-fg-mute hover:border-white/[0.14] hover:bg-white/[0.038] focus:border-white/[0.2] focus:bg-white/[0.045] focus:shadow-[0_0_0_3px_rgba(255,255,255,0.025)]",
                generatorOnly ? "resize-none" : "max-h-[220px] resize-y",
                "cursor-text",
              )}
              overlayClassName="px-3 py-2.5 text-[13px] leading-relaxed"
              wrapperClassName={cn("mb-3 min-h-[72px]", generatorOnly && "flex-1")}
            />
          )}

          {!isSeedanceModel(d.model) && d.model !== "v3-omni" && d.model !== "v3-motion-control" ? (
            <ImeSafeTextarea
              value={d.negativePrompt ?? ""}
              onValueChange={(nextValue) => updateNode(id, { negativePrompt: nextValue })}
              placeholder="负向提示词（可选）：不希望出现的内容"
              rows={1}
              className="nowheel mb-3 min-h-[34px] w-full resize-y rounded-[9px] border border-line bg-ink/25 px-2.5 py-2 text-[10px] leading-relaxed text-fg outline-none placeholder:text-fg-mute focus:border-line-2"
              spellCheck={false}
            />
          ) : null}

          <div className={cn("flex shrink-0 items-center justify-between gap-1", generatorOnly && "mt-auto pt-3")}>
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
                          if (!supportsShots(model.value)) {
                            patch.shotMode = "single";
                            patch.shotsEnabled = false;
                          }
                          if (model.value === "v3-omni") {
                            patch.audioMode = "off";
                            patch.sound = false;
                            patch.keepOriginalSound = false;
                            patch.shotMode = "auto";
                            patch.shotModeExplicit = false;
                            patch.shotsEnabled = false;
                            if (d.aspectRatio === "智能" && !firstFrame && !referenceCounts.video) patch.aspectRatio = "16:9";
                          }
                          if (model.value === "v3-motion-control") {
                            patch.inputMode = "references";
                            patch.audioMode = "off";
                            patch.sound = false;
                            patch.keepOriginalSound = false;
                            patch.characterOrientation = d.characterOrientation ?? "video";
                            patch.shotMode = "single";
                            patch.shotsEnabled = false;
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
                {popover === "params" ? (
                  <VideoParamPopover
                    data={d}
                    nodeId={id}
                    hasConnectedVideo={upstreamVideoCount > 0}
                    onClose={() => setPopover("none")}
                  />
                ) : null}
                <button
                  type="button"
                  onClick={() => setPopover(popover === "params" ? "none" : "params")}
                  title={paramSummary}
                  className="flex h-8 min-w-0 items-center gap-1 truncate rounded-full border border-line bg-panel-2/95 px-3 text-[11px] text-fg-dim transition-colors hover:border-line-2 hover:text-fg"
                >
                  <span className="truncate">{paramSummary}</span>
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
