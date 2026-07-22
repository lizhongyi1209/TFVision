"use client";

// 底部工具坞（对齐 libTV）：＋添加节点 / 框选 / 适配视图 / 缩放 / 快捷键说明。

import { useReactFlow, useViewport } from "@xyflow/react";
import { useStudio } from "@/lib/store";
import { Icon } from "./icons";
import { AnimatePresence, motion } from "motion/react";

const SHORTCUTS: { keys: string; desc: string }[] = [
  { keys: "双击画布", desc: "打开添加节点菜单" },
  { keys: "拖拽 ⊕ 到另一节点", desc: "连接两个节点" },
  { keys: "Ctrl + Enter", desc: "节点内快速生成" },
  { keys: "Delete / Backspace", desc: "删除选中的节点或连线" },
  { keys: "滚轮 / 触控板", desc: "缩放画布" },
  { keys: "空格 + 拖拽 / 右键拖拽", desc: "平移画布" },
  { keys: "Shift + 拖拽", desc: "框选多个节点" },
];

export function Dock() {
  const rf = useReactFlow();
  const { zoom } = useViewport();
  const openMenu = useStudio((s) => s.openMenu);
  const shortcutsOpen = useStudio((s) => s.shortcutsOpen);
  const setShortcutsOpen = useStudio((s) => s.setShortcutsOpen);

  const addAtCenter = (e: React.MouseEvent) => {
    const flowPosition = rf.screenToFlowPosition({ x: window.innerWidth / 2 - 215, y: window.innerHeight / 2 - 160 });
    openMenu({ flowPosition, screen: { x: e.clientX - 116, y: Math.max(80, e.clientY - 380) } });
  };

  return (
    <>
      <div className="pointer-events-auto absolute bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full border border-line bg-panel/85 px-2 py-1.5 backdrop-blur">
        <button
          type="button"
          title="添加节点"
          onClick={addAtCenter}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/8 text-fg transition-all hover:bg-accent hover:text-ink active:scale-95"
        >
          <Icon name="Plus" size={17} weight="bold" />
        </button>
        <div className="mx-1 h-5 w-px bg-line" />
        <button
          type="button"
          title="适配视图"
          onClick={() => void rf.fitView({ padding: 0.25, duration: 350 })}
          className="flex h-9 w-9 items-center justify-center rounded-full text-fg-dim transition-colors hover:bg-white/5 hover:text-fg"
        >
          <Icon name="CornersOut" size={16} />
        </button>
        <button
          type="button"
          title="缩小"
          onClick={() => void rf.zoomOut({ duration: 180 })}
          className="flex h-9 w-9 items-center justify-center rounded-full text-fg-dim transition-colors hover:bg-white/5 hover:text-fg"
        >
          <Icon name="Minus" size={15} />
        </button>
        <span className="min-w-[44px] text-center text-[12px] tabular-nums text-fg-dim">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          title="放大"
          onClick={() => void rf.zoomIn({ duration: 180 })}
          className="flex h-9 w-9 items-center justify-center rounded-full text-fg-dim transition-colors hover:bg-white/5 hover:text-fg"
        >
          <Icon name="Plus" size={15} />
        </button>
        <div className="mx-1 h-5 w-px bg-line" />
        <button
          type="button"
          title="快捷键"
          onClick={() => setShortcutsOpen(!shortcutsOpen)}
          className="flex h-9 w-9 items-center justify-center rounded-full text-fg-dim transition-colors hover:bg-white/5 hover:text-fg"
        >
          <Icon name="Question" size={16} />
        </button>
      </div>

      <AnimatePresence>
        {shortcutsOpen ? (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ type: "spring", stiffness: 420, damping: 32 }}
            className="glass pointer-events-auto absolute bottom-20 left-1/2 z-50 w-[340px] -translate-x-1/2 rounded-panel p-4"
          >
            <div className="mb-2.5 flex items-center justify-between">
              <span className="text-[12px] font-medium text-fg">快捷键</span>
              <button type="button" onClick={() => setShortcutsOpen(false)} className="rounded p-1 text-fg-mute hover:text-fg">
                <Icon name="X" size={12} />
              </button>
            </div>
            <div className="flex flex-col gap-1.5">
              {SHORTCUTS.map((s) => (
                <div key={s.keys} className="flex items-center justify-between gap-3 text-[12px]">
                  <span className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-[11px] text-fg-dim">{s.keys}</span>
                  <span className="text-fg-mute">{s.desc}</span>
                </div>
              ))}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}
