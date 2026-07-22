"use client";

// 文本节点 — prompt source. Feeds image/video nodes; can also receive an
// image node and run 视觉反推 (visual reverse-engineering) to fill itself.

import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import type { AppNode } from "@/lib/store";
import { useStudio } from "@/lib/store";
import type { ImageNodeData, TextNodeData } from "@/lib/types";
import { Icon } from "../icons";
import { NodeShell } from "./NodeShell";
import { Spinner } from "../ui";

export const TextNode = memo(function TextNode({ id, selected, data }: NodeProps<AppNode>) {
  const d = data as TextNodeData;
  const updateNode = useStudio((s) => s.updateNode);
  const reversePrompt = useStudio((s) => s.reversePrompt);
  const edges = useStudio((s) => s.edges);
  const nodes = useStudio((s) => s.nodes);

  const hasUpstreamImage = edges.some((e) => {
    if (e.target !== id) return false;
    const src = nodes.find((n) => n.id === e.source);
    return src?.type === "image" && !!(src.data as ImageNodeData).url;
  });

  return (
    <NodeShell id={id} selected={selected} label={d.label} icon="TextT" width={d.width || 380}>
      <div className="bg-panel p-3">
        {d.text || d.reversing ? null : (
          <div className="pointer-events-none absolute inset-x-3 top-3 flex flex-col gap-1.5 text-[12px] text-fg-mute">
            <span>写下你想要的画面、场景或指令。例如：</span>
            <span className="text-fg-mute/70">一件白色亚麻衬衫平铺在米色布面上，自然晨光</span>
          </div>
        )}
        <textarea
          value={d.text}
          onChange={(e) => updateNode(id, { text: e.target.value })}
          rows={7}
          className="nodrag w-full resize-none border-none bg-transparent text-[13px] leading-relaxed text-fg outline-none"
          onMouseDown={(e) => e.stopPropagation()}
          spellCheck={false}
        />
      </div>

      <div className="flex items-center justify-between border-t border-line bg-card px-2.5 py-2 nodrag" onMouseDown={(e) => e.stopPropagation()}>
        <span className="text-[11px] text-fg-mute">{d.text.length} 字</span>
        <div className="flex items-center gap-1.5">
          {d.error ? (
            <span className="max-w-[160px] truncate text-[11px] text-danger" title={d.error}>
              {d.error}
            </span>
          ) : null}
          <button
            type="button"
            disabled={!hasUpstreamImage || d.reversing}
            title={hasUpstreamImage ? "解析连入的图片，反推出结构化提示词" : "先连入一个已有图片的图片节点"}
            onClick={() => void reversePrompt(id)}
            className="flex h-7 items-center gap-1.5 rounded-full border border-line bg-white/[0.03] px-2.5 text-[11px] text-fg-dim transition-colors hover:border-line-2 hover:text-fg disabled:pointer-events-none disabled:opacity-40"
          >
            {d.reversing ? <Spinner size={11} /> : <Icon name="Eye" size={11} />}
            {d.reversing ? "解析中…" : "图片反推提示词"}
          </button>
        </div>
      </div>
    </NodeShell>
  );
});
