"use client";

// 顶栏（对齐 libTV 布局）：左 = Logo + 画布切换；右 = 历史、设置。

import { useCallback, useEffect, useState } from "react";
import { useStudio } from "@/lib/store";
import { Icon } from "./icons";
import { cn } from "@/lib/utils";

function BoardSwitcher() {
  const boards = useStudio((s) => s.boards);
  const activeBoardId = useStudio((s) => s.activeBoardId);
  const switchBoard = useStudio((s) => s.switchBoard);
  const addBoard = useStudio((s) => s.addBoard);
  const renameBoard = useStudio((s) => s.renameBoard);
  const deleteBoard = useStudio((s) => s.deleteBoard);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  const active = boards.find((b) => b.id === activeBoardId);

  const startRename = (id: string, name: string) => {
    setEditingId(id);
    setEditingName(name);
  };

  const commitRename = () => {
    if (!editingId) return;
    renameBoard(editingId, editingName);
    setEditingId(null);
    setEditingName("");
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex h-9 items-center gap-1.5 rounded-r-[11px] border-l border-line px-3 text-[13px] text-fg transition-colors hover:bg-white/[0.045]"
      >
        {active?.name ?? "画布"}
        <Icon name="CaretDown" size={11} className="text-fg-mute" />
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-[59]" onClick={() => setOpen(false)} />
          <div className="glass absolute left-0 top-full z-[60] mt-1.5 w-[220px] rounded-panel p-1.5">
            {boards.map((b) => (
              <div
                key={b.id}
                className={cn(
                  "group flex w-full items-center gap-1 rounded-control transition-colors",
                  b.id === activeBoardId ? "bg-accent/10" : "hover:bg-white/5",
                )}
              >
                {editingId === b.id ? (
                  <input
                    autoFocus
                    aria-label={`重命名${b.name}`}
                    value={editingName}
                    onChange={(event) => setEditingName(event.target.value)}
                    onClick={(event) => event.stopPropagation()}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setEditingId(null);
                        setEditingName("");
                      }
                    }}
                    className="tf-name-input h-9 w-0 flex-1 rounded-control bg-transparent px-2.5 text-[13px] text-fg"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      switchBoard(b.id);
                      setOpen(false);
                    }}
                    className={cn(
                      "h-9 w-0 flex-1 truncate px-2.5 text-left text-[13px]",
                      b.id === activeBoardId ? "text-accent" : "text-fg",
                    )}
                  >
                    {b.name}
                  </button>
                )}
                {editingId !== b.id ? (
                  <button
                    type="button"
                    title="重命名画布"
                    aria-label={`重命名${b.name}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      startRename(b.id, b.name);
                    }}
                    className="rounded p-1 text-fg-mute opacity-0 transition-[opacity,color] hover:text-fg group-hover:opacity-100"
                  >
                    <Icon name="PencilLine" size={12} />
                  </button>
                ) : null}
                <button
                  type="button"
                  title="删除画布"
                  onClick={() => deleteBoard(b.id)}
                  className="mr-1 rounded p-1 text-fg-mute opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                >
                  <Icon name="Trash" size={12} />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => {
                addBoard();
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-control px-2.5 py-2 text-[13px] text-fg-dim transition-colors hover:bg-white/5 hover:text-fg"
            >
              <Icon name="Plus" size={13} /> 新建画布
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

type BalanceState =
  | { status: "idle" | "loading" }
  | { status: "success"; display: string; rawQuota: number | null; unlimited: boolean }
  | { status: "error"; message: string };

function TokenBalance({ onOpenSettings }: { onOpenSettings: () => void }) {
  const settings = useStudio((s) => s.settings);
  const [balance, setBalance] = useState<BalanceState>({ status: "idle" });

  const refresh = useCallback(async () => {
    if (!settings?.hasApiKey) {
      setBalance({ status: "idle" });
      return;
    }
    setBalance((current) => current.status === "success" ? current : { status: "loading" });
    try {
      const response = await fetch("/api/account/balance", { cache: "no-store" });
      const payload = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        display?: string;
        rawQuota?: number | null;
        unlimited?: boolean;
        error?: string;
      };
      if (!response.ok || !payload.ok || !payload.display) {
        throw new Error(payload.error || "暂时无法获取余额");
      }
      setBalance({
        status: "success",
        display: payload.display,
        rawQuota: payload.rawQuota ?? null,
        unlimited: payload.unlimited === true,
      });
    } catch (error) {
      setBalance((current) => current.status === "success"
        ? current
        : { status: "error", message: error instanceof Error ? error.message : "暂时无法获取余额" });
    }
  }, [settings]);

  useEffect(() => {
    if (!settings?.hasApiKey) {
      setBalance({ status: "idle" });
      return;
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    const refreshOnFocus = () => void refresh();
    window.addEventListener("focus", refreshOnFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [refresh, settings?.hasApiKey]);

  const hasApiKey = settings?.hasApiKey === true;
  const title = !hasApiKey
    ? "配置 API 令牌"
    : balance.status === "success"
    ? balance.unlimited
      ? "当前令牌为无限额度 · 点击管理令牌"
      : `令牌剩余额度${balance.rawQuota != null ? `（${balance.rawQuota.toLocaleString("zh-CN")} quota）` : ""} · 点击管理令牌`
    : balance.status === "error"
      ? `${balance.message} · 点击检查令牌设置`
      : "正在查询令牌余额";

  return (
    <button
      type="button"
      onClick={() => {
        if (hasApiKey) void refresh();
        onOpenSettings();
      }}
      title={title}
      aria-label={title}
      className={cn(
        "group flex h-9 min-w-[132px] items-center justify-center gap-2 rounded-control border px-3 font-mono text-[13px] font-semibold tabular-nums backdrop-blur-xl transition-all active:scale-[0.98]",
        !hasApiKey
          ? "border-accent/60 bg-accent/15 text-accent hover:border-accent/80 hover:bg-accent/20"
          : balance.status === "success"
          ? "border-[#b8ff62]/35 bg-[#b8ff62]/10 text-[#c7ff80] shadow-[0_0_24px_rgba(184,255,98,0.09)] hover:border-[#b8ff62]/60 hover:bg-[#b8ff62]/15"
          : balance.status === "error"
            ? "border-danger/35 bg-danger/10 text-danger hover:border-danger/60"
            : "border-line bg-panel/95 text-fg-mute",
      )}
    >
      <Icon
        name={!hasApiKey ? "Gear" : balance.status === "error" ? "Warning" : "Wallet"}
        size={15}
        weight={hasApiKey && balance.status === "success" ? "fill" : "regular"}
        className={balance.status === "loading" ? "animate-pulse" : undefined}
      />
      {!hasApiKey ? (
        <span className="font-sans text-[12px] font-medium">配置令牌</span>
      ) : balance.status === "success" ? (
        <span><span className="mr-1 font-sans text-[11px] font-medium text-[#c7ff80]/70">余额</span>{balance.display}</span>
      ) : balance.status === "error" ? (
        <span className="font-sans text-[12px]">余额获取失败</span>
      ) : (
        <span className="font-sans text-[12px] font-medium">余额查询中</span>
      )}
      {hasApiKey ? (
        <span className="ml-0.5 flex h-5 items-center border-l border-current/20 pl-2 opacity-60 transition-opacity group-hover:opacity-100">
          <Icon name="Gear" size={12} />
        </span>
      ) : null}
    </button>
  );
}

export function TopBar({
  agentOpen,
  onAgentToggle,
  onDiagnosticsOpen,
}: {
  agentOpen: boolean;
  onAgentToggle: () => void;
  onDiagnosticsOpen: () => void;
}) {
  const setSettingsOpen = useStudio((s) => s.setSettingsOpen);
  const setHistoryOpen = useStudio((s) => s.setHistoryOpen);

  return (
    <>
      {/* Left cluster */}
      <div className="pointer-events-auto absolute left-4 top-4 z-50 flex items-center rounded-control border border-line bg-panel/95 shadow-[0_8px_24px_rgba(0,0,0,0.18)] backdrop-blur-xl transition-colors hover:border-line-2">
        <div
          title="TFvision"
          aria-label="TFvision"
          className="flex h-9 w-9 items-center justify-center"
        >
          <span className="flex h-5 w-5 items-center justify-center rounded-md bg-accent/90 text-[11px] font-bold text-ink">
            TF
          </span>
        </div>
        <BoardSwitcher />
      </div>

      {/* Right cluster */}
      <div className="pointer-events-auto absolute right-4 top-4 z-50 flex items-center gap-2">
        <TokenBalance onOpenSettings={() => setSettingsOpen(true)} />
        <button
          type="button"
          onClick={onDiagnosticsOpen}
          className="flex h-9 items-center gap-1.5 rounded-control border border-line bg-panel/95 px-3 text-[13px] text-fg-dim backdrop-blur-xl transition-colors hover:border-line-2 hover:text-fg active:scale-[0.98]"
        >
          <Icon name="Code" size={14} />
          诊断台
        </button>
        <button
          type="button"
          onClick={() => setHistoryOpen(true)}
          className="flex h-9 items-center gap-1.5 rounded-control border border-line bg-panel/95 px-3 text-[13px] text-fg-dim backdrop-blur-xl transition-colors hover:border-line-2 hover:text-fg"
        >
          <Icon name="ClockCounterClockwise" size={14} />
          资产管理
        </button>
        <button
          type="button"
          onClick={onAgentToggle}
          aria-expanded={agentOpen}
          aria-controls="tf-agent-panel"
          className={cn(
            "flex h-9 items-center gap-1.5 rounded-control border px-3 text-[13px] font-medium backdrop-blur-xl transition-all",
            agentOpen
              ? "border-white/20 bg-white text-[#171719] shadow-[0_10px_28px_rgba(0,0,0,0.28)]"
              : "border-line bg-panel/95 text-fg-dim hover:border-line-2 hover:bg-white/[0.055] hover:text-fg",
          )}
        >
          <Icon name="ChatText" size={14} weight={agentOpen ? "bold" : "regular"} />
          Agent
        </button>
      </div>
    </>
  );
}
