"use client";

// Shared chrome for all canvas nodes: floating label above the card, the card
// frame, left/right ⊕ ports (libTV-style), and hover actions.

import { Handle, Position } from "@xyflow/react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Icon } from "../icons";
import { useStudio } from "@/lib/store";
import { useReactFlow } from "@xyflow/react";

export function NodeShell({
  id,
  selected,
  label,
  icon,
  children,
  width = 420,
  running,
  className,
}: {
  id: string;
  selected?: boolean;
  label: string;
  icon: string;
  children: ReactNode;
  width?: number;
  running?: boolean;
  className?: string;
}) {
  const removeNode = useStudio((s) => s.removeNode);
  const duplicateNode = useStudio((s) => s.duplicateNode);
  const openMenu = useStudio((s) => s.openMenu);
  const updateNode = useStudio((s) => s.updateNode);
  const rf = useReactFlow();

  const openPortMenu = (side: "in" | "out") => (e: React.MouseEvent) => {
    e.stopPropagation();
    const node = rf.getNode(id);
    if (!node) return;
    const w = node.measured?.width ?? width;
    const flowPosition =
      side === "out"
        ? { x: node.position.x + w + 120, y: node.position.y }
        : { x: node.position.x - w - 120, y: node.position.y };
    openMenu({
      flowPosition,
      screen: { x: e.clientX, y: e.clientY },
      sourceNodeId: side === "out" ? id : undefined,
      targetNodeId: side === "in" ? id : undefined,
    });
  };

  return (
    <div className={cn("tf-node-wrap group/node relative", selected && "selected")} style={{ width }}>
      {/* Floating label (libTV puts it above the card, outside the frame) */}
      <div className="pointer-events-none absolute -top-7 left-0 flex w-full items-center gap-1.5 text-[12px] text-fg-dim">
        <Icon name={icon} size={13} className="shrink-0" />
        <input
          className="pointer-events-auto w-0 flex-1 truncate border-none bg-transparent text-[12px] text-fg-dim outline-none transition-colors focus:text-fg"
          value={label}
          onChange={(e) => updateNode(id, { label: e.target.value })}
          onMouseDown={(e) => e.stopPropagation()}
          spellCheck={false}
        />
        <span className="pointer-events-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover/node:opacity-100">
          <button
            type="button"
            title="复制节点"
            onClick={(e) => {
              e.stopPropagation();
              duplicateNode(id);
            }}
            className="rounded p-1 text-fg-mute hover:bg-white/10 hover:text-fg"
          >
            <Icon name="Copy" size={12} />
          </button>
          <button
            type="button"
            title="删除节点"
            onClick={(e) => {
              e.stopPropagation();
              removeNode(id);
            }}
            className="rounded p-1 text-fg-mute hover:bg-white/10 hover:text-danger"
          >
            <Icon name="Trash" size={12} />
          </button>
        </span>
      </div>

      {/* Card */}
      <div
        className={cn(
          "relative overflow-hidden rounded-panel border bg-card transition-all duration-200",
          selected ? "border-accent/70 shadow-[0_0_0_1px_rgba(230,178,119,0.35),0_24px_60px_rgba(0,0,0,0.5)]" : "border-line hover:border-line-2",
          running && "border-accent/40",
          className,
        )}
      >
        {children}
      </div>

      {/* Ports — ⊕ on both flanks, revealed on hover (libTV interaction) */}
      <Handle type="target" position={Position.Left} className="tf-port" style={{ left: -30 }} onClick={openPortMenu("in")}>
        <Icon name="Plus" size={12} className="pointer-events-none" />
      </Handle>
      <Handle type="source" position={Position.Right} className="tf-port" style={{ right: -30 }} onClick={openPortMenu("out")}>
        <Icon name="Plus" size={12} className="pointer-events-none" />
      </Handle>
    </div>
  );
}

/** Progress veil while a node's job runs: scan sweep + % + stage copy. */
export function RunningVeil({ progress, label }: { progress: number; label: string }) {
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-ink/60 backdrop-blur-[2px]">
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="scan-sweep absolute inset-x-0 h-1/2" />
      </div>
      <div className="text-2xl font-semibold text-fg">{Math.round(progress)}%</div>
      <div className="text-[12px] text-fg-dim">{label}</div>
    </div>
  );
}
