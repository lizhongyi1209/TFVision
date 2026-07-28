"use client";

// 添加节点菜单 — 双击画布或点节点旁 ⊕ 弹出（libTV 的核心交互）。
// 双击版含「添加资源」段；⊕ 版标题为「引用该节点生成」。

import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { canConnectNodeKinds, useStudio } from "@/lib/store";
import type { NodeKind } from "@/lib/types";
import { Icon } from "./icons";
import { fileToDataURL } from "@/lib/utils";

const NODE_ITEMS: { kind: NodeKind; icon: string; label: string; section: "基础" | "素材" | "生成" }[] = [
  { kind: "text", icon: "TextT", label: "文本", section: "基础" },
  { kind: "imageAsset", icon: "Image", label: "加载图片", section: "素材" },
  { kind: "videoAsset", icon: "FilmSlate", label: "加载视频", section: "素材" },
  { kind: "imageGenerator", icon: "Sparkle", label: "图片生成", section: "生成" },
  { kind: "videoGenerator", icon: "VideoCamera", label: "视频生成", section: "生成" },
];

export function AddNodeMenu() {
  const menu = useStudio((s) => s.menu);
  const closeMenu = useStudio((s) => s.closeMenu);
  const addNode = useStudio((s) => s.addNode);
  const onConnect = useStudio((s) => s.onConnect);
  const nodes = useStudio((s) => s.nodes);
  const setHistoryOpen = useStudio((s) => s.setHistoryOpen);
  const fileRef = useRef<HTMLInputElement>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu, closeMenu]);

  const create = (kind: NodeKind, init?: Record<string, unknown>) => {
    if (!menu) return;
    const id = addNode(kind, menu.flowPosition, init);
    if (menu.sourceNodeId) onConnect({ source: menu.sourceNodeId, target: id, sourceHandle: null, targetHandle: null });
    if (menu.targetNodeId) onConnect({ source: id, target: menu.targetNodeId, sourceHandle: null, targetHandle: null });
    closeMenu();
  };

  const pickUpload = async (file: File | null) => {
    if (!file || !menu) return;
    try {
      const url = await fileToDataURL(file);
      create("imageAsset", { url, urls: [url] });
    } catch {
      closeMenu();
    }
  };

  if (!menu) return null;

  // Clamp to viewport
  const W = 232;
  const H = menu.sourceNodeId || menu.targetNodeId ? 270 : 430;
  const x = Math.min(menu.screen.x, (typeof window !== "undefined" ? window.innerWidth : 1600) - W - 16);
  const y = Math.min(menu.screen.y, (typeof window !== "undefined" ? window.innerHeight : 900) - H - 16);
  const linked = !!(menu.sourceNodeId || menu.targetNodeId);
  const sourceKind = menu.sourceNodeId ? nodes.find((node) => node.id === menu.sourceNodeId)?.type : undefined;
  const targetKind = menu.targetNodeId ? nodes.find((node) => node.id === menu.targetNodeId)?.type : undefined;
  const visibleItems = NODE_ITEMS.filter((item) => {
    if (menu.sourceNodeId) return canConnectNodeKinds(sourceKind, item.kind);
    if (menu.targetNodeId) return canConnectNodeKinds(item.kind, targetKind);
    return true;
  });

  return (
    <AnimatePresence>
      <motion.div
        ref={ref}
        key={`${menu.screen.x}-${menu.screen.y}`}
        initial={{ opacity: 0, scale: 0.96, y: 4 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97 }}
        transition={{ type: "spring", stiffness: 500, damping: 32 }}
        onMouseDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        className="glass fixed z-[90] w-[232px] select-none rounded-panel p-1.5"
        style={{ left: x, top: y }}
      >
        <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-fg-mute">
          {menu.targetNodeId ? "添加输入节点" : menu.sourceNodeId ? "引用该节点生成" : "添加节点"}
        </div>
        {(["基础", "素材", "生成"] as const).map((section) => {
          const items = visibleItems.filter((item) => item.section === section);
          if (!items.length) return null;
          return (
            <div key={section}>
              <div className="px-2.5 pb-1 pt-2 text-[10px] font-medium tracking-[0.12em] text-fg-mute/80">{section}</div>
              {items.map((item) => (
                <button
                  key={item.kind}
                  type="button"
                  onClick={() => create(item.kind)}
                  className="group/menu flex w-full items-center gap-2.5 rounded-control px-2.5 py-2 text-left text-[13px] text-fg transition-colors hover:bg-white/5"
                >
                  <span className="flex h-7 w-7 items-center justify-center rounded-[8px] border border-white/[0.07] bg-white/[0.025] text-fg-dim transition-colors group-hover/menu:border-white/[0.12] group-hover/menu:text-fg">
                    <Icon name={item.icon} size={14} />
                  </span>
                  {item.label}
                </button>
              ))}
            </div>
          );
        })}

        {!linked ? (
          <>
            <div className="px-2.5 pb-1 pt-2 text-[11px] font-medium text-fg-mute">添加资源</div>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="flex w-full items-center gap-2.5 rounded-control px-2.5 py-2 text-left text-[13px] text-fg transition-colors hover:bg-white/5"
            >
              <Icon name="UploadSimple" size={15} className="text-fg-dim" />
              上传图片
            </button>
            <button
              type="button"
              onClick={() => {
                setHistoryOpen(true);
                closeMenu();
              }}
              className="flex w-full items-center gap-2.5 rounded-control px-2.5 py-2 text-left text-[13px] text-fg transition-colors hover:bg-white/5"
            >
              <Icon name="ClockCounterClockwise" size={15} className="text-fg-dim" />
              从资产管理选择
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                void pickUpload(e.target.files?.[0] ?? null);
                e.currentTarget.value = "";
              }}
            />
          </>
        ) : null}
      </motion.div>
    </AnimatePresence>
  );
}
