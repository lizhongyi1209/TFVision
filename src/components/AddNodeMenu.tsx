"use client";

// 添加节点菜单 — 双击画布或点节点旁 ⊕ 弹出（libTV 的核心交互）。
// 双击版含「添加资源」段；⊕ 版标题为「引用该节点生成」。

import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useStudio } from "@/lib/store";
import type { NodeKind } from "@/lib/types";
import { Icon } from "./icons";
import { fileToDataURL } from "@/lib/utils";

const NODE_ITEMS: { kind: NodeKind; icon: string; label: string; hint?: string }[] = [
  { kind: "text", icon: "TextT", label: "文本" },
  { kind: "image", icon: "Image", label: "图片" },
  { kind: "video", icon: "FilmSlate", label: "视频" },
];

export function AddNodeMenu() {
  const menu = useStudio((s) => s.menu);
  const closeMenu = useStudio((s) => s.closeMenu);
  const addNode = useStudio((s) => s.addNode);
  const onConnect = useStudio((s) => s.onConnect);
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
      create("image", { url, urls: [url] });
    } catch {
      closeMenu();
    }
  };

  if (!menu) return null;

  // Clamp to viewport
  const W = 232;
  const H = menu.sourceNodeId || menu.targetNodeId ? 220 : 330;
  const x = Math.min(menu.screen.x, (typeof window !== "undefined" ? window.innerWidth : 1600) - W - 16);
  const y = Math.min(menu.screen.y, (typeof window !== "undefined" ? window.innerHeight : 900) - H - 16);
  const linked = !!(menu.sourceNodeId || menu.targetNodeId);

  return (
    <AnimatePresence>
      <motion.div
        ref={ref}
        key={`${menu.screen.x}-${menu.screen.y}`}
        initial={{ opacity: 0, scale: 0.96, y: 4 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97 }}
        transition={{ type: "spring", stiffness: 500, damping: 32 }}
        className="glass fixed z-[90] w-[232px] rounded-panel p-1.5"
        style={{ left: x, top: y }}
      >
        <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-fg-mute">
          {linked ? "引用该节点生成" : "添加节点"}
        </div>
        {NODE_ITEMS.map((item) => (
          <button
            key={item.kind}
            type="button"
            onClick={() => create(item.kind)}
            className="flex w-full items-center gap-2.5 rounded-control px-2.5 py-2 text-left text-[13px] text-fg transition-colors hover:bg-white/5"
          >
            <Icon name={item.icon} size={15} className="text-fg-dim" />
            {item.label}
          </button>
        ))}

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
