"use client";

// 图片节点 — the workhorse. Card shows empty-state hints / the generated
// image / upload preview; a composer docked under the card carries prompt,
// model picker, 比例·画质·张数 popover, style preset, and submit (libTV-style).

import { memo, useRef, useState } from "react";
import type { NodeProps } from "@xyflow/react";
import type { AppNode } from "@/lib/store";
import { useStudio } from "@/lib/store";
import type { ImageNodeData, ModelName, Quality, Resolution } from "@/lib/types";
import {
  ASPECT_RATIOS,
  GPT_IMAGE_2_RATIOS,
  MODELS,
  QUALITY_OPTIONS,
  STYLE_PRESETS,
  comboError,
  resolutionsFor,
} from "@/lib/models";
import { cn, downloadUrl, fileToDataURL, progressStageLabel } from "@/lib/utils";
import { Icon } from "../icons";
import { NodeShell, RunningVeil } from "./NodeShell";
import { Chip, Spinner } from "../ui";

function ParamPopover({ data, nodeId, onClose }: { data: ImageNodeData; nodeId: string; onClose: () => void }) {
  const updateNode = useStudio((s) => s.updateNode);
  const set = (patch: Partial<ImageNodeData>) => updateNode(nodeId, patch);
  const isGpt = data.model === "GPT Image 2";
  const ratios = ASPECT_RATIOS.filter((r) => !isGpt || GPT_IMAGE_2_RATIOS.includes(r));

  return (
    <div
      className="glass absolute bottom-full left-0 z-30 mb-2 w-[340px] rounded-panel p-4"
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
      <div className="mb-3 flex gap-1.5">
        {[1, 2, 4].map((c) => (
          <Chip key={c} active={data.count === c} onClick={() => set({ count: c })}>
            {c} 张
          </Chip>
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
      className="glass absolute bottom-full left-0 z-30 mb-2 w-[300px] rounded-panel p-2"
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
            "flex w-full items-center justify-between gap-2 rounded-control px-3 py-2.5 text-left transition-colors",
            data.model === m.name ? "bg-accent/10 text-accent" : "text-fg hover:bg-white/5",
          )}
        >
          <span className="flex flex-col">
            <span className="text-[13px] font-medium">{m.name}</span>
            <span className="text-[11px] text-fg-mute">{m.blurb}</span>
          </span>
          <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-fg-mute">{m.eta}</span>
        </button>
      ))}
    </div>
  );
}

