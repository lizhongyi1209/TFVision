"use client";

// 资产管理 — 全屏浮层：图片/视频两个 tab、
// 时间排序、点击一张 → 以图片节点放回当前画布。

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useReactFlow } from "@xyflow/react";
import { useStudio } from "@/lib/store";
import type { HistoryItem } from "@/lib/types";
import { cn, formatBytes, formatClock } from "@/lib/utils";
import { Icon } from "./icons";
import { Spinner } from "./ui";

export function HistoryPanel() {
  const open = useStudio((s) => s.historyOpen);
  const setOpen = useStudio((s) => s.setHistoryOpen);
  const addNode = useStudio((s) => s.addNode);
  const showToast = useStudio((s) => s.showToast);
  const rf = useReactFlow();

  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [tab, setTab] = useState<"image" | "video">("image");
  const [desc, setDesc] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/history");
      const payload = (await res.json()) as { items: HistoryItem[] };
      setItems(payload.items);
    } catch {
      setItems([]);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setItems(null);
      void load();
    }
  }, [open, load]);

  const filtered = (items ?? []).filter((i) => i.kind === tab);
  const sorted = desc ? filtered : [...filtered].reverse();

  const placeOnCanvas = (item: HistoryItem) => {
    const center = rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    if (item.kind === "image") {
      addNode("imageAsset", center, {
        url: item.url,
        urls: [item.url],
        label: "历史图片",
      });
    } else {
      addNode("videoAsset", center, {
        url: item.url,
        status: "success",
        progress: 100,
        label: "历史视频",
      });
    }
    setOpen(false);
    showToast("已添加到画布", "success");
  };

  const remove = async (item: HistoryItem) => {
    try {
      await fetch("/api/history", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: item.name }),
      });
      setItems((prev) => (prev ? prev.filter((i) => i.name !== item.name) : prev));
    } catch {
      showToast("删除失败", "error");
    }
  };

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[95] bg-ink/70 p-6 backdrop-blur-sm md:p-10"
          onClick={() => setOpen(false)}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.98, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 8 }}
            transition={{ type: "spring", stiffness: 360, damping: 32 }}
            className="glass mx-auto flex h-full max-w-[1500px] flex-col rounded-panel"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-line px-6 py-4">
              <h2 className="text-[15px] font-semibold text-fg">资产管理</h2>
              <button type="button" onClick={() => setOpen(false)} className="rounded-full p-1.5 text-fg-mute hover:bg-white/5 hover:text-fg">
                <Icon name="X" size={16} />
              </button>
            </div>

            <div className="flex items-center justify-between px-6 py-3">
              <div className="flex items-center gap-4">
                {(["image", "video"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTab(t)}
                    className={cn(
                      "border-b-2 pb-1 text-[13px] transition-colors",
                      tab === t ? "border-accent text-fg" : "border-transparent text-fg-mute hover:text-fg-dim",
                    )}
                  >
                    {t === "image" ? "图片资产" : "视频资产"}({(items ?? []).filter((i) => i.kind === t).length})
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setDesc(!desc)}
                className="flex items-center gap-1.5 text-[12px] text-fg-mute transition-colors hover:text-fg"
              >
                <Icon name="ClockCounterClockwise" size={13} />
                {desc ? "时间降序" : "时间升序"}
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
              {items === null ? (
                <div className="flex h-full items-center justify-center">
                  <Spinner size={22} className="text-fg-mute" />
                </div>
              ) : sorted.length === 0 ? (
                <div className="flex h-full items-center justify-center text-[13px] text-fg-mute">暂无资产</div>
              ) : (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
                  {sorted.map((item) => (
                    <div
                      key={item.name}
                      className="group relative cursor-pointer overflow-hidden rounded-control border border-line bg-panel transition-all hover:border-accent/50"
                      onClick={() => placeOnCanvas(item)}
                      title={item.meta?.prompt || item.videoMeta?.prompt || item.name}
                    >
                      {item.kind === "image" ? (
                        <img src={item.url} alt="" loading="lazy" className="aspect-square w-full object-cover" />
                      ) : (
                        <div className="relative aspect-square w-full">
                          <video src={item.url} muted className="h-full w-full object-cover" />
                          <Icon
                            name="Play"
                            size={26}
                            weight="fill"
                            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-white/80 drop-shadow"
                          />
                        </div>
                      )}
                      <div className="flex items-center justify-between px-2 py-1.5 text-[10px] text-fg-mute">
                        <span>{formatClock(item.createdAt)}</span>
                        <span>{formatBytes(item.size)}</span>
                      </div>
                      <button
                        type="button"
                        title="删除"
                        onClick={(e) => {
                          e.stopPropagation();
                          void remove(item);
                        }}
                        className="absolute right-1.5 top-1.5 rounded-full bg-ink/70 p-1.5 text-fg-dim opacity-0 backdrop-blur transition-opacity hover:text-danger group-hover:opacity-100"
                      >
                        <Icon name="Trash" size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
