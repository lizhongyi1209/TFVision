"use client";

// 视频节点 — 以图片为主的工作流里的"辅助"输出：连入首帧图片节点 + 提示词，
// 提交 Kling / Seedance 任务并轮询，完成后本地保存播放。

import { memo, useState } from "react";
import type { NodeProps } from "@xyflow/react";
import type { AppNode } from "@/lib/store";
import { useStudio } from "@/lib/store";
import type { ImageNodeData, VideoAspectRatio, VideoModel, VideoNodeData, VideoResolution } from "@/lib/types";
import { VIDEO_MODELS, VIDEO_MODEL_RESOLUTIONS, videoDurationsFor } from "@/lib/models";
import { cn, downloadUrl } from "@/lib/utils";
import { Icon } from "../icons";
import { NodeShell, RunningVeil } from "./NodeShell";
import { Chip, Spinner } from "../ui";

function VideoParamPopover({ data, nodeId, onClose }: { data: VideoNodeData; nodeId: string; onClose: () => void }) {
  const updateNode = useStudio((s) => s.updateNode);
  const set = (patch: Partial<VideoNodeData>) => updateNode(nodeId, patch);
  const durations = videoDurationsFor(data.model);
  const resolutions = VIDEO_MODEL_RESOLUTIONS[data.model];

  return (
    <div
      className="glass absolute bottom-full left-0 z-30 mb-2 w-[340px] rounded-panel p-4"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-medium text-fg-mute">视频参数</span>
        <button type="button" onClick={onClose} className="rounded p-1 text-fg-mute hover:text-fg">
          <Icon name="X" size={12} />
        </button>
      </div>

      <div className="mb-1.5 text-[11px] text-fg-mute">分辨率</div>
      <div className="mb-3 flex gap-1.5">
        {resolutions.map((r) => (
          <Chip key={r} active={data.mode === r} onClick={() => set({ mode: r as VideoResolution })}>
            {r}
          </Chip>
        ))}
      </div>

      <div className="mb-1.5 text-[11px] text-fg-mute">时长（秒）</div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {durations.map((t) => (
          <Chip key={t} active={data.duration === t} onClick={() => set({ duration: t })}>
            {t}s
          </Chip>
        ))}
      </div>

      <div className="mb-1.5 text-[11px] text-fg-mute">比例</div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {(["智能", "16:9", "9:16", "1:1", "4:3", "3:4"] as const).map((r) => (
          <Chip key={r} active={data.aspectRatio === r} onClick={() => set({ aspectRatio: r as VideoAspectRatio })}>
            {r}
          </Chip>
        ))}
      </div>

      <div className="flex gap-1.5">
        <Chip active={data.sound} onClick={() => set({ sound: !data.sound })}>
          <Icon name="MusicNotes" size={11} /> 生成音效
        </Chip>
        <Chip active={data.cameraFixed} onClick={() => set({ cameraFixed: !data.cameraFixed })}>
          <Icon name="VideoCamera" size={11} /> 固定镜头
        </Chip>
      </div>
    </div>
  );
}