function StylePopover({ data, nodeId, onClose }: { data: ImageNodeData; nodeId: string; onClose: () => void }) {
  const updateNode = useStudio((s) => s.updateNode);
  return (
    <div
      className="glass absolute bottom-full right-0 z-30 mb-2 w-[260px] rounded-panel p-2"
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

export const ImageNode = memo(function ImageNode({ id, selected, data }: NodeProps<AppNode>) {
  const d = data as ImageNodeData;
  const updateNode = useStudio((s) => s.updateNode);
  const generateImage = useStudio((s) => s.generateImage);
  const edges = useStudio((s) => s.edges);
  const nodes = useStudio((s) => s.nodes);
  const fileRef = useRef<HTMLInputElement>(null);
  const [popover, setPopover] = useState<"none" | "params" | "model" | "style">("none");

  const running = d.status === "running";
  const refCount = edges.filter((e) => {
    if (e.target !== id) return false;
    const src = nodes.find((n) => n.id === e.source);
    return src?.type === "image" && !!(src.data as ImageNodeData).url;
  }).length;

  const combo = comboError(d.model, d.resolution, d.billing, d.aspectRatio);
  const styleLabel = STYLE_PRESETS.find((s) => s.id === d.styleId)?.label ?? "风格";

  const pickFile = async (file: File | null) => {
    if (!file) return;
    try {
      const url = await fileToDataURL(file);
      updateNode(id, { url, urls: [url], activeIndex: 0, status: "idle", error: undefined });
    } catch {
      /* toast handled globally */
    }
  };

  return (
    <NodeShell id={id} selected={selected} label={d.label} icon="Image" width={430} running={running}>
      {/* ── Canvas area ── */}
      <div
        className="relative flex min-h-[240px] items-center justify-center bg-panel"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void pickFile(e.dataTransfer.files?.[0] ?? null);
        }}
      >
        {d.url ? (
          <img src={d.url} alt="" className="max-h-[420px] w-full object-contain" draggable={false} />
        ) : (
          <div className="flex flex-col gap-2 px-8 py-10 text-[12px] text-fg-mute">
            <Icon name="Image" size={30} className="mb-1 self-center text-fg-mute/60" />
            <span className="mb-1 self-center">尝试：</span>
            <button
              type="button"
              className="flex items-center gap-2 self-center rounded-control px-2 py-1 hover:bg-white/5 hover:text-fg"
              onClick={() => fileRef.current?.click()}
            >
              <Icon name="UploadSimple" size={13} /> 上传图片 · 图生图
            </button>
            <span className="flex items-center gap-2 self-center px-2 py-1">
              <Icon name="TextT" size={13} /> 直接输入文字生成
            </span>
            <span className="flex items-center gap-2 self-center px-2 py-1">
              <Icon name="ShareNetwork" size={13} /> 连入图片节点作参考
            </span>
          </div>
        )}

        {running ? <RunningVeil progress={d.progress} label={progressStageLabel(d.progress)} /> : null}

        {d.status === "failed" && d.error ? (
          <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-danger/15 px-3 py-1.5 text-[11px] text-danger">
            <Icon name="Warning" size={12} className="shrink-0" />
            <span className="truncate" title={d.error}>{d.error}</span>
          </div>
        ) : null}

        {/* Multi-result film strip */}
        {d.urls.length > 1 ? (
          <div className="absolute bottom-2 left-1/2 flex -translate-x-1/2 gap-1.5 rounded-full bg-ink/70 p-1.5 backdrop-blur">
            {d.urls.map((u, i) => (
              <button
                key={i}
                type="button"
                onClick={() => updateNode(id, { url: u, activeIndex: i })}
                className={cn(
                  "h-9 w-9 overflow-hidden rounded-lg border transition-all",
                  d.activeIndex === i ? "border-accent" : "border-transparent opacity-60 hover:opacity-100",
                )}
              >
                <img src={u} alt="" className="h-full w-full object-cover" draggable={false} />
              </button>
            ))}
          </div>
        ) : null}

        {/* Hover utilities on the image */}
        {d.url && !running ? (
          <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover/node:opacity-100">
            <button
              type="button"
              title="下载"
              onClick={() => downloadUrl(d.url!, `tfvision-${Date.now()}.png`)}
              className="rounded-full bg-ink/70 p-2 text-fg-dim backdrop-blur hover:text-fg"
            >
              <Icon name="Download" size={14} />
            </button>
            <button
              type="button"
              title="更换图片"
              onClick={() => fileRef.current?.click()}
              className="rounded-full bg-ink/70 p-2 text-fg-dim backdrop-blur hover:text-fg"
            >
              <Icon name="Swap" size={14} />
            </button>
            <button
              type="button"
              title="清除图片"
              onClick={() => updateNode(id, { url: null, urls: [], activeIndex: 0, status: "idle" })}
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
          className="hidden"
          onChange={(e) => {
            void pickFile(e.target.files?.[0] ?? null);
            e.currentTarget.value = "";
          }}
        />
      </div>

      {/* ── Composer ── */}
      <div className="relative border-t border-line bg-card p-2.5 nodrag" onMouseDown={(e) => e.stopPropagation()}>
        {popover === "params" ? <ParamPopover data={d} nodeId={id} onClose={() => setPopover("none")} /> : null}
        {popover === "model" ? <ModelPopover data={d} nodeId={id} onClose={() => setPopover("none")} /> : null}
        {popover === "style" ? <StylePopover data={d} nodeId={id} onClose={() => setPopover("none")} /> : null}

        <div className="mb-2 flex items-center gap-1.5">
          <Chip title="来自连线的参考图数量">
            <Icon name="Paperclip" size={11} />
            参考 {refCount + (d.url ? 1 : 0)}
          </Chip>
          <Chip active={d.styleId !== "none"} onClick={() => setPopover(popover === "style" ? "none" : "style")} title="风格预设">
            <Icon name="Palette" size={11} />
            {styleLabel}
          </Chip>
        </div>

        <textarea
          value={d.prompt}
          onChange={(e) => updateNode(id, { prompt: e.target.value })}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void generateImage(id);
            }
          }}
          placeholder="可直接文字生图，或上传/连入图片后输入指令进行编辑，如：将背景改为雪夜"
          rows={2}
          className="mb-2 w-full resize-none border-none bg-transparent text-[13px] leading-relaxed text-fg outline-none placeholder:text-fg-mute"
          spellCheck={false}
        />

        <div className="flex items-center justify-between gap-1">
          <div className="flex min-w-0 items-center gap-1">
            <button
              type="button"
              onClick={() => setPopover(popover === "model" ? "none" : "model")}
              className="flex h-7 shrink-0 items-center gap-1 rounded-full border border-line bg-white/[0.03] px-2.5 text-[11px] text-fg-dim transition-colors hover:border-line-2 hover:text-fg"
            >
              <Icon name="Cube" size={11} />
              {d.model}
              <Icon name="CaretDown" size={9} />
            </button>
            <button
              type="button"
              onClick={() => setPopover(popover === "params" ? "none" : "params")}
              className="flex h-7 min-w-0 items-center gap-1 truncate rounded-full border border-line bg-white/[0.03] px-2.5 text-[11px] text-fg-dim transition-colors hover:border-line-2 hover:text-fg"
            >
              {d.aspectRatio === "auto" ? "智能" : d.aspectRatio} · {d.resolution} · {d.count}张
              <Icon name="CaretDown" size={9} />
            </button>
          </div>
          <button
            type="button"
            title={combo ?? "生成 (Ctrl+Enter)"}
            disabled={running || !!combo}
            onClick={() => void generateImage(id)}
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-all active:scale-95",
              running || combo
                ? "bg-white/10 text-fg-mute"
                : "bg-accent text-ink shadow-[0_6px_20px_-6px_rgba(230,178,119,0.6)] hover:bg-accent-2",
            )}
          >
            {running ? <Spinner size={14} /> : <Icon name="ArrowRight" size={14} weight="bold" />}
          </button>
        </div>
        {combo ? <div className="mt-1.5 text-[11px] text-danger">{combo}</div> : null}
      </div>
    </NodeShell>
  );
});
