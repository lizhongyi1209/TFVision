"use client";

// Shared chrome for all canvas nodes: floating label above the card (doubles
// as the drag handle; double-click to rename), the card frame, left/right ⊕
// ports (libTV-style), hover actions, and a free-resize grip (width + height).

import { Handle, Position, useReactFlow } from "@xyflow/react";
import { useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Icon } from "../icons";
import { useStudio } from "@/lib/store";

export function NodeShell({
  id,
  selected,
  label,
  icon,
  children,
  width = 420,
  height,
  running,
  className,
  toolbar,
  showHeaderActions = true,
  showDuplicateAction = true,
  frameless = false,
  portTop,
  resizeHandleTop,
  onResizeBegin,
}: {
  id: string;
  selected?: boolean;
  label: string;
  icon: string;
  children: ReactNode;
  width?: number;
  /** 内容区（[data-body]）的显式高度；未设置时随内容自适应。 */
  height?: number;
  running?: boolean;
  className?: string;
  /** 浮在节点上方的工具条（如文本节点的格式栏），随节点移动。 */
  toolbar?: ReactNode;
  /** 是否显示标题栏右侧的复制、删除按钮。 */
  showHeaderActions?: boolean;
  /** 某些过程节点只允许删除，不应复制任务状态。 */
  showDuplicateAction?: boolean;
  /** 由节点自身绘制独立面板，而非使用统一卡片外框。 */
  frameless?: boolean;
  /** 连线端口相对节点顶部的位置；适合预览区与编辑区分离的节点。 */
  portTop?: number | string;
  /** 缩放把手相对节点顶部的位置；未设置时贴合整个节点的右下角。 */
  resizeHandleTop?: number;
  /** 开始缩放时触发，可用于收起会影响节点尺寸的浮层。 */
  onResizeBegin?: () => void;
}) {
  const removeNode = useStudio((s) => s.removeNode);
  const duplicateNode = useStudio((s) => s.duplicateNode);
  const openMenu = useStudio((s) => s.openMenu);
  const updateNode = useStudio((s) => s.updateNode);
  const rf = useReactFlow();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);

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

  // 右下角把手：自由调整宽高。宽度写 data.width，高度写 data.height（作用于
  // [data-body] 内容区，未设置时以当前实际高度为起点）。
  const onResizeStart = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onResizeBegin?.();
    const zoom = rf.getZoom() || 1;
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = width;
    const bodyEl = wrapRef.current?.querySelector<HTMLElement>("[data-body]");
    const startH = height ?? (bodyEl ? bodyEl.getBoundingClientRect().height / zoom : 240);
    const onMove = (ev: PointerEvent) => {
      const w = Math.round(Math.max(300, Math.min(920, startW + (ev.clientX - startX) / zoom)));
      const h = Math.round(Math.max(150, Math.min(1000, startH + (ev.clientY - startY) / zoom)));
      updateNode(id, { width: w, height: h });
    };
    const onUp = () => window.removeEventListener("pointermove", onMove);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  };

  return (
    <div ref={wrapRef} className={cn("tf-node-wrap group/node relative", selected && "selected")} style={{ width }}>
      {/* 浮动工具条 — 节点上方居中，内联跟随节点（不拦截画布拖动） */}
      {toolbar ? (
        <div className="nodrag absolute -top-[68px] left-1/2 z-30 -translate-x-1/2" onMouseDown={(e) => e.stopPropagation()}>
          {toolbar}
        </div>
      ) : null}

      {/* 标题行 = 拖动把手（不拦截 mousedown）；双击改名 */}
      <div className="absolute -top-7 left-0 flex w-full items-center gap-1.5 text-[12px] text-fg-dim">
        <Icon name={icon} size={13} className="pointer-events-none shrink-0" />
        {editing ? (
          <input
            autoFocus
            defaultValue={label}
            className="nodrag w-0 flex-1 truncate border-none bg-transparent text-[12px] text-fg outline-none"
            onMouseDown={(e) => e.stopPropagation()}
            onBlur={(e) => {
              updateNode(id, { label: e.target.value.trim() || label });
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setEditing(false);
            }}
            spellCheck={false}
          />
        ) : (
          <span className="w-0 flex-1 truncate" onDoubleClick={() => setEditing(true)} title="拖动移动节点 · 双击重命名">
            {label}
          </span>
        )}
        {showHeaderActions ? (
          <span className="nodrag flex items-center gap-0.5 opacity-0 transition-opacity group-hover/node:opacity-100">
            {showDuplicateAction ? (
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
            ) : null}
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
        ) : null}
      </div>

      {/* Card */}
      <div
        className={cn(
          frameless
            ? "relative"
            : "relative overflow-hidden rounded-panel border bg-card transition-all duration-200",
          !frameless && (selected ? "border-white/30 shadow-[0_18px_50px_rgba(0,0,0,0.45)]" : "border-line hover:border-line-2"),
          !frameless && running && "border-white/25",
          className,
        )}
      >
        {children}
      </div>

      {/* Ports — ⊕ on both flanks, revealed on hover (libTV interaction) */}
      <Handle type="target" position={Position.Left} className="tf-port" style={{ left: -30, top: portTop }} onClick={openPortMenu("in")}>
        <Icon name="Plus" size={12} className="pointer-events-none" />
      </Handle>
      <Handle type="source" position={Position.Right} className="tf-port" style={{ right: -30, top: portTop }} onClick={openPortMenu("out")}>
        <Icon name="Plus" size={12} className="pointer-events-none" />
      </Handle>

      {/* 右下角缩放把手：自由拖拽调整宽高 */}
      <div
        className={cn(
          "nodrag group/resize absolute right-2 z-20 h-6 w-6 items-end justify-end",
          resizeHandleTop === undefined && "bottom-2",
          selected ? "flex" : "hidden group-hover/node:flex",
        )}
        style={{ cursor: "nwse-resize", touchAction: "none", top: resizeHandleTop }}
        onPointerDown={onResizeStart}
        title="拖拽自由调整节点宽高"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          className="pointer-events-none h-4 w-4 overflow-visible text-fg-mute transition-colors duration-150 group-hover/resize:text-fg"
        >
          <path d="M3 13 13 3" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
          <path d="m8 13 5-5" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
        </svg>
      </div>
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
