"use client";

// 图片节点 — the workhorse. Card shows empty-state hints / the generated
// image / upload preview; a composer docked under the card carries prompt,
// model picker, 比例·画质·张数 popover, style preset, and submit (libTV-style).

import { memo, useEffect, useRef, useState } from "react";
import { useReactFlow, type NodeProps } from "@xyflow/react";
import type { AppNode } from "@/lib/store";
import { useStudio } from "@/lib/store";
import { MAX_IMAGE_REFERENCES, type ImageNodeData, type ModelName, type Quality, type Resolution } from "@/lib/types";
import {
  ASPECT_RATIOS,
  GPT_IMAGE_2_RATIOS,
  MODELS,
  QUALITY_OPTIONS,
  STYLE_PRESETS,
  comboError,
  modelLabel,
  resolutionsFor,
} from "@/lib/models";
import { cn, fileToDataURL, progressStageLabel } from "@/lib/utils";
import { Icon } from "../icons";
import { BrushEditor, CropEditor, StickerEditor } from "../ImageEditors";
import { NodeShell, RunningVeil } from "./NodeShell";
import { Chip } from "../ui";

const isImageFile = (file: File) =>
  file.type.startsWith("image/") || /\.(?:png|jpe?g|webp)$/i.test(file.name);

const PROMPT_MIN_HEIGHT = 60;
const PROMPT_MAX_HEIGHT = 240;
const IMAGE_COUNT_OPTIONS = Array.from({ length: 9 }, (_, index) => index + 1);

const resizePromptTextarea = (textarea: HTMLTextAreaElement) => {
  textarea.style.height = "0px";
  const nextHeight = Math.min(PROMPT_MAX_HEIGHT, Math.max(PROMPT_MIN_HEIGHT, textarea.scrollHeight));
  textarea.style.height = `${nextHeight}px`;
  return nextHeight;
};

function ParamPopover({ data, nodeId, onClose }: { data: ImageNodeData; nodeId: string; onClose: () => void }) {
  const updateNode = useStudio((s) => s.updateNode);
  const set = (patch: Partial<ImageNodeData>) => updateNode(nodeId, patch);
  const isGpt = data.model === "GPT Image 2";
  const ratios = ASPECT_RATIOS.filter((r) => !isGpt || GPT_IMAGE_2_RATIOS.includes(r));

  return (
    <div
      className="glass popover-enter absolute bottom-full left-0 z-30 mb-2 w-[340px] origin-bottom-left rounded-panel p-4"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-medium text-fg-mute">生成参数</span>
        <button type="button" onClick={onClose} className="rounded p-1 text-fg-mute hover:text-fg">
          <Icon name="X" size={12} />
        </button>
      </div>

      {isGpt ? (
        <>
          <div className="mb-1.5 text-[11px] text-fg-mute">画质</div>
          <div className="mb-3 flex gap-1.5">
            {QUALITY_OPTIONS.map((q) => (
              <Chip key={q.value} active={data.quality === q.value} onClick={() => set({ quality: q.value as Quality })}>
                {q.label}
              </Chip>
            ))}
          </div>
        </>
      ) : null}

      <div className="mb-1.5 text-[11px] text-fg-mute">清晰度</div>
      <div className="mb-3 flex gap-1.5">
        {resolutionsFor(data.model).map((r) => (
          <Chip key={r} active={data.resolution === r} onClick={() => set({ resolution: r as Resolution })}>
            {r}
          </Chip>
        ))}
      </div>

      <div className="mb-1.5 text-[11px] text-fg-mute">比例</div>
      <div className="mb-3 grid grid-cols-5 gap-1.5">
        {ratios.map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => set({ aspectRatio: r })}
            className={cn(
              "flex h-11 flex-col items-center justify-center gap-0.5 rounded-control border text-[10px] transition-all",
              data.aspectRatio === r
                ? "border-accent/60 bg-accent/10 text-accent"
                : "border-line bg-white/[0.02] text-fg-dim hover:border-line-2",
            )}
          >
            <RatioGlyph ratio={r} />
            {r === "auto" ? "智能" : r}
          </button>
        ))}
      </div>

      <div className="mb-1.5 text-[11px] text-fg-mute">生成数量</div>
      <div className="mb-3 grid grid-cols-9 gap-1">
        {IMAGE_COUNT_OPTIONS.map((count) => (
          <button
            key={count}
            type="button"
            aria-label={`生成 ${count} 张`}
            aria-pressed={data.count === count}
            onClick={() => set({ count })}
            className={cn(
              "flex h-8 items-center justify-center rounded-[8px] border text-[10px] tabular-nums transition-colors",
              data.count === count
                ? "border-accent/55 bg-accent/12 text-accent"
                : "border-line bg-white/[0.02] text-fg-dim hover:border-line-2 hover:bg-white/[0.05] hover:text-fg",
            )}
          >
            {count}
          </button>
        ))}
      </div>

      <div className="mb-1.5 text-[11px] text-fg-mute">计费</div>
      <div className="flex gap-1.5">
        {(["特价", "官方"] as const).map((b) => (
          <Chip key={b} active={data.billing === b} onClick={() => set({ billing: b })}>
            {b}
          </Chip>
        ))}
      </div>
    </div>
  );
}

