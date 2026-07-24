"use client";

import { memo, useEffect, useRef, useState } from "react";
import { NodeResizer, NodeToolbar, Position, type NodeProps } from "@xyflow/react";
import { useStudio, type AppNode } from "@/lib/store";
import type { GroupColor, GroupNodeData } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Icon } from "../icons";

const GROUP_COLORS: Record<GroupColor, { label: string; fill: string; border: string; dot: string }> = {
  graphite: {
    label: "石墨",
    fill: "rgba(255,255,255,0.025)",
    border: "rgba(255,255,255,0.16)",
    dot: "#74777d",
  },
  slate: {
    label: "冷蓝",
    fill: "rgba(74,104,138,0.10)",
    border: "rgba(118,157,199,0.30)",
    dot: "#6f91b5",
  },
  teal: {
    label: "墨绿",
    fill: "rgba(47,111,99,0.10)",
    border: "rgba(89,157,143,0.28)",
    dot: "#5b9d90",
  },
  amber: {
    label: "暖棕",
    fill: "rgba(128,91,46,0.10)",
    border: "rgba(179,133,76,0.28)",
    dot: "#a97846",
  },
  rose: {
    label: "暗红",
    fill: "rgba(126,61,70,0.10)",
    border: "rgba(177,91,103,0.28)",
    dot: "#a45d68",
  },
};

export const GroupNode = memo(function GroupNode({ id, selected, data }: NodeProps<AppNode>) {
  const group = data as GroupNodeData;
  const updateNode = useStudio((state) => state.updateNode);
  const ungroupNode = useStudio((state) => state.ungroupNode);
  const tone = GROUP_COLORS[group.color] ?? GROUP_COLORS.graphite;
  const [nameDraft, setNameDraft] = useState(group.label || "分组");
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setNameDraft(group.label || "分组");
  }, [group.label]);

  const commitName = () => {
    const label = nameDraft.trim() || group.label || "分组";
    setNameDraft(label);
    if (label !== group.label) updateNode(id, { label });
  };

  return (
    <>
      <NodeResizer
        nodeId={id}
        isVisible={selected}
        minWidth={320}
        minHeight={220}
        color={tone.dot}
        lineStyle={{ borderColor: tone.dot, opacity: 0.62 }}
        handleStyle={{
          width: 11,
          height: 11,
          borderRadius: 4,
          border: `1px solid ${tone.dot}`,
          background: "#15161a",
        }}
      />
      <NodeToolbar
        nodeId={id}
        isVisible={selected}
        position={Position.Top}
        offset={12}
        className="nodrag flex h-10 items-center gap-1.5 rounded-control border border-line bg-panel/95 px-2 shadow-[0_14px_38px_rgba(0,0,0,0.42)] backdrop-blur-xl"
      >
        <label className="flex h-7 items-center gap-1.5 rounded-md border border-white/8 bg-black/20 px-2 text-fg-mute focus-within:border-white/20 focus-within:text-fg-dim">
          <Icon name="PencilLine" size={12} />
          <input
            ref={nameInputRef}
            aria-label="分组名称"
            value={nameDraft}
            onChange={(event) => setNameDraft(event.target.value)}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") {
                setNameDraft(group.label || "分组");
                event.currentTarget.blur();
              }
            }}
            className="tf-name-input w-[96px] bg-transparent text-[11px] text-fg outline-none"
            spellCheck={false}
          />
        </label>
        <span className="mx-0.5 h-5 w-px bg-line" />
        <span className="px-1 text-[11px] text-fg-mute">区域颜色</span>
        {(Object.keys(GROUP_COLORS) as GroupColor[]).map((color) => {
          const option = GROUP_COLORS[color];
          const active = group.color === color;
          return (
            <button
              key={color}
              type="button"
              title={option.label}
              aria-label={`区域颜色：${option.label}`}
              aria-pressed={active}
              onClick={(event) => {
                event.stopPropagation();
                updateNode(id, { color });
              }}
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-white/8",
                active && "bg-white/10 ring-1 ring-white/20",
              )}
            >
              <span className="h-3.5 w-3.5 rounded-full border border-white/20" style={{ background: option.dot }} />
            </button>
          );
        })}
        <span className="mx-0.5 h-5 w-px bg-line" />
        <button
          type="button"
          title="取消分组并保留其中节点"
          onClick={(event) => {
            event.stopPropagation();
            ungroupNode(id);
          }}
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] text-fg-dim transition-colors hover:bg-white/8 hover:text-fg"
        >
          <Icon name="ArrowsOutSimple" size={13} />
          解组
        </button>
      </NodeToolbar>

      <div
        className={cn(
          "relative h-full w-full rounded-[22px] border transition-[border-color,background-color,box-shadow] duration-200",
          selected && "shadow-[0_0_0_1px_rgba(255,255,255,0.10),0_18px_55px_rgba(0,0,0,0.20)]",
        )}
        style={{
          background: tone.fill,
          borderColor: selected ? tone.dot : tone.border,
        }}
      >
        <div
          className="tf-group-drag-handle absolute left-4 top-3 flex cursor-grab items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] text-fg-mute active:cursor-grabbing"
          title="拖动分组 · 双击修改名称"
          onDoubleClick={(event) => {
            event.stopPropagation();
            nameInputRef.current?.focus();
            nameInputRef.current?.select();
          }}
        >
          <Icon name="Stack" size={13} />
          <span>{group.label || "分组"}</span>
        </div>
      </div>
    </>
  );
});
