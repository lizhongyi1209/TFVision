"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { DiagnosticCategory, DiagnosticEntry, DiagnosticSnapshot } from "@/lib/diagnostics";
import { cn } from "@/lib/utils";
import { Icon } from "./icons";

const FILTERS: Array<{ value: "all" | DiagnosticCategory; label: string }> = [
  { value: "all", label: "全部" },
  { value: "video", label: "视频" },
  { value: "image", label: "图片" },
  { value: "upload", label: "上传" },
  { value: "agent", label: "Agent" },
  { value: "vision", label: "视觉" },
  { value: "settings", label: "连接" },
];

const CATEGORY_LABEL: Record<DiagnosticCategory, string> = {
  image: "图片",
  video: "视频",
  upload: "上传",
  agent: "Agent",
  vision: "视觉",
  settings: "连接",
};

function displayText(value: string, pretty: boolean) {
  if (!value) return "（空）";
  if (!pretty) return value;
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function statusLabel(entry: DiagnosticEntry) {
  if (entry.responseStatus === null) return "网络错误";
  return `${entry.responseStatus}${entry.responseStatusText ? ` ${entry.responseStatusText}` : ""}`;
}

function timestamp(value: number) {
  return new Date(value).toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function PayloadPane({
  title,
  value,
  pretty,
  truncated,
  onCopy,
}: {
  title: string;
  value: string;
  pretty: boolean;
  truncated?: boolean;
  onCopy: () => void;
}) {
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[12px] border border-white/[0.08] bg-black/20">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-white/[0.07] px-3">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-medium text-fg">{title}</span>
          {truncated ? <span className="text-[9px] text-[#f2b96f]">已截断</span> : null}
        </div>
        <button
          type="button"
          onClick={onCopy}
          className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[10px] text-fg-mute transition-colors hover:bg-white/[0.06] hover:text-fg active:scale-[0.98]"
        >
          <Icon name="Copy" size={11} /> 复制原文
        </button>
      </div>
      <pre className="nowheel min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all p-3 font-mono text-[11px] leading-[1.65] text-fg-dim selection:bg-white/20">
        {displayText(value, pretty)}
      </pre>
    </section>
  );
}

export function DiagnosticConsole({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [entries, setEntries] = useState<DiagnosticEntry[]>([]);
  const [maxEntries, setMaxEntries] = useState(100);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | DiagnosticCategory>("all");
  const [live, setLive] = useState(true);
  const [pretty, setPretty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const response = await fetch("/api/diagnostics", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const snapshot = (await response.json()) as DiagnosticSnapshot;
      setEntries(snapshot.entries);
      setMaxEntries(snapshot.maxEntries);
      setSelectedId((current) => current && snapshot.entries.some((entry) => entry.id === current)
        ? current
        : snapshot.entries[0]?.id ?? null);
      setError("");
    } catch (reason) {
      setError(`读取诊断记录失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refresh();
    if (!live) return;
    const timer = window.setInterval(() => void refresh(true), 1_500);
    return () => window.clearInterval(timer);
  }, [live, open, refresh]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  const filteredEntries = useMemo(
    () => filter === "all" ? entries : entries.filter((entry) => entry.category === filter),
    [entries, filter],
  );
  const selected = entries.find((entry) => entry.id === selectedId) ?? filteredEntries[0];

  const copy = async (label: string, value: string) => {
    await navigator.clipboard.writeText(value || "");
    setCopied(label);
    window.setTimeout(() => setCopied(""), 1_400);
  };

  const clear = async () => {
    await fetch("/api/diagnostics", { method: "DELETE" });
    setEntries([]);
    setSelectedId(null);
  };

  return (
    <AnimatePresence>
      {open ? (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[120] bg-ink/76 backdrop-blur-sm"
            onClick={onClose}
          />
          <motion.section
            role="dialog"
            aria-modal="true"
            aria-label="接口诊断台"
            initial={{ opacity: 0, scale: 0.985, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.985, y: 8 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
            className="glass fixed inset-4 z-[121] mx-auto flex h-[calc(100dvh-32px)] max-w-[1440px] flex-col overflow-hidden rounded-[16px] border border-white/[0.1] shadow-[0_28px_90px_rgba(0,0,0,0.52)]"
          >
            <header className="flex h-16 shrink-0 items-center justify-between border-b border-white/[0.08] px-5">
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-white/[0.09] bg-white/[0.045] text-fg">
                  <Icon name="Code" size={17} />
                </span>
                <div className="min-w-0">
                  <h2 className="text-[14px] font-semibold text-fg">接口诊断台</h2>
                  <p className="mt-0.5 truncate text-[10px] text-fg-mute">仅保存在当前服务内存，鉴权信息与大段媒体数据自动脱敏</p>
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  aria-pressed={live}
                  onClick={() => setLive((value) => !value)}
                  className={cn(
                    "flex h-8 items-center gap-1.5 rounded-control border px-2.5 text-[11px] transition-colors active:scale-[0.98]",
                    live ? "border-accent/35 bg-accent/10 text-accent" : "border-line text-fg-mute hover:text-fg",
                  )}
                >
                  <span className={cn("h-1.5 w-1.5 rounded-full", live ? "bg-accent" : "bg-fg-mute")} />
                  {live ? "实时" : "已暂停"}
                </button>
                <button type="button" onClick={() => void refresh()} disabled={loading} className="flex h-8 items-center gap-1.5 rounded-control px-2.5 text-[11px] text-fg-mute hover:bg-white/[0.055] hover:text-fg disabled:opacity-40">
                  <Icon name="ArrowsClockwise" size={12} className={loading ? "animate-spin" : ""} /> 刷新
                </button>
                <button type="button" onClick={() => void clear()} disabled={!entries.length} className="flex h-8 items-center gap-1.5 rounded-control px-2.5 text-[11px] text-fg-mute hover:bg-danger/10 hover:text-danger disabled:opacity-35">
                  <Icon name="Trash" size={12} /> 清空
                </button>
                <button type="button" onClick={onClose} aria-label="关闭诊断台" className="ml-1 flex h-8 w-8 items-center justify-center rounded-full text-fg-mute hover:bg-white/[0.055] hover:text-fg">
                  <Icon name="X" size={14} />
                </button>
              </div>
            </header>

            <div className="flex min-h-0 flex-1">
              <aside className="flex w-[330px] shrink-0 flex-col border-r border-white/[0.08] bg-black/10">
                <div className="grid shrink-0 grid-cols-4 gap-1 border-b border-white/[0.07] p-3">
                  {FILTERS.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      onClick={() => setFilter(item.value)}
                      className={cn(
                        "h-7 rounded-md px-2 text-[10px] transition-colors active:scale-[0.98]",
                        filter === item.value ? "bg-white/[0.1] text-fg" : "text-fg-mute hover:bg-white/[0.05] hover:text-fg",
                      )}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <div className="flex h-9 shrink-0 items-center justify-between px-3 text-[9px] text-fg-mute">
                  <span>{filteredEntries.length} 条记录</span>
                  <span>最多保留 {maxEntries} 条</span>
                </div>
                <div className="nowheel min-h-0 flex-1 overflow-y-auto px-2 pb-2">
                  {filteredEntries.length ? filteredEntries.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      onClick={() => setSelectedId(entry.id)}
                      className={cn(
                        "mb-1 w-full rounded-[10px] border px-3 py-2.5 text-left transition-colors",
                        selected?.id === entry.id
                          ? "border-white/[0.13] bg-white/[0.075]"
                          : "border-transparent hover:border-white/[0.07] hover:bg-white/[0.035]",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-[11px] font-medium text-fg">{entry.label}</span>
                        <span className={cn("shrink-0 font-mono text-[9px]", entry.ok ? "text-accent" : "text-danger")}>{statusLabel(entry)}</span>
                      </div>
                      <div className="mt-1.5 flex items-center gap-2 text-[9px] text-fg-mute">
                        <span>{CATEGORY_LABEL[entry.category]}</span>
                        <span>{entry.method}</span>
                        <span>{entry.durationMs}ms</span>
                        <span className="ml-auto tabular-nums">{timestamp(entry.startedAt)}</span>
                      </div>
                    </button>
                  )) : (
                    <div className="flex h-full min-h-[220px] flex-col items-center justify-center px-6 text-center">
                      <Icon name="Code" size={24} className="text-fg-mute" />
                      <p className="mt-3 text-[12px] text-fg-dim">暂无接口记录</p>
                      <p className="mt-1.5 text-[10px] leading-relaxed text-fg-mute">保持诊断台开启，然后测试生成、上传或连接请求。</p>
                    </div>
                  )}
                </div>
              </aside>

              <main className="flex min-w-0 flex-1 flex-col bg-panel/35 p-4">
                {error ? (
                  <div className="mb-3 flex items-center gap-2 rounded-[10px] border border-danger/30 bg-danger/10 px-3 py-2 text-[11px] text-danger">
                    <Icon name="Warning" size={13} /> {error}
                  </div>
                ) : null}
                {selected ? (
                  <>
                    <div className="mb-3 flex shrink-0 items-start justify-between gap-4 rounded-[12px] border border-white/[0.08] bg-black/15 p-3.5">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="rounded-md bg-white/[0.07] px-2 py-1 font-mono text-[10px] text-fg">{selected.method}</span>
                          <span className={cn("text-[11px] font-medium", selected.ok ? "text-accent" : "text-danger")}>{statusLabel(selected)}</span>
                          <span className="text-[10px] text-fg-mute">{selected.durationMs}ms</span>
                        </div>
                        <button
                          type="button"
                          title="复制请求端点"
                          onClick={() => void copy("endpoint", selected.endpoint)}
                          className="mt-2 block max-w-full break-all text-left font-mono text-[11px] leading-relaxed text-[#87bff6] hover:text-[#a8d2fb]"
                        >
                          {selected.endpoint}
                        </button>
                        {selected.error ? <p className="mt-2 text-[11px] text-danger">{selected.error}</p> : null}
                      </div>
                      <button
                        type="button"
                        onClick={() => setPretty((value) => !value)}
                        className="h-8 shrink-0 rounded-control border border-line px-2.5 text-[10px] text-fg-mute hover:border-line-2 hover:text-fg"
                      >
                        {pretty ? "查看原始文本" : "格式化 JSON"}
                      </button>
                    </div>
                    <div className="flex min-h-0 flex-1 flex-col gap-3 xl:flex-row">
                      <PayloadPane title="请求体" value={selected.requestBody} pretty={pretty} truncated={selected.requestTruncated} onCopy={() => void copy("request", selected.requestBody)} />
                      <PayloadPane title="原始响应体" value={selected.responseBody || selected.error || ""} pretty={pretty} truncated={selected.responseTruncated} onCopy={() => void copy("response", selected.responseBody || selected.error || "")} />
                    </div>
                    {copied ? <div className="pointer-events-none absolute bottom-6 right-6 rounded-control border border-white/[0.1] bg-[#202023] px-3 py-2 text-[11px] text-fg shadow-xl">已复制{copied === "endpoint" ? "端点" : copied === "request" ? "请求体" : "响应体"}</div> : null}
                  </>
                ) : (
                  <div className="flex h-full flex-col items-center justify-center text-center">
                    <Icon name="Code" size={28} className="text-fg-mute" />
                    <p className="mt-3 text-[13px] text-fg-dim">选择一条记录查看完整通信内容</p>
                  </div>
                )}
              </main>
            </div>
          </motion.section>
        </>
      ) : null}
    </AnimatePresence>
  );
}