function RatioGlyph({ ratio }: { ratio: string }) {
  if (ratio === "auto") return <Icon name="Sparkle" size={11} />;
  const [w, h] = ratio.split(":").map(Number);
  const max = 14;
  const scale = max / Math.max(w, h);
  return (
    <span
      className="block rounded-[2px] border border-current"
      style={{ width: Math.max(4, w * scale), height: Math.max(4, h * scale) }}
    />
  );
}

function ModelPopover({ data, nodeId, onClose }: { data: ImageNodeData; nodeId: string; onClose: () => void }) {
  const updateNode = useStudio((s) => s.updateNode);
  return (
    <div
      className="glass popover-enter absolute bottom-full left-0 z-30 mb-2 w-[300px] origin-bottom-left rounded-panel p-2"
      onMouseDown={(e) => e.stopPropagation()}
    >
      {MODELS.map((m) => (
        <button
          key={m.name}
          type="button"
          onClick={() => {
            const patch: Partial<ImageNodeData> = { model: m.name as ModelName };
            if (!m.resolutions.includes(data.resolution)) patch.resolution = m.resolutions[Math.min(1, m.resolutions.length - 1)];
            if (m.name === "GPT Image 2" && !GPT_IMAGE_2_RATIOS.includes(data.aspectRatio)) patch.aspectRatio = "auto";
            updateNode(nodeId, patch);
            onClose();
          }}
          className={cn(
            "group/model flex w-full flex-col items-start rounded-control px-3 py-2.5 text-left transition-colors",
            data.model === m.name ? "bg-accent/10 text-accent" : "text-fg hover:bg-white/5",
          )}
        >
          <span className="text-[13px] font-medium">{m.label}</span>
          <span className="model-option__blurb grid text-[11px] text-fg-mute">
            <span className="overflow-hidden">{m.blurb}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function StylePopover({ data, nodeId, onClose }: { data: ImageNodeData; nodeId: string; onClose: () => void }) {
  const updateNode = useStudio((s) => s.updateNode);
  return (
    <div
      className="glass popover-enter absolute bottom-full left-0 z-30 mb-2 w-[260px] origin-bottom-left rounded-panel p-2"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="px-2 pb-1 pt-1 text-[11px] font-medium text-fg-mute">风格预设 · TFvision</div>
      {STYLE_PRESETS.map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => {
            updateNode(nodeId, { styleId: s.id });
            onClose();
          }}
          className={cn(
            "flex w-full flex-col rounded-control px-3 py-2 text-left transition-colors",
            data.styleId === s.id ? "bg-accent/10 text-accent" : "text-fg hover:bg-white/5",
          )}
        >
          <span className="text-[13px]">{s.label}</span>
          <span className="text-[11px] text-fg-mute">{s.hint}</span>
        </button>
      ))}
    </div>
  );
}

function GeneratedImageResult({
  id,
  selected,
  data,
}: {
  id: string;
  selected?: boolean;
  data: ImageNodeData;
}) {
  const cancelImageGeneration = useStudio((s) => s.cancelImageGeneration);
  const nodeWidth = data.width || 470;
  const nodeHeight = data.height ?? nodeWidth;
  const urls = data.urls.length ? data.urls : data.url ? [data.url] : [];
  const running = data.status === "running";

  return (
    <NodeShell
      id={id}
      selected={selected}
      label={data.label}
      icon="Sparkle"
      width={nodeWidth}
      height={nodeHeight}
      running={running}
      showHeaderActions={!running}
      showDuplicateAction={data.status === "success"}
      frameless
      portTop={nodeHeight / 2}
      resizeHandleTop={Math.max(8, nodeHeight - 32)}
    >
      <div
        data-body
        style={{ height: nodeHeight }}
        className={cn(
          "tf-result-node-enter relative flex min-h-[264px] items-center justify-center overflow-hidden rounded-[12px] border bg-panel transition-[border-color,box-shadow] duration-200",
          selected
            ? "border-white/30 shadow-[0_18px_50px_rgba(0,0,0,0.3)]"
            : "border-line hover:border-line-2",
        )}
      >
        {running ? (
          <div role="status" aria-label="图片生成中" className="absolute inset-0 flex flex-col items-center justify-center overflow-hidden bg-ink-2">
            <div className="pointer-events-none absolute inset-0 tf-generation-grid" />
            <div className="pointer-events-none absolute inset-0 overflow-hidden">
              <div className="scan-sweep absolute inset-x-0 h-1/2 opacity-70" />
            </div>
            <div className="tf-generation-orbit relative mb-5 flex h-24 w-24 items-center justify-center rounded-full border border-white/10">
              <div className="absolute inset-[9px] rounded-full border border-dashed border-white/15" />
              <Icon name="Sparkle" size={24} className="text-fg" weight="duotone" />
            </div>
            <div className="relative text-[28px] font-semibold tabular-nums tracking-[-0.04em] text-fg">
              {Math.round(data.progress)}<span className="ml-0.5 text-[14px] font-normal text-fg-mute">%</span>
            </div>
            <div className="relative mt-1 text-[11px] tracking-[0.08em] text-fg-dim">
              {progressStageLabel(data.progress)}
            </div>
            <button
              type="button"
              aria-label="取消生成"
              onClick={(event) => {
                event.stopPropagation();
                cancelImageGeneration(id);
              }}
              className="nodrag relative mt-5 flex h-8 items-center gap-1.5 rounded-full border border-white/12 bg-white/[0.04] px-3 text-[11px] text-fg-dim transition-colors hover:border-white/25 hover:bg-white/[0.08] hover:text-fg"
            >
              <Icon name="X" size={11} weight="bold" />
              取消生成
            </button>
          </div>
        ) : data.status === "success" && urls.length ? (
          <>
            {urls.length === 1 ? (
              <img src={urls[0]} alt="生成结果" className="h-full w-full object-contain" draggable={false} />
            ) : (
              <div className={cn("absolute inset-1.5 grid gap-1.5", urls.length <= 4 ? "grid-cols-2" : "grid-cols-3")}>
                {urls.map((url, index) => (
                  <div key={`${index}-${url.slice(0, 24)}`} className="min-h-0 overflow-hidden rounded-[8px] bg-ink">
                    <img src={url} alt={`生成结果 ${index + 1}`} className="h-full w-full object-cover" draggable={false} />
                  </div>
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="flex max-w-[78%] flex-col items-center text-center">
            <span className={cn(
              "mb-3 flex h-11 w-11 items-center justify-center rounded-full border",
              data.status === "cancelled"
                ? "border-white/10 bg-white/[0.04] text-fg-mute"
                : "border-danger/20 bg-danger/10 text-danger",
            )}>
              <Icon name={data.status === "cancelled" ? "X" : "Warning"} size={18} />
            </span>
            <span className="text-[13px] font-medium text-fg">
              {data.status === "cancelled" ? "生成已取消" : "生成失败"}
            </span>
            <span className="mt-1.5 text-[11px] leading-relaxed text-fg-mute">
              {data.status === "cancelled" ? "本节点已停止等待结果，可从原节点重新提交。" : data.error || "请从原节点重新提交。"}
            </span>
          </div>
        )}
      </div>
    </NodeShell>
  );
}

export const ImageNode = memo(function ImageNode({ id, selected, dragging, data }: NodeProps<AppNode>) {
  const d = data as ImageNodeData;
  const updateNode = useStudio((s) => s.updateNode);
  const generateImage = useStudio((s) => s.generateImage);
  const showToast = useStudio((s) => s.showToast);
  const edges = useStudio((s) => s.edges);
  const nodes = useStudio((s) => s.nodes);
  const fileRef = useRef<HTMLInputElement>(null);
  const stickerFileRef = useRef<HTMLInputElement>(null);
  const modelAreaRef = useRef<HTMLDivElement>(null);
  const paramAreaRef = useRef<HTMLDivElement>(null);
  const styleAreaRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const promptHeightRef = useRef(PROMPT_MIN_HEIGHT);
  const promptValueRef = useRef(d.prompt);
  const promptMeasuredRef = useRef(false);
  const persistedPromptHeightRef = useRef(d.promptHeight);
  const [popover, setPopover] = useState<"none" | "params" | "model" | "style">("none");
  const [fileDragActive, setFileDragActive] = useState(false);
  const [focusedImageIndex, setFocusedImageIndex] = useState<number | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [editor, setEditor] = useState<"none" | "crop" | "sticker" | "brush">("none");
  const [stickerSrc, setStickerSrc] = useState<string | null>(null);
  const rf = useReactFlow();

  const submitGeneration = async () => {
    const resultNodeId = await generateImage(id);
    if (!resultNodeId) return;
    window.setTimeout(() => {
      void rf.fitView({ nodes: [{ id }, { id: resultNodeId }], padding: 0.16, maxZoom: 1, duration: 520 });
    }, 80);
  };

  useEffect(() => {
    if (popover === "none") return;

    const activeArea =
      popover === "model" ? modelAreaRef.current : popover === "params" ? paramAreaRef.current : styleAreaRef.current;
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
    if (!selected || dragging) {
      setPopover("none");
      setComposerOpen(false);
    }
  }, [dragging, selected]);

  useEffect(() => {
    const textarea = promptRef.current;
    if (!composerOpen || !textarea) return;

    const rememberMeasurement = () => {
      promptHeightRef.current = resizePromptTextarea(textarea);
      promptValueRef.current = textarea.value;
      promptMeasuredRef.current = true;
      if (persistedPromptHeightRef.current !== promptHeightRef.current) {
        persistedPromptHeightRef.current = promptHeightRef.current;
        updateNode(id, { promptHeight: promptHeightRef.current });
      }
    };

    const persistedHeight = d.promptHeight;
    const canRestorePersistedHeight = typeof persistedHeight === "number" && promptValueRef.current === d.prompt;
    const canRestorePreviousHeight = promptMeasuredRef.current && promptValueRef.current === d.prompt;
    if (canRestorePersistedHeight) {
      const height = Math.min(PROMPT_MAX_HEIGHT, Math.max(PROMPT_MIN_HEIGHT, persistedHeight));
      textarea.style.height = `${height}px`;
      promptHeightRef.current = height;
      persistedPromptHeightRef.current = height;
      promptMeasuredRef.current = true;
      return;
    }

    if (canRestorePreviousHeight) {
      textarea.style.height = `${promptHeightRef.current}px`;
      return () => {
        promptHeightRef.current = textarea.clientHeight;
        promptValueRef.current = textarea.value;
      };
    }

    rememberMeasurement();

    // The composer mounts inside a transformed React Flow node. Its final width
    // can settle after the first effect, so measure again on the next frame and
    // whenever that width changes. Once measured, reopening the unchanged prompt
    // restores the remembered height instead of sampling the transitional width.
    const frame = requestAnimationFrame(rememberMeasurement);
    let measuredWidth = -1;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width);
      if (width === measuredWidth) return;
      measuredWidth = width;
      rememberMeasurement();
    });
    observer.observe(textarea);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      promptHeightRef.current = textarea.clientHeight;
      promptValueRef.current = textarea.value;
      promptMeasuredRef.current = true;
    };
  }, [composerOpen, d.prompt, d.promptHeight, id, selected, updateNode]);

  const running = d.status === "running";
  const linkedRefCount = edges.reduce((count, e) => {
    if (e.target !== id) return count;
    const src = nodes.find((n) => n.id === e.source);
    if (src?.type !== "image") return count;
    const imageData = src.data as ImageNodeData;
    return count + (imageData.urls.length || (imageData.url ? 1 : 0));
  }, 0);

  const combo = comboError(d.model, d.resolution, d.billing, d.aspectRatio);
  const styleLabel = STYLE_PRESETS.find((s) => s.id === d.styleId)?.label ?? "风格";
  const ownImageUrls = d.urls.length ? d.urls : d.url ? [d.url] : [];
  const canAddImages = ownImageUrls.length < MAX_IMAGE_REFERENCES;
  const focusedImageUrl = focusedImageIndex === null ? null : ownImageUrls[focusedImageIndex] ?? null;
  const activeImageUrl = focusedImageUrl ?? d.url ?? ownImageUrls[0] ?? null;
  const activeImageIndex = focusedImageIndex ?? Math.max(0, Math.min(ownImageUrls.length - 1, d.activeIndex ?? 0));
  const hasActiveEditMask = Boolean(d.editGuide && d.editMask && d.editMaskImageIndex === activeImageIndex);
  const activePreviewUrl = hasActiveEditMask ? d.editGuide ?? activeImageUrl : activeImageUrl;
  const galleryColumns =
    ownImageUrls.length <= 4 ? 2 : ownImageUrls.length <= 6 ? 3 : ownImageUrls.length <= 8 ? 4 : ownImageUrls.length === 9 ? 3 : 5;
  const galleryRows = ownImageUrls.length === 2 ? 1 : ownImageUrls.length === 9 ? 3 : 2;
  const hasFeaturedTile = ownImageUrls.length === 3 || ownImageUrls.length === 5 || ownImageUrls.length === 7;

  useEffect(() => {
    if (focusedImageIndex !== null && focusedImageIndex >= ownImageUrls.length) setFocusedImageIndex(null);
  }, [focusedImageIndex, ownImageUrls.length]);

  const pickFiles = async (files: File[] | FileList) => {
    const imageFiles = Array.from(files).filter(isImageFile);
    if (!imageFiles.length) {
      showToast("请选择 PNG、JPG 或 WebP 图片", "error");
      return;
    }

    const remaining = MAX_IMAGE_REFERENCES - ownImageUrls.length;
    if (remaining <= 0) {
      showToast(`每个图片节点最多添加 ${MAX_IMAGE_REFERENCES} 张参考图`, "error");
      return;
    }

    const acceptedFiles = imageFiles.slice(0, remaining);
    try {
      const addedUrls = await Promise.all(acceptedFiles.map(fileToDataURL));
      const urls = [...ownImageUrls, ...addedUrls];
      const url = d.url && urls.includes(d.url) ? d.url : urls[0];
      const activeIndex = urls.indexOf(url);
      updateNode(id, {
        url,
        urls,
        activeIndex,
        status: "idle",
        error: undefined,
      });
      setFocusedImageIndex(null);
      if (acceptedFiles.length < imageFiles.length) {
        showToast(`已达到上限，仅添加前 ${remaining} 张图片`, "info");
      }
    } catch {
      showToast("图片读取失败", "error");
    }
  };

  const removeImage = (index: number) => {
    const currentIndex = Math.max(0, ownImageUrls.indexOf(d.url ?? ""));
    const urls = ownImageUrls.filter((_, imageIndex) => imageIndex !== index);
    if (!urls.length) {
      setFocusedImageIndex(null);
      updateNode(id, { url: null, urls: [], activeIndex: 0, status: "idle", editMask: undefined, editGuide: undefined, editMaskImageIndex: undefined });
      return;
    }

    const activeIndex =
      index < currentIndex ? currentIndex - 1 : index === currentIndex ? Math.min(index, urls.length - 1) : currentIndex;
    setFocusedImageIndex((focusedIndex) => {
      if (focusedIndex === null || focusedIndex === index) return null;
      return focusedIndex > index ? focusedIndex - 1 : focusedIndex;
    });
    updateNode(id, { url: urls[activeIndex], urls, activeIndex, status: "idle", editMask: undefined, editGuide: undefined, editMaskImageIndex: undefined });
  };

  const focusImage = (url: string, index: number) => {
    setFocusedImageIndex(index);
    setComposerOpen(true);
    updateNode(id, { url, activeIndex: index });
  };

  const replaceActiveImage = (nextUrl: string) => {
    if (!ownImageUrls.length) return;
    const replaceIndex = activeImageIndex;
    const urls = ownImageUrls.map((url, index) => (index === replaceIndex ? nextUrl : url));
    updateNode(id, { url: nextUrl, urls, activeIndex: replaceIndex, status: "idle", error: undefined, editMask: undefined, editGuide: undefined, editMaskImageIndex: undefined });
    setFocusedImageIndex(ownImageUrls.length > 1 ? replaceIndex : null);
    setEditor("none");
    setStickerSrc(null);
    showToast("图片已更新", "success");
  };

  const applyEditMask = ({ mask, guide }: { mask: string; guide: string }) => {
    updateNode(id, { editMask: mask, editGuide: guide, editMaskImageIndex: activeImageIndex });
    setEditor("none");
    showToast("局部编辑范围已保存", "success");
  };

  const removeEditMask = () => {
    updateNode(id, { editMask: undefined, editGuide: undefined, editMaskImageIndex: undefined });
    setEditor("none");
    showToast("已移除局部编辑范围", "info");
  };

  const quickToolbar = activeImageUrl ? (
    <div className="flex items-center gap-1 rounded-full border border-line bg-panel/95 p-1.5 shadow-[0_12px_34px_rgba(0,0,0,0.38)] backdrop-blur-xl">
      <button type="button" onClick={() => setEditor("crop")} className="flex h-8 items-center gap-1.5 rounded-full px-3 text-[11px] text-fg-dim transition-colors hover:bg-white/[0.07] hover:text-fg">
        <Icon name="Scissors" size={12} />裁剪
      </button>
      <span className="h-4 border-l border-line" />
      <button type="button" onClick={() => stickerFileRef.current?.click()} className="flex h-8 items-center gap-1.5 rounded-full px-3 text-[11px] text-fg-dim transition-colors hover:bg-white/[0.07] hover:text-fg">
        <Icon name="Stack" size={12} />贴图
      </button>
      <span className="h-4 border-l border-line" />
      <button type="button" onClick={() => setEditor("brush")} className={cn("relative flex h-8 items-center gap-1.5 rounded-full px-3 text-[11px] transition-colors hover:bg-white/[0.07] hover:text-fg", hasActiveEditMask ? "bg-[#ff684c]/10 text-[#ff8a72]" : "text-fg-dim")}>
        <Icon name="PaintBrush" size={12} />画笔
        {hasActiveEditMask ? <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-[#ff684c] shadow-[0_0_8px_rgba(255,104,76,.7)]" /> : null}
      </button>
    </div>
  ) : undefined;

  const hasImageDrop = (dataTransfer: DataTransfer) =>
    Array.from(dataTransfer.items).some(
      (item) => item.kind === "file" && (!item.type || item.type.startsWith("image/")),
    );
  const nodeWidth = d.width || 470;
  const nodeHeight = d.height ?? nodeWidth;

  if (d.isGeneratedResult) {
    return <GeneratedImageResult id={id} selected={selected} data={d} />;
  }

  return (
    <NodeShell
      id={id}
      selected={selected}
      label={d.label}
      icon="Image"
      width={nodeWidth}
      height={nodeHeight}
      running={running}
      frameless
      portTop={nodeHeight / 2}
      resizeHandleTop={Math.max(8, nodeHeight - 32)}
      onResizeBegin={() => setComposerOpen(false)}
      toolbar={selected && activeImageUrl && !running ? quickToolbar : undefined}
    >
      {/* ── Canvas area ── */}
      <div
        data-body
        style={{ height: nodeHeight }}
        className={cn(
          "relative flex min-h-[264px] items-center justify-center overflow-hidden rounded-[12px] border bg-panel transition-[border-color,box-shadow,transform] duration-200",
          !ownImageUrls.length && !running && "cursor-pointer",
          fileDragActive
            ? "cursor-copy scale-[1.008] border-white/55 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12),0_18px_50px_rgba(0,0,0,0.38)]"
            : selected
              ? "border-white/30 shadow-[0_18px_50px_rgba(0,0,0,0.3)]"
              : "border-line hover:border-line-2",
        )}
        onDragEnter={(e) => {
          if (!hasImageDrop(e.dataTransfer)) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = canAddImages ? "copy" : "none";
          setFileDragActive(canAddImages);
        }}
        onDragOver={(e) => {
          if (!hasImageDrop(e.dataTransfer)) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = canAddImages ? "copy" : "none";
          setFileDragActive(canAddImages);
        }}
        onDragLeave={(e) => {
          const nextTarget = e.relatedTarget as globalThis.Node | null;
          if (!nextTarget || !e.currentTarget.contains(nextTarget)) setFileDragActive(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setFileDragActive(false);
          void pickFiles(e.dataTransfer.files);
        }}
        onClick={(event) => {
          if (ownImageUrls.length || running || dragging) return;
          const target = event.target as HTMLElement;
          if (target.closest("button, input")) return;
          setComposerOpen(true);
        }}
      >
        {fileDragActive ? (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-ink/75 backdrop-blur-[3px]">
            <div className="tf-drop-target-enter flex flex-col items-center text-center">
              <span className="tf-drop-target-pulse mb-3 flex h-12 w-12 items-center justify-center rounded-full border border-white/30 bg-white/[0.08] text-fg shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]">
                <Icon name="UploadSimple" size={21} weight="bold" />
              </span>
              <span className="text-[13px] font-medium tracking-wide text-fg">松开以添加参考图</span>
              <span className="mt-1 text-[10px] uppercase tracking-[0.12em] text-fg-mute">
                PNG · JPG · WEBP · 最多 {MAX_IMAGE_REFERENCES} 张
              </span>
            </div>
          </div>
        ) : null}

        {ownImageUrls.length > 1 && !focusedImageUrl ? (
          <div
            className="absolute inset-1.5 grid gap-1.5"
            style={{
              gridTemplateColumns: `repeat(${galleryColumns}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${galleryRows}, minmax(0, 1fr))`,
            }}
          >
            {ownImageUrls.map((url, index) => {
              const hasEditPreview = Boolean(d.editGuide && d.editMask && d.editMaskImageIndex === index);
              const displayUrl = hasEditPreview ? d.editGuide ?? url : url;
              return (
              <div
                key={`${index}-${url.slice(0, 24)}`}
                className={cn(
                  "group/gallery relative min-h-0 overflow-hidden rounded-[8px] bg-ink",
                  index === 0 && hasFeaturedTile && "row-span-2",
                )}
              >
                <button
                  type="button"
                  title={`放大查看参考图 ${index + 1}`}
                  onClick={() => focusImage(url, index)}
                  className="nodrag h-full w-full overflow-hidden"
                >
                  <img
                    src={displayUrl}
                    alt={`参考图 ${index + 1}${hasEditPreview ? "，已标记局部编辑范围" : ""}`}
                    className="h-full w-full object-cover transition-transform duration-300 group-hover/gallery:scale-[1.035]"
                    draggable={false}
                  />
                </button>
                <span className="pointer-events-none absolute left-1.5 top-1.5 rounded-full bg-ink/65 px-1.5 py-0.5 text-[9px] tabular-nums text-fg-dim opacity-0 backdrop-blur transition-opacity group-hover/gallery:opacity-100">
                  {index + 1}
                </span>
                {hasEditPreview ? <span className="pointer-events-none absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-full border border-[#ff9a85]/25 bg-[#2a1511]/80 px-2 py-1 text-[9px] text-[#ffad9c] shadow-[0_5px_16px_rgba(0,0,0,.28)] backdrop-blur"><Icon name="PaintBrush" size={9} />已标记</span> : null}
                <button
                  type="button"
                  title={`移除参考图 ${index + 1}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    removeImage(index);
                  }}
                  className="nodrag absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-white/15 bg-ink/80 text-fg-mute opacity-0 backdrop-blur transition-[opacity,color,transform] hover:scale-105 hover:text-danger group-hover/gallery:opacity-100"
                >
                  <Icon name="X" size={10} weight="bold" />
                </button>
              </div>
              );
            })}
            <span className="pointer-events-none absolute bottom-2 left-2 rounded-full border border-white/10 bg-ink/75 px-2 py-1 text-[10px] tabular-nums text-fg-dim backdrop-blur">
              {ownImageUrls.length}/{MAX_IMAGE_REFERENCES}
            </span>
          </div>
        ) : activePreviewUrl ? (
          <>
            <img
              src={activePreviewUrl}
              alt={`${focusedImageUrl ? `参考图 ${(focusedImageIndex ?? 0) + 1}` : "参考图"}${hasActiveEditMask ? "，已标记局部编辑范围" : ""}`}
              onClick={() => setComposerOpen(true)}
              className="nodrag h-full w-full cursor-pointer object-contain"
              draggable={false}
            />
            {hasActiveEditMask ? <span className="pointer-events-none absolute bottom-2.5 left-2.5 flex items-center gap-1.5 rounded-full border border-[#ff9a85]/25 bg-[#2a1511]/82 px-2.5 py-1.5 text-[10px] text-[#ffad9c] shadow-[0_8px_24px_rgba(0,0,0,.34)] backdrop-blur-md"><Icon name="PaintBrush" size={10} />局部编辑标记</span> : null}
          </>
        ) : (
          <div className="flex flex-col gap-2 px-8 py-10 text-[12px] text-fg-mute">
            <Icon name="Image" size={34} className="mb-3 self-center text-fg-mute/60" />
            <span className="mb-1 self-center">尝试：</span>
            <button
              type="button"
              className="flex items-center gap-2 self-center rounded-control px-2 py-1 hover:bg-white/5 hover:text-fg"
              onClick={() => fileRef.current?.click()}
            >
              <Icon name="UploadSimple" size={13} /> 上传参考图 · 可多选
            </button>
            <button
              type="button"
              className="flex items-center gap-2 self-center rounded-control px-2 py-1 transition-colors hover:bg-white/5 hover:text-fg"
              onClick={() => setComposerOpen(true)}
            >
              <Icon name="TextT" size={13} /> 直接输入文字生成
            </button>
            <span className="flex items-center gap-2 self-center px-2 py-1">
              <Icon name="ShareNetwork" size={13} /> 连入图片节点作参考
            </span>
          </div>
        )}

        {focusedImageUrl && ownImageUrls.length > 1 ? (
          <button
            type="button"
            title="返回全部参考图"
            aria-label={`返回全部参考图，当前第 ${(focusedImageIndex ?? 0) + 1} 张，共 ${ownImageUrls.length} 张`}
            onClick={(event) => {
              event.stopPropagation();
              setFocusedImageIndex(null);
            }}
            className="nodrag absolute left-2 top-2 z-10 flex h-8 items-center gap-1 rounded-full border border-white/15 bg-ink/75 px-2.5 text-[10px] tabular-nums text-fg-dim shadow-[0_8px_24px_rgba(0,0,0,0.28)] backdrop-blur-md transition-colors hover:border-white/25 hover:text-fg"
          >
            <Icon name="GridFour" size={12} />
            <span>{(focusedImageIndex ?? 0) + 1}/{ownImageUrls.length}</span>
          </button>
        ) : null}

        {running ? <RunningVeil progress={d.progress} label={progressStageLabel(d.progress)} /> : null}

        {d.status === "failed" && d.error ? (
          <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-danger/15 px-3 py-1.5 text-[11px] text-danger">
            <Icon name="Warning" size={12} className="shrink-0" />
            <span className="truncate" title={d.error}>{d.error}</span>
          </div>
        ) : null}

        {/* Single/focused image removal. Multi-image overview owns per-tile controls. */}
        {activeImageUrl && !running && (ownImageUrls.length === 1 || focusedImageIndex !== null) ? (
          <div className="absolute right-2 top-2 opacity-0 transition-opacity group-hover/node:opacity-100">
            <button
              type="button"
              title={focusedImageIndex === null ? "移除参考图" : "移除当前参考图"}
              onClick={() => {
                removeImage(focusedImageIndex ?? 0);
              }}
              className="rounded-full bg-ink/70 p-2 text-fg-dim backdrop-blur hover:text-danger"
            >
              <Icon name="X" size={14} />
            </button>
          </div>
        ) : null}

        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files) void pickFiles(e.target.files);
            e.currentTarget.value = "";
          }}
        />
        <input
          ref={stickerFileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.currentTarget.value = "";
            if (!file || !isImageFile(file)) return;
            void fileToDataURL(file)
              .then((url) => {
                setStickerSrc(url);
                setEditor("sticker");
              })
              .catch(() => showToast("贴图读取失败", "error"));
          }}
        />
      </div>

      {/* ── Composer ── */}
      {composerOpen && selected && !dragging ? (
        <div
          role="dialog"
          aria-label={ownImageUrls.length ? "图片生成设置" : "文生图设置"}
          className="relative left-1/2 mt-3 w-[calc(100%+192px)] -translate-x-1/2 rounded-[18px] border border-line bg-card p-3.5 shadow-[0_18px_50px_rgba(0,0,0,0.24)] nodrag"
          onMouseDown={(e) => e.stopPropagation()}
        >
        <div className="mb-3 flex items-center gap-1.5">
          <Chip title="当前参与生成的参考图数量">
            <Icon name="Paperclip" size={11} />
            参考 {Math.min(MAX_IMAGE_REFERENCES, linkedRefCount + ownImageUrls.length)}/{MAX_IMAGE_REFERENCES}
          </Chip>
          <div ref={styleAreaRef} className="relative">
            {popover === "style" ? <StylePopover data={d} nodeId={id} onClose={() => setPopover("none")} /> : null}
            <Chip active={d.styleId !== "none"} onClick={() => setPopover(popover === "style" ? "none" : "style")} title="风格预设">
              <Icon name="Palette" size={11} />
              {styleLabel}
            </Chip>
          </div>
        </div>

        <textarea
          ref={promptRef}
          value={d.prompt}
          onChange={(e) => {
            promptHeightRef.current = resizePromptTextarea(e.currentTarget);
            promptValueRef.current = e.currentTarget.value;
            promptMeasuredRef.current = true;
            persistedPromptHeightRef.current = promptHeightRef.current;
            updateNode(id, { prompt: e.target.value, promptHeight: promptHeightRef.current });
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void submitGeneration();
            }
          }}
          placeholder="可直接文字生图，或上传/连入图片后输入指令进行编辑，如：将背景改为雪夜"
          rows={3}
          className="tf-composer-prompt nodrag nowheel mb-3 w-full resize-none overflow-y-auto border-none bg-transparent text-[13px] leading-relaxed text-fg outline-none placeholder:text-fg-mute"
          spellCheck={false}
        />

        <div className="flex items-center justify-between gap-1">
          <div className="flex min-w-0 items-center gap-1">
            <div ref={modelAreaRef} className="relative shrink-0">
              {popover === "model" ? <ModelPopover data={d} nodeId={id} onClose={() => setPopover("none")} /> : null}
              <button
                type="button"
                onClick={() => setPopover(popover === "model" ? "none" : "model")}
                className="flex h-8 items-center gap-1 rounded-full border border-line bg-panel-2/95 px-3 text-[11px] text-fg-dim transition-colors hover:border-line-2 hover:text-fg"
              >
                <Icon name="Cube" size={11} />
                {modelLabel(d.model)}
                <Icon name="CaretDown" size={9} />
              </button>
            </div>
            <div ref={paramAreaRef} className="relative min-w-0">
              {popover === "params" ? <ParamPopover data={d} nodeId={id} onClose={() => setPopover("none")} /> : null}
              <button
                type="button"
                onClick={() => setPopover(popover === "params" ? "none" : "params")}
                className="flex h-8 min-w-0 items-center gap-1 truncate rounded-full border border-line bg-panel-2/95 px-3 text-[11px] text-fg-dim transition-colors hover:border-line-2 hover:text-fg"
              >
                {d.aspectRatio === "auto" ? "智能" : d.aspectRatio} · {d.resolution} · {d.count}张
                <Icon name="CaretDown" size={9} />
              </button>
            </div>
          </div>
          <button
            type="button"
            title={combo ?? "生成 (Ctrl+Enter)"}
            disabled={!!combo}
            onClick={() => void submitGeneration()}
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-all active:scale-95",
              combo
                ? "bg-white/10 text-fg-mute"
                : "bg-accent text-ink shadow-[0_6px_20px_-6px_rgba(255,255,255,0.4)] hover:bg-accent-2",
            )}
          >
            <Icon name="ArrowRight" size={14} weight="bold" />
          </button>
        </div>
        {combo ? <div className="mt-1.5 text-[11px] text-danger">{combo}</div> : null}
        </div>
      ) : null}
      {editor === "crop" && activeImageUrl ? (
        <CropEditor src={activeImageUrl} onClose={() => setEditor("none")} onApply={replaceActiveImage} />
      ) : null}
      {editor === "sticker" && activeImageUrl && stickerSrc ? (
        <StickerEditor
          baseSrc={activeImageUrl}
          stickerSrc={stickerSrc}
          onClose={() => {
            setEditor("none");
            setStickerSrc(null);
          }}
          onApply={replaceActiveImage}
        />
      ) : null}
      {editor === "brush" && activeImageUrl ? (
        <BrushEditor src={activeImageUrl} hasExistingMask={hasActiveEditMask} onClose={() => setEditor("none")} onApply={applyEditMask} onRemoveMask={removeEditMask} />
      ) : null}
    </NodeShell>
  );
});
