"use client";

import { useEffect, useRef, useState } from "react";
import { useStudio } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { HistoryItem } from "@/lib/types";
import { Icon } from "./icons";

type AgentMode = "manual" | "auto";
type AgentMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  model?: string;
  reasoningEffort?: string;
  webSearch?: boolean;
};

type AgentConversation = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: AgentMessage[];
};

const AGENT_HISTORY_KEY = "tfvision.agent.history.v1";
const TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatTime(timestamp: number) {
  return TIME_FORMATTER.format(new Date(timestamp));
}

function readConversationHistory(): AgentConversation[] {
  try {
    const value = window.localStorage.getItem(AGENT_HISTORY_KEY);
    if (!value) return [];
    const parsed = JSON.parse(value) as AgentConversation[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((conversation) => conversation && Array.isArray(conversation.messages))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

const STARTERS = [
  {
    icon: "Image",
    title: "商品图换场景",
    description: "保留主体，重做环境与光影",
    prompt: "保留当前商品主体，把场景替换为更高级的商业棚拍环境，并统一光影。",
  },
  {
    icon: "SquaresFour",
    title: "批量生成变体",
    description: "延展构图、配色和表现形式",
    prompt: "基于当前选中的参考图，生成一组构图一致但配色和细节不同的视觉变体。",
  },
  {
    icon: "MagicWand",
    title: "拆解画面风格",
    description: "提取可复用的视觉提示词",
    prompt: "分析当前画布中的参考图，提取主体、构图、材质、光线和色彩风格提示词。",
  },
  {
    icon: "VideoCamera",
    title: "生成动态短片",
    description: "从静帧规划镜头与运动",
    prompt: "根据当前图片节点设计一段短视频，给出镜头运动、主体动作和节奏建议。",
  },
  {
    icon: "Palette",
    title: "统一视觉语言",
    description: "校准整组素材的色彩与质感",
    prompt: "统一当前画布素材的色彩、光线和材质表现，让整组内容具有一致的视觉语言。",
  },
  {
    icon: "TextT",
    title: "补全创意提示词",
    description: "将简短想法扩写为生成指令",
    prompt: "把我的简短想法扩写成结构清晰、可直接用于生图的专业提示词。",
  },
  {
    icon: "Stack",
    title: "整理画布节点",
    description: "按任务阶段规划节点关系",
    prompt: "分析当前画布节点，按输入、处理和输出三个阶段给出更清晰的工作流整理建议。",
  },
  {
    icon: "TShirt",
    title: "制作服装变体",
    description: "保留版型，扩展颜色与面料",
    prompt: "保留服装的版型和模特姿态，扩展不同颜色、面料与搭配的商品图变体。",
  },
];

const AGENT_MODELS = [
  { value: "gpt-5.6-sol", label: "GPT-5.6 Sol", hint: "高推理 · 当前 Agent 大脑" },
] as const;

function StarterCard({
  icon,
  title,
  description,
  onClick,
}: {
  icon: string;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-w-0 items-center gap-3 rounded-[14px] border border-white/[0.075] bg-white/[0.025] p-3 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-white/[0.14] hover:bg-white/[0.05]"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] border border-white/[0.08] bg-[#1d1d20] text-fg-dim shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] transition-colors group-hover:text-fg">
        <Icon name={icon} size={17} />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[12px] font-medium text-fg">{title}</span>
        <span className="mt-0.5 block truncate text-[10px] text-fg-mute">{description}</span>
      </span>
    </button>
  );
}

export function AgentPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nodes = useStudio((state) => state.nodes);
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [conversations, setConversations] = useState<AgentConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [assets, setAssets] = useState<HistoryItem[] | null>(null);
  const [mode, setMode] = useState<AgentMode>("auto");
  const [modeOpen, setModeOpen] = useState(false);
  const [model, setModel] = useState<(typeof AGENT_MODELS)[number]["value"]>("gpt-5.6-sol");
  const [modelOpen, setModelOpen] = useState(false);
  const [webSearchEnabled, setWebSearchEnabled] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [starterPage, setStarterPage] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const selectedNodes = nodes.filter((node) => node.selected && node.type !== "group");
  const selectedCount = selectedNodes.length;
  const visibleStarters = STARTERS.slice(starterPage * 4, starterPage * 4 + 4);

  useEffect(() => {
    setConversations(readConversationHistory());
    setHistoryLoaded(true);
  }, []);

  useEffect(() => {
    if (!historyLoaded) return;
    window.localStorage.setItem(AGENT_HISTORY_KEY, JSON.stringify(conversations));
  }, [conversations, historyLoaded]);

  const beginNewChat = () => {
    setActiveConversationId(null);
    setMessages([]);
    setPrompt("");
    setAttachments([]);
    setHistoryOpen(false);
    inputRef.current?.focus();
  };

  const openConversation = (conversation: AgentConversation) => {
    setActiveConversationId(conversation.id);
    setMessages(conversation.messages);
    setPrompt("");
    setAttachments([]);
    setHistoryOpen(false);
  };

  const deleteConversation = (conversationId: string) => {
    setConversations((current) => current.filter((conversation) => conversation.id !== conversationId));
    if (activeConversationId === conversationId) {
      setActiveConversationId(null);
      setMessages([]);
      setPrompt("");
      setAttachments([]);
    }
  };

  const copyMessage = async (message: AgentMessage) => {
    await navigator.clipboard.writeText(message.content);
    setCopiedMessageId(message.id);
    window.setTimeout(() => setCopiedMessageId((current) => (current === message.id ? null : current)), 1600);
  };

  const useStarter = (nextPrompt: string) => {
    setPrompt(nextPrompt);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const openAssetPicker = async () => {
    setAttachmentMenuOpen(false);
    setAssetPickerOpen(true);
    if (assets !== null) return;
    try {
      const response = await fetch("/api/history");
      const payload = (await response.json()) as { items?: HistoryItem[] };
      setAssets(payload.items ?? []);
    } catch {
      setAssets([]);
    }
  };

  const toggleAsset = (asset: HistoryItem) => {
    const label = `资产：${asset.name}`;
    setAttachments((current) =>
      current.includes(label) ? current.filter((attachment) => attachment !== label) : [...current, label],
    );
  };

  const referenceSelection = () => {
    if (!selectedCount) return;
    const labels = selectedNodes
      .map((node) => {
        const data = node.data as { label?: string };
        return data.label || node.type || "节点";
      })
      .join("、");
    setAttachments((current) => [...current, `画布节点：${labels}`]);
  };

  const persistConversation = (
    conversationId: string,
    title: string,
    nextMessages: AgentMessage[],
    updatedAt: number,
  ) => {
    setConversations((current) => {
      const existing = current.find((conversation) => conversation.id === conversationId);
      const conversation: AgentConversation = {
        id: conversationId,
        title: existing?.title ?? title,
        createdAt: existing?.createdAt ?? updatedAt,
        updatedAt,
        messages: nextMessages,
      };
      return [conversation, ...current.filter((item) => item.id !== conversationId)];
    });
  };

  const send = async () => {
    const content = prompt.trim();
    if (!content || isSending) return;
    const timestamp = Date.now();
    const suffix = attachments.length ? `\n\n引用：${attachments.join("、")}` : "";
    const userMessage: AgentMessage = {
      id: `user-${timestamp}`,
      role: "user",
      content: `${content}${suffix}`,
      createdAt: timestamp,
    };
    const conversationId = activeConversationId ?? `conversation-${timestamp}`;
    const title = content.replace(/\s+/g, " ").slice(0, 28);
    const pendingMessages = [...messages, userMessage];
    setMessages(pendingMessages);
    setActiveConversationId(conversationId);
    persistConversation(conversationId, title, pendingMessages, timestamp);
    setPrompt("");
    setAttachments([]);
    setIsSending(true);

    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: pendingMessages.map((message) => ({ role: message.role, content: message.content })),
          mode,
          webSearch: webSearchEnabled,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
        model?: string;
        reasoningEffort?: string;
        webSearch?: boolean;
      };
      if (!response.ok || !payload.message) throw new Error(payload.error || `Agent 请求失败（HTTP ${response.status}）`);
      const completedAt = Date.now();
      const assistantMessage: AgentMessage = {
        id: `assistant-${completedAt}`,
        role: "assistant",
        content: payload.message,
        createdAt: completedAt,
        model: payload.model || "gpt-5.6-sol",
        reasoningEffort: payload.reasoningEffort || "high",
        webSearch: payload.webSearch === true,
      };
      const completedMessages = [...pendingMessages, assistantMessage];
      setMessages(completedMessages);
      persistConversation(conversationId, title, completedMessages, completedAt);
    } catch (error) {
      const completedAt = Date.now();
      const assistantMessage: AgentMessage = {
        id: `assistant-error-${completedAt}`,
        role: "assistant",
        content: `请求失败：${(error as Error)?.message || "请稍后重试"}`,
        createdAt: completedAt,
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        webSearch: webSearchEnabled,
      };
      const completedMessages = [...pendingMessages, assistantMessage];
      setMessages(completedMessages);
      persistConversation(conversationId, title, completedMessages, completedAt);
    } finally {
      setIsSending(false);
    }
  };

  return (
    <aside
      id="tf-agent-panel"
      aria-hidden={!open}
      className={cn(
        "tf-agent-panel relative z-[70] h-screen shrink-0 overflow-hidden border-l transition-[width,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
        open
          ? "border-white/[0.085] opacity-100"
          : "tf-agent-panel--closed pointer-events-none border-transparent opacity-0",
      )}
    >
      <div className="tf-agent-panel__surface flex h-full min-w-[360px] flex-col overflow-hidden bg-[#111113]">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_72%_-8%,rgba(255,255,255,0.055),transparent_30%)]" />

        <header className="relative flex h-[56px] shrink-0 items-center justify-end border-b border-white/[0.065] px-3.5">
          <div className="flex items-center gap-1">
            <div className="relative">
              <button
                type="button"
                onClick={() => setHistoryOpen((current) => !current)}
                disabled={isSending}
                aria-label="对话历史"
                title="对话历史"
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-[10px] text-fg-mute transition-colors hover:bg-white/[0.055] hover:text-fg disabled:cursor-not-allowed disabled:opacity-35",
                  historyOpen && "bg-white/[0.07] text-fg",
                )}
              >
                <Icon name="ClockCounterClockwise" size={14} />
              </button>
              {historyOpen ? (
                <>
                  <button
                    type="button"
                    aria-label="关闭对话历史"
                    className="fixed inset-0 z-[79] cursor-default"
                    onClick={() => setHistoryOpen(false)}
                  />
                  <div className="glass popover-enter absolute right-0 top-full z-[80] mt-2 w-[300px] rounded-[16px] p-2">
                    <div className="flex items-center justify-between px-2 pb-2 pt-1">
                      <span className="text-[11px] font-medium text-fg">对话历史</span>
                      <span className="text-[9px] tabular-nums text-fg-mute">{conversations.length} 条</span>
                    </div>
                    <div className="max-h-[360px] space-y-1 overflow-y-auto">
                      {conversations.length ? (
                        conversations.map((conversation) => (
                          <div
                            key={conversation.id}
                            className={cn(
                              "group/history flex w-full items-center rounded-[11px] transition-colors hover:bg-white/[0.055]",
                              activeConversationId === conversation.id && "bg-white/[0.065]",
                            )}
                          >
                            <button
                              type="button"
                              onClick={() => openConversation(conversation)}
                              className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2.5 text-left"
                            >
                              <span
                                className={cn(
                                  "h-1.5 w-1.5 shrink-0 rounded-full",
                                  activeConversationId === conversation.id ? "bg-white" : "bg-white/20",
                                )}
                              />
                              <span className="min-w-0 flex-1">
                                <span className="block truncate text-[11px] text-fg-dim">{conversation.title}</span>
                                <span className="mt-0.5 block text-[9px] tabular-nums text-fg-mute">
                                  {formatTime(conversation.updatedAt)}
                                </span>
                              </span>
                              <span className="text-[9px] tabular-nums text-fg-mute">
                                {Math.ceil(conversation.messages.length / 2)} 轮
                              </span>
                            </button>
                            <button
                              type="button"
                              onClick={() => deleteConversation(conversation.id)}
                              aria-label={`删除对话 ${conversation.title}`}
                              title="删除对话"
                              className="mr-1.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-fg-mute opacity-0 transition-[opacity,color,background] hover:bg-white/[0.06] hover:text-danger group-hover/history:opacity-100 focus-visible:opacity-100"
                            >
                              <Icon name="Trash" size={12} />
                            </button>
                          </div>
                        ))
                      ) : (
                        <div className="flex h-24 items-center justify-center text-[10px] text-fg-mute">暂无对话记录</div>
                      )}
                    </div>
                  </div>
                </>
              ) : null}
            </div>
            <button
              type="button"
              onClick={beginNewChat}
              disabled={isSending}
              aria-label="新对话"
              title="新对话"
              className="flex h-8 w-8 items-center justify-center rounded-[10px] text-fg-mute transition-colors hover:bg-white/[0.055] hover:text-fg disabled:cursor-not-allowed disabled:opacity-35"
            >
              <Icon name="Plus" size={14} />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭 Agent"
              title="关闭"
              className="flex h-8 w-8 items-center justify-center rounded-[10px] text-fg-mute transition-colors hover:bg-white/[0.055] hover:text-fg"
            >
              <Icon name="X" size={14} />
            </button>
          </div>
        </header>

        <div className="relative min-h-0 flex-1 overflow-y-auto px-4">
          {messages.length ? (
            <div className="space-y-5 py-6">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={cn("group/message flex", message.role === "user" ? "justify-end" : "justify-start")}
                >
                  <div className="max-w-[88%]">
                    <div
                      className={cn(
                        "whitespace-pre-wrap rounded-[16px] px-3.5 py-3 text-[12px] leading-[1.65]",
                        message.role === "user"
                          ? "rounded-br-[5px] bg-[#ececea] text-[#19191b]"
                          : "rounded-bl-[5px] border border-white/[0.075] bg-white/[0.035] text-fg-dim",
                      )}
                    >
                      {message.content}
                    </div>
                    <div
                      className={cn(
                        "mt-1.5 flex h-5 items-center gap-2 px-1 text-[9px] tabular-nums text-fg-mute",
                        message.role === "user" ? "justify-end" : "justify-start",
                      )}
                    >
                      {message.role === "assistant" && message.model ? (
                        <span className="mr-0.5 text-[8px] tracking-[0.02em] text-fg-mute">
                          {message.model.replace("gpt-", "GPT-")} · {message.reasoningEffort === "high" ? "高推理" : message.reasoningEffort}
                          {message.webSearch ? " · 联网" : ""}
                        </span>
                      ) : null}
                      <time dateTime={new Date(message.createdAt).toISOString()}>{formatTime(message.createdAt)}</time>
                      {message.role === "assistant" ? (
                        <button
                          type="button"
                          onClick={() => void copyMessage(message)}
                          aria-label="复制回复"
                          title="复制回复"
                          className="flex h-5 items-center gap-1 rounded px-1 text-fg-mute transition-colors hover:bg-white/[0.05] hover:text-fg"
                        >
                          <Icon name={copiedMessageId === message.id ? "Check" : "Copy"} size={10} />
                          {copiedMessageId === message.id ? "已复制" : "复制"}
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              ))}
              {isSending ? (
                <div className="flex justify-start">
                  <div className="flex items-center gap-2 rounded-[16px] rounded-bl-[5px] border border-white/[0.075] bg-white/[0.035] px-3.5 py-3 text-[11px] text-fg-dim">
                    <Icon name="CircleNotch" size={13} className="spin text-fg-mute" />
                    <span>GPT-5.6 Sol 正在思考</span>
                    <span className="text-[9px] text-fg-mute">高推理</span>
                  </div>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex h-full min-h-[320px] flex-col justify-end py-4">
              <section className="pb-1">
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-[11px] font-medium text-fg-dim">
                    <Icon name="ChatText" size={13} />
                    可以这样开始
                  </div>
                  <button
                    type="button"
                    onClick={() => setStarterPage((current) => (current + 1) % 2)}
                    className="flex items-center gap-1 text-[10px] text-fg-mute transition-colors hover:text-fg"
                  >
                    <Icon name="Swap" size={11} />
                    换一批
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {visibleStarters.map((starter) => (
                    <StarterCard key={starter.title} {...starter} onClick={() => useStarter(starter.prompt)} />
                  ))}
                </div>
              </section>
            </div>
          )}
        </div>

        <div className="relative shrink-0 px-3.5 pb-3.5 pt-2">
          <div className="rounded-[18px] border border-white/[0.12] bg-[#18181b]/95 p-2 shadow-[0_18px_55px_rgba(0,0,0,0.3),inset_0_1px_0_rgba(255,255,255,0.04)]">
            {attachments.length ? (
              <div className="mb-1.5 flex gap-1.5 overflow-x-auto px-1 pb-1">
                {attachments.map((attachment, index) => (
                  <span
                    key={`${attachment}-${index}`}
                    className="flex h-7 max-w-[230px] shrink-0 items-center gap-1.5 rounded-lg border border-white/[0.085] bg-white/[0.045] pl-2 pr-1 text-[10px] text-fg-dim"
                  >
                    <Icon name="Paperclip" size={11} />
                    <span className="truncate">{attachment}</span>
                    <button
                      type="button"
                      aria-label={`移除 ${attachment}`}
                      onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-mute hover:bg-white/[0.06] hover:text-fg"
                    >
                      <Icon name="X" size={10} />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            <textarea
              ref={inputRef}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
              rows={3}
              placeholder="描述你的创作目标，或引用画布节点…"
              className="tf-agent-prompt max-h-36 min-h-[66px] w-full resize-none bg-transparent px-2 py-1.5 text-[12px] leading-[1.6] text-fg outline-none placeholder:text-[#696970]"
            />
            <div className="flex items-center justify-between gap-2 px-0.5">
              <div className="flex min-w-0 items-center gap-1">
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,.csv,.rtf,.json,.xml,.html,.htm,.zip,.rar,.7z"
                  className="hidden"
                  onChange={(event) => {
                    const names = Array.from(event.target.files ?? []).map((file) => file.name);
                    setAttachments((current) => [...current, ...names]);
                    event.target.value = "";
                  }}
                />
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setAttachmentMenuOpen((current) => !current)}
                    title="添加附件"
                    aria-label="添加附件"
                    className={cn(
                      "flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] text-fg-mute transition-colors hover:bg-white/[0.055] hover:text-fg",
                      attachmentMenuOpen && "bg-white/[0.07] text-fg",
                    )}
                  >
                    <Icon name="Plus" size={16} />
                  </button>
                  {attachmentMenuOpen ? (
                    <>
                      <button
                        type="button"
                        aria-label="关闭附件菜单"
                        className="fixed inset-0 z-[79] cursor-default"
                        onClick={() => setAttachmentMenuOpen(false)}
                      />
                      <div className="glass popover-enter absolute bottom-full left-0 z-[80] mb-2 w-[248px] rounded-[15px] p-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setAttachmentMenuOpen(false);
                            fileRef.current?.click();
                          }}
                          className="flex w-full items-center gap-2.5 rounded-[11px] px-2.5 py-2.5 text-left transition-colors hover:bg-white/[0.055]"
                        >
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-white/[0.045] text-fg-dim">
                            <Icon name="UploadSimple" size={15} />
                          </span>
                          <span className="min-w-0">
                            <span className="block text-[11px] text-fg">本地上传</span>
                            <span className="mt-0.5 block truncate text-[9px] text-fg-mute">图片、文档、视频、音频等</span>
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => void openAssetPicker()}
                          className="flex w-full items-center gap-2.5 rounded-[11px] px-2.5 py-2.5 text-left transition-colors hover:bg-white/[0.055]"
                        >
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-white/[0.045] text-fg-dim">
                            <Icon name="FolderOpen" size={15} />
                          </span>
                          <span className="min-w-0">
                            <span className="block text-[11px] text-fg">从资产管理加入</span>
                            <span className="mt-0.5 block truncate text-[9px] text-fg-mute">选择已有图片或视频资产</span>
                          </span>
                        </button>
                      </div>
                    </>
                  ) : null}
                  {assetPickerOpen ? (
                    <>
                      <button
                        type="button"
                        aria-label="关闭资产选择器"
                        className="fixed inset-0 z-[79] cursor-default"
                        onClick={() => setAssetPickerOpen(false)}
                      />
                      <div className="glass popover-enter absolute bottom-full left-0 z-[80] mb-2 flex w-[338px] flex-col overflow-hidden rounded-[16px]">
                        <div className="flex items-center justify-between border-b border-white/[0.065] px-3.5 py-3">
                          <div>
                            <span className="block text-[11px] font-medium text-fg">从资产管理加入</span>
                            <span className="mt-0.5 block text-[9px] text-fg-mute">可选择多个图片或视频资产</span>
                          </div>
                          <button
                            type="button"
                            onClick={() => setAssetPickerOpen(false)}
                            aria-label="关闭资产选择器"
                            className="flex h-7 w-7 items-center justify-center rounded-lg text-fg-mute hover:bg-white/[0.05] hover:text-fg"
                          >
                            <Icon name="X" size={12} />
                          </button>
                        </div>
                        <div className="max-h-[300px] min-h-[150px] overflow-y-auto p-2.5">
                          {assets === null ? (
                            <div className="flex h-[130px] items-center justify-center text-fg-mute">
                              <Icon name="CircleNotch" size={17} className="spin" />
                            </div>
                          ) : assets.length ? (
                            <div className="grid grid-cols-3 gap-2">
                              {assets.map((asset) => {
                                const label = `资产：${asset.name}`;
                                const selected = attachments.includes(label);
                                return (
                                  <button
                                    key={asset.name}
                                    type="button"
                                    onClick={() => toggleAsset(asset)}
                                    title={asset.name}
                                    className={cn(
                                      "group/asset relative aspect-square overflow-hidden rounded-[10px] border bg-black/20 transition-colors",
                                      selected ? "border-white/70" : "border-white/[0.075] hover:border-white/25",
                                    )}
                                  >
                                    {asset.kind === "image" ? (
                                      <img src={asset.url} alt="" className="h-full w-full object-cover" />
                                    ) : (
                                      <video src={asset.url} muted preload="metadata" className="h-full w-full object-cover" />
                                    )}
                                    <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/90 to-transparent px-1.5 pb-1 pt-4 text-left text-[8px] text-white/75">
                                      {asset.name}
                                    </span>
                                    {asset.kind === "video" ? (
                                      <span className="absolute left-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-md bg-black/60 text-white/80 backdrop-blur">
                                        <Icon name="Play" size={9} weight="fill" />
                                      </span>
                                    ) : null}
                                    {selected ? (
                                      <span className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-white text-black shadow-lg">
                                        <Icon name="Check" size={10} weight="bold" />
                                      </span>
                                    ) : null}
                                  </button>
                                );
                              })}
                            </div>
                          ) : (
                            <div className="flex h-[130px] flex-col items-center justify-center text-center">
                              <Icon name="FolderOpen" size={18} className="text-fg-mute" />
                              <span className="mt-2 text-[10px] text-fg-mute">暂无可用资产</span>
                            </div>
                          )}
                        </div>
                        <div className="flex items-center justify-between border-t border-white/[0.065] px-3 py-2.5">
                          <span className="text-[9px] text-fg-mute">
                            已选择 {attachments.filter((attachment) => attachment.startsWith("资产：")).length} 项
                          </span>
                          <button
                            type="button"
                            onClick={() => setAssetPickerOpen(false)}
                            className="rounded-lg bg-white px-3 py-1.5 text-[10px] font-medium text-black transition-colors hover:bg-white/90"
                          >
                            完成
                          </button>
                        </div>
                      </div>
                    </>
                  ) : null}
                </div>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setModelOpen((current) => !current)}
                    title="选择模型"
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] text-fg-mute transition-colors hover:bg-white/[0.055] hover:text-fg"
                  >
                    <Icon name="Cube" size={15} />
                  </button>
                  {modelOpen ? (
                    <>
                      <button
                        type="button"
                        aria-label="关闭模型菜单"
                        className="fixed inset-0 z-[79] cursor-default"
                        onClick={() => setModelOpen(false)}
                      />
                      <div className="glass popover-enter absolute bottom-full left-0 z-[80] mb-2 w-[252px] rounded-[15px] p-1.5">
                        <p className="px-2.5 pb-1.5 pt-1 text-[10px] font-medium text-fg-mute">Agent 大脑</p>
                        {AGENT_MODELS.map((item) => (
                          <button
                            key={item.value}
                            type="button"
                            onClick={() => {
                              setModel(item.value);
                              setModelOpen(false);
                            }}
                            className="flex w-full items-center gap-2.5 rounded-[11px] px-2.5 py-2 text-left hover:bg-white/[0.055]"
                          >
                            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/[0.045] text-fg-dim">
                              <Icon name="Sparkle" size={13} />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-[11px] text-fg">{item.label}</span>
                              <span className="block truncate text-[9px] text-fg-mute">{item.hint}</span>
                            </span>
                            {model === item.value ? <Icon name="Check" size={12} /> : null}
                          </button>
                        ))}
                      </div>
                    </>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => setWebSearchEnabled((current) => !current)}
                  title={webSearchEnabled ? "联网搜索已开启" : "联网搜索已关闭"}
                  aria-pressed={webSearchEnabled}
                  className={cn(
                    "flex h-8 shrink-0 items-center gap-1.5 rounded-[10px] px-2 text-[10px] transition-colors",
                    webSearchEnabled
                      ? "bg-white/[0.07] text-fg"
                      : "text-fg-mute hover:bg-white/[0.055] hover:text-fg",
                  )}
                >
                  <Icon name="Globe" size={13} />
                  联网
                </button>
                <button
                  type="button"
                  disabled={!selectedCount}
                  onClick={referenceSelection}
                  title={selectedCount ? `引用已选 ${selectedCount} 个节点` : "先在画布中选择节点"}
                  className="flex h-8 shrink-0 items-center gap-1.5 rounded-[10px] px-2 text-[10px] text-fg-mute transition-colors hover:bg-white/[0.055] hover:text-fg disabled:cursor-not-allowed disabled:opacity-35"
                >
                  <Icon name="Selection" size={14} />
                  {selectedCount ? `${selectedCount} 个节点` : "引用节点"}
                </button>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setModeOpen((current) => !current)}
                    className="flex h-8 shrink-0 items-center gap-1.5 rounded-[10px] px-2 text-[10px] text-fg-mute transition-colors hover:bg-white/[0.055] hover:text-fg"
                  >
                    <Icon name={mode === "auto" ? "ArrowsClockwise" : "Hand"} size={13} />
                    {mode === "auto" ? "自动" : "手动"}
                    <Icon name="CaretDown" size={9} />
                  </button>
                  {modeOpen ? (
                    <>
                      <button
                        type="button"
                        aria-label="关闭模式菜单"
                        className="fixed inset-0 z-[79] cursor-default"
                        onClick={() => setModeOpen(false)}
                      />
                      <div className="glass popover-enter absolute bottom-full left-0 z-[80] mb-2 w-[212px] rounded-[15px] p-1.5">
                        {([
                          ["auto", "自动模式", "Agent 自主规划并执行步骤", "ArrowsClockwise"],
                          ["manual", "手动模式", "每次执行前由你确认", "Hand"],
                        ] as const).map(([value, label, hint, icon]) => (
                          <button
                            key={value}
                            type="button"
                            onClick={() => {
                              setMode(value);
                              setModeOpen(false);
                            }}
                            className="flex w-full items-center gap-2.5 rounded-[11px] px-2.5 py-2 text-left hover:bg-white/[0.055]"
                          >
                            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/[0.045] text-fg-dim">
                              <Icon name={icon} size={13} />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-[11px] text-fg">{label}</span>
                              <span className="block text-[9px] text-fg-mute">{hint}</span>
                            </span>
                            {mode === value ? <Icon name="Check" size={12} /> : null}
                          </button>
                        ))}
                      </div>
                    </>
                  ) : null}
                </div>
              </div>
              <button
                type="button"
                onClick={() => void send()}
                disabled={!prompt.trim() || isSending}
                aria-label="发送"
                title="发送"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] bg-[#eeeeec] text-[#161618] shadow-[0_8px_24px_rgba(255,255,255,0.12)] transition-all hover:bg-white active:scale-95 disabled:cursor-not-allowed disabled:bg-white/[0.12] disabled:text-fg-mute disabled:shadow-none"
              >
                <Icon name={isSending ? "CircleNotch" : "ArrowRight"} size={16} weight="bold" className={isSending ? "spin" : undefined} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