export const VideoNode = memo(function VideoNode({ id, selected, data }: NodeProps<AppNode>) {
  const d = data as VideoNodeData;
  const updateNode = useStudio((s) => s.updateNode);
  const generateVideo = useStudio((s) => s.generateVideo);
  const edges = useStudio((s) => s.edges);
  const nodes = useStudio((s) => s.nodes);
  const [popover, setPopover] = useState<"none" | "params" | "model">("none");

  const running = d.status === "running";
  const firstFrame = edges
    .filter((e) => e.target === id)
    .map((e) => nodes.find((n) => n.id === e.source))
    .find((n) => n?.type === "image" && (n.data as ImageNodeData).url);

  const modelInfo = VIDEO_MODELS.find((m) => m.value === d.model);

  return (
    <NodeShell id={id} selected={selected} label={d.label} icon="FilmSlate" width={d.width || 430} height={d.height} running={running}>
      <div
        data-body
        style={d.height ? { height: d.height } : undefined}
        className={cn(
          "relative flex items-center justify-center overflow-hidden bg-panel",
          !d.height && "min-h-[240px]",
        )}
      >
        {d.url ? (
          <video src={d.url} controls loop className={cn(d.height ? "h-full w-full" : "max-h-[420px] w-full")} />
        ) : (
          <div className="flex flex-col gap-2 px-8 py-10 text-center text-[12px] text-fg-mute">
            <Icon name="FilmSlate" size={30} className="mb-1 self-center text-fg-mute/60" />
            {firstFrame ? (
              <span className="flex items-center gap-1.5 self-center text-fg-dim">
                <Icon name="Check" size={12} className="text-accent" /> 已连入首帧图片
              </span>
            ) : (
              <span>连入一个图片节点作为首帧（图生视频）</span>
            )}
            <span className="text-fg-mute/70">Seedance / Omni 也支持纯文字生视频</span>
          </div>
        )}

        {running ? <RunningVeil progress={d.progress} label="视频生成中，通常需要几分钟…" /> : null}

        {d.status === "failed" && d.error ? (
          <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-danger/15 px-3 py-1.5 text-[11px] text-danger">
            <Icon name="Warning" size={12} className="shrink-0" />
            <span className="truncate" title={d.error}>{d.error}</span>
          </div>
        ) : null}

        {d.url && !running ? (
          <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover/node:opacity-100">
            <button
              type="button"
              title="下载视频"
              onClick={() => downloadUrl(d.url!, `tfvision-${Date.now()}.mp4`)}
              className="rounded-full bg-ink/70 p-2 text-fg-dim backdrop-blur hover:text-fg"
            >
              <Icon name="Download" size={14} />
            </button>
            <button
              type="button"
              title="清除"
              onClick={() => updateNode(id, { url: null, status: "idle", taskId: undefined })}
              className="rounded-full bg-ink/70 p-2 text-fg-dim backdrop-blur hover:text-danger"
            >
              <Icon name="X" size={14} />
            </button>
          </div>
        ) : null}
      </div>

      <div className="relative border-t border-line bg-card p-2.5 nodrag" onMouseDown={(e) => e.stopPropagation()}>
        {popover === "params" ? <VideoParamPopover data={d} nodeId={id} onClose={() => setPopover("none")} /> : null}
        {popover === "model" ? (
          <div className="glass absolute bottom-full left-0 z-30 mb-2 w-[280px] rounded-panel p-2" onMouseDown={(e) => e.stopPropagation()}>
            {VIDEO_MODELS.map((m) => (
              <button
                key={m.value}
                type="button"
                onClick={() => {
                  const patch: Partial<VideoNodeData> = { model: m.value as VideoModel };
                  const allowed = VIDEO_MODEL_RESOLUTIONS[m.value];
                  if (!allowed.includes(d.mode)) patch.mode = allowed[0];
                  const durations = videoDurationsFor(m.value);
                  if (!durations.includes(d.duration)) patch.duration = durations.includes(5) ? 5 : durations[0];
                  updateNode(id, patch);
                  setPopover("none");
                }}
                className={cn(
                  "flex w-full items-center justify-between rounded-control px-3 py-2.5 text-left transition-colors",
                  d.model === m.value ? "bg-accent/10 text-accent" : "text-fg hover:bg-white/5",
                )}
              >
                <span className="flex flex-col">
                  <span className="text-[13px] font-medium">{m.label}</span>
                  <span className="text-[11px] text-fg-mute">{m.blurb}</span>
                </span>
              </button>
            ))}
          </div>
        ) : null}

        <textarea
          value={d.prompt}
          onChange={(e) => updateNode(id, { prompt: e.target.value })}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void generateVideo(id);
            }
          }}
          placeholder="描述画面如何运动，如：镜头缓缓推近，模特转身微笑，衣摆随风轻摆"
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
              <Icon name="FilmSlate" size={11} />
              {modelInfo?.label ?? d.model}
              <Icon name="CaretDown" size={9} />
            </button>
            <button
              type="button"
              onClick={() => setPopover(popover === "params" ? "none" : "params")}
              className="flex h-7 min-w-0 items-center gap-1 truncate rounded-full border border-line bg-white/[0.03] px-2.5 text-[11px] text-fg-dim transition-colors hover:border-line-2 hover:text-fg"
            >
              {d.mode} · {d.duration}s · {d.aspectRatio}
              <Icon name="CaretDown" size={9} />
            </button>
          </div>
          <button
            type="button"
            title="生成视频 (Ctrl+Enter)"
            disabled={running}
            onClick={() => void generateVideo(id)}
            className={cn(
              "flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-all active:scale-95",
              running
                ? "bg-white/10 text-fg-mute"
                : "bg-accent text-ink shadow-[0_6px_20px_-6px_rgba(255,255,255,0.4)] hover:bg-accent-2",
            )}
          >
            {running ? <Spinner size={14} /> : <Icon name="ArrowRight" size={14} weight="bold" />}
          </button>
        </div>
      </div>
    </NodeShell>
  );
});
