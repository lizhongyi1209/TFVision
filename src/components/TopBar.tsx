"use client";

// 顶栏（对齐 libTV 布局）：左 = Logo + 画布切换；右 = 历史、设置。

import { useState } from "react";
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
        className="flex h-9 items-center gap-1.5 rounded-control border border-line bg-panel/95 px-3 text-[13px] text-fg backdrop-blur-xl transition-colors hover:border-line-2"
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

export function TopBar({ agentOpen, onAgentToggle }: { agentOpen: boolean; onAgentToggle: () => void }) {
  const setSettingsOpen = useStudio((s) => s.setSettingsOpen);
  const setHistoryOpen = useStudio((s) => s.setHistoryOpen);
  const settings = useStudio((s) => s.settings);

  return (
    <>
      {/* Left cluster */}
      <div className="pointer-events-auto absolute left-4 top-4 z-50 flex items-center gap-2">
        <div
          title="TFvision"
          aria-label="TFvision"
          className="flex h-9 w-9 items-center justify-center rounded-control border border-line bg-panel/95 backdrop-blur-xl"
        >
          <span className="flex h-5 w-5 items-center justify-center rounded-md bg-accent/90 text-[11px] font-bold text-ink">
            TF
          </span>
        </div>
        <BoardSwitcher />
      </div>

      {/* Right cluster */}
      <div className="pointer-events-auto absolute right-4 top-4 z-50 flex items-center gap-2">
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
          onClick={() => setSettingsOpen(true)}
          className={cn(
            "flex h-9 items-center gap-1.5 rounded-control border px-3 text-[13px] backdrop-blur transition-colors",
            settings && !settings.hasApiKey
              ? "border-accent/60 bg-accent/15 text-accent"
              : "border-line bg-panel/95 text-fg-dim backdrop-blur-xl hover:border-line-2 hover:text-fg",
          )}
        >
          <Icon name="Gear" size={14} />
          {settings && !settings.hasApiKey ? "配置令牌" : "设置"}
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
