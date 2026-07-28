"use client";

// Shared chrome for all canvas nodes: floating label above the card (doubles
// as the drag handle; double-click to rename), the card frame, left/right ⊕
// ports (libTV-style), hover actions, and a free-resize grip (width + height).

import { Handle, Position, useReactFlow } from "@xyflow/react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn, type NodeResizePolicy } from "@/lib/utils";
import { Icon } from "../icons";
import { useStudio } from "@/lib/store";

export function NodeShell({
  id,
  selected,
  dragging,
  label,
  icon,
  children,
  width = 420,
  height,
  running,
  className,
  toolbar,
  headerMeta,
  showHeaderActions = false,
  showDuplicateAction = true,
  frameless = false,
  portTop,
  resizeHandleTop,
  resizeHandleOutside = true,
  resizePolicy,
  onResizeBegin,
}: {
  id: string;
  selected?: boolean;
  dragging?: boolean;
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
  /** 标题右侧的媒体信息，如 1920 × 1080 · 30 fps。 */
  headerMeta?: ReactNode;
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
  /** 将极简缩放角标放在节点右下外边沿，避免遮挡媒体或参数内容。 */
  resizeHandleOutside?: boolean;
  /** Shared resize contract. Omit for free resize using the first rendered size as its minimum. */
  resizePolicy?: NodeResizePolicy;
  /** 开始缩放时触发，可用于收起会影响节点尺寸的浮层。 */
  onResizeBegin?: () => void;
}) {
  const removeNode = useStudio((s) => s.removeNode);
  const duplicateNode = useStudio((s) => s.duplicateNode);
  const openMenu = useStudio((s) => s.openMenu);
  const updateNode = useStudio((s) => s.updateNode);
  const rf = useReactFlow();
  const wrapRef = useRef<HTMLDivElement>(null);
  const minimumSizeRef = useRef<{ width: number; height?: number }>({ width, height });
  const wasDraggingRef = useRef(false);
  const dragEndedAtRef = useRef(0);
  const [editing, setEditing] = useState(false);
  const [toolbarBlockedByDrag, setToolbarBlockedByDrag] = useState(false);

  useEffect(() => {
    if (dragging) {
      wasDraggingRef.current = true;
      setToolbarBlockedByDrag(true);
      return;
    }
    if (wasDraggingRef.current) {
      wasDraggingRef.current = false;
      dragEndedAtRef.current = performance.now();
    }
    if (!selected) setToolbarBlockedByDrag(false);
  }, [dragging, selected]);

  const revealToolbarAfterClick = (event: React.MouseEvent<HTMLDivElement>) => {
    // Browsers may emit a click immediately after a drag ends. Ignore that
    // release click so moving a node never turns into an edit interaction.
    if (dragging || wasDraggingRef.current || performance.now() - dragEndedAtRef.current < 160) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    setToolbarBlockedByDrag(false);
  };

  const openPortMenu = (side: "in" | "out") => (e: React.MouseEvent) => {
    e.stopPropagation();
    const node = rf.getNode(id);
    if (!node) return;
    const absolutePosition = rf.getInternalNode(id)?.internals.positionAbsolute ?? node.position;
    const w = node.measured?.width ?? width;
    const flowPosition =
      side === "out"
        ? { x: absolutePosition.x + w + 120, y: absolutePosition.y }
        : { x: absolutePosition.x - w - 120, y: absolutePosition.y };
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
    if (minimumSizeRef.current.height === undefined) minimumSizeRef.current.height = startH;
    const minimumWidth = resizePolicy?.minWidth ?? minimumSizeRef.current.width;
    const minimumHeight = resizePolicy?.minHeight ?? minimumSizeRef.current.height;
    const maximumWidth = resizePolicy?.maxWidth ?? 1200;
    const maximumHeight = resizePolicy?.maxHeight ?? 1200;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    let resizing = true;
    const cleanup = () => {
      if (!resizing) return;
      resizing = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
      window.removeEventListener("blur", cleanup);
      document.body.style.userSelect = previousUserSelect;
    };
    const onMove = (ev: PointerEvent) => {
      // Native video controls and window boundaries can swallow pointerup.
      // The buttons bitmask lets the next move terminate a stale resize anyway.
      if ((ev.buttons & 1) === 0) {
        cleanup();
        return;
      }
      const deltaX = (ev.clientX - startX) / zoom;
      const deltaY = (ev.clientY - startY) / zoom;
      let w: number;
      let h: number;
      const aspectRatio = resizePolicy?.mode === "preserve-aspect" ? resizePolicy.aspectRatio : undefined;
      if (aspectRatio && Number.isFinite(aspectRatio) && aspectRatio > 0) {
        const projectedScale = 1 + ((deltaX * startW) + (deltaY * startH)) / ((startW * startW) + (startH * startH));
        const minimumScale = Math.max(minimumWidth / startW, minimumHeight / startH);
        const maximumScale = Math.min(maximumWidth / startW, maximumHeight / startH);
        const scale = Math.max(minimumScale, Math.min(maximumScale, projectedScale));
        w = Math.round(startW * scale);
        h = Math.round(w / aspectRatio);
      } else {
        w = Math.round(Math.max(minimumWidth, Math.min(maximumWidth, startW + deltaX)));
        h = Math.round(Math.max(minimumHeight, Math.min(maximumHeight, startH + deltaY)));
      }
      updateNode(id, { width: w, height: h });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", cleanup);
    window.addEventListener("pointercancel", cleanup);
    window.addEventListener("blur", cleanup);
  };

  return (
    <div
      ref={wrapRef}
      className={cn("tf-node-wrap group/node relative", selected && "selected")}
      style={{
        width,
        "--tf-port-top": typeof portTop === "number" ? `${portTop}px` : portTop ?? "50%",
        "--tf-port-left": "-30px",
        "--tf-port-right": "-30px",
      } as CSSProperties}
      onClickCapture={revealToolbarAfterClick}
    >
      {/* 浮动工具条 — 节点上方居中，内联跟随节点（不拦截画布拖动） */}
      {toolbar && !dragging && !toolbarBlockedByDrag ? (
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
            className="tf-name-input nodrag w-0 flex-1 truncate bg-transparent text-[12px] text-fg"
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
        {headerMeta ? (
          <span className="nodrag shrink-0 rounded-full border border-white/[0.08] bg-white/[0.035] px-2 py-0.5 text-[9px] tabular-nums text-fg-mute">
            {headerMeta}
          </span>
        ) : null}
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

      {/* Ports — fixed ⊕ anchors on both flanks, revealed on hover. */}
      <Handle type="target" position={Position.Left} className="tf-port" style={{ left: "var(--tf-port-left)", top: "var(--tf-port-top)" }} onClick={openPortMenu("in")}>
        <Icon name="Plus" size={12} className="pointer-events-none" />
      </Handle>
      <Handle type="source" position={Position.Right} className="tf-port" style={{ right: "var(--tf-port-right)", top: "var(--tf-port-top)" }} onClick={openPortMenu("out")}>
        <Icon name="Plus" size={12} className="pointer-events-none" />
      </Handle>

      {/* 右下角缩放把手：自由拖拽调整宽高 */}
      <div
        className={cn(
          "nodrag group/resize absolute z-20 h-6 w-6 items-end justify-end",
          resizeHandleOutside ? "-bottom-[9px] -right-[9px]" : "right-2",
          !resizeHandleOutside && resizeHandleTop === undefined && "bottom-2",
          selected ? "flex" : "hidden group-hover/node:flex",
        )}
        style={{ cursor: "nwse-resize", touchAction: "none", top: resizeHandleOutside ? undefined : resizeHandleTop }}
        onPointerDown={onResizeStart}
        title={resizePolicy?.mode === "preserve-aspect" ? "拖拽等比调整节点大小" : "拖拽自由调整节点宽高"}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          className={cn(
            "pointer-events-none overflow-visible text-fg-mute transition-[color,transform] duration-150 group-hover/resize:text-fg",
            resizeHandleOutside ? "h-[15px] w-[15px] group-hover/resize:translate-x-0.5 group-hover/resize:translate-y-0.5" : "h-4 w-4",
          )}
        >
          {resizeHandleOutside ? (
            <>
              <path d="M3.5 12.5h2.1a6.9 6.9 0 0 0 6.9-6.9V3.5" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.45" />
              <path d="M8.2 12.5h.7a3.6 3.6 0 0 0 3.6-3.6v-.7" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.45" />
            </>
          ) : (
            <>
              <path d="M3 13 13 3" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
              <path d="m8 13 5-5" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="2" />
            </>
          )}
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
