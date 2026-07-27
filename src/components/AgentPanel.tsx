"use client";

import { type ReactNode, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStudio } from "@/lib/store";
import { cn } from "@/lib/utils";
import { MODELS } from "@/lib/models";
import type { AgentImagePlan, AgentVideoPlan, HistoryItem, ModelName } from "@/lib/types";
import { deleteAgentMedia, loadAgentMedia, persistAgentMedia } from "@/lib/agentMediaStore";
import { AgentMarkdown } from "./AgentMarkdown";
import { Icon } from "./icons";

type AgentCapability = "chat" | "image" | "video" | "code";
type AgentActivityItem = {
  id: string;
  label: string;
  tone?: "default" | "warning";
};
type AgentVisual = {
  dataUrl: string;
  label: string;
  timestamp?: number;
};
type AgentAttachment = {
  id: string;
  label: string;
  kind: "image" | "video" | "file" | "asset" | "canvas";
  previewUrl?: string;
  dataUrl?: string;
  frames?: Array<{ dataUrl: string; timestamp: number }>;
  duration?: number;
  width?: number;
  height?: number;
  blob?: Blob;
  objectUrl?: boolean;
  sourceUrl?: string;
  generated?: boolean;
};

type AgentMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  webSearch?: boolean;
  attachments?: AgentAttachment[];
  capability?: AgentCapability;
  generation?: AgentImagePlan & { model: ModelName };
  activity?: AgentActivityItem[];
};

type AgentConversation = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: AgentMessage[];
};

const AGENT_HISTORY_KEY = "tfvision.agent.history.v1";
const MAX_AGENT_IMAGES = 4;
const MAX_AGENT_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_AGENT_VIDEO_BYTES = 200 * 1024 * 1024;
const MAX_AGENT_VISUALS = 36;
const MAX_AGENT_VIDEOS = 1;
const MAX_IMAGE_OVERLOAD_RETRIES = 3;
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

function attachmentId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function fileToDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("无法读取媒体"));
    reader.readAsDataURL(file);
  });
}

function messagesForStorage(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => ({
    ...message,
    attachments: message.attachments?.map(
      ({ dataUrl: _dataUrl, frames: _frames, blob: _blob, objectUrl: _objectUrl, previewUrl, sourceUrl, ...attachment }) => ({
        ...attachment,
        previewUrl: previewUrl?.startsWith("data:") || previewUrl?.startsWith("blob:") ? undefined : previewUrl,
        sourceUrl: sourceUrl?.startsWith("blob:") ? undefined : sourceUrl,
      }),
    ),
  }));
}

function mediaEntries(messages: AgentMessage[]) {
  return messages.flatMap((message) =>
    (message.attachments ?? []).flatMap((attachment) => {
      if (attachment.kind === "image" && attachment.dataUrl) {
        return [{ id: attachment.id, source: attachment.dataUrl }];
      }
      if (attachment.kind === "video") {
        const source = attachment.blob || attachment.sourceUrl || attachment.previewUrl;
        return source ? [{ id: attachment.id, source }] : [];
      }
      return [];
    }),
  );
}

function mediaIds(messages: AgentMessage[]) {
  return messages.flatMap((message) =>
    (message.attachments ?? []).flatMap((attachment) =>
      attachment.kind === "image" || attachment.kind === "video" ? [attachment.id] : [],
    ),
  );
}

function revokeMessageObjectUrls(messages: AgentMessage[]) {
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      if (attachment.objectUrl && attachment.previewUrl?.startsWith("blob:")) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
    }
  }
}

function revokeAttachmentObjectUrls(attachments: AgentAttachment[]) {
  for (const attachment of attachments) {
    if (attachment.objectUrl && attachment.previewUrl?.startsWith("blob:")) {
      URL.revokeObjectURL(attachment.previewUrl);
    }
  }
}

async function hydrateMessageMedia(messages: AgentMessage[]) {
  const blobs = await loadAgentMedia(mediaIds(messages));
  const recoverable = messages.flatMap((message) =>
    (message.attachments ?? []).flatMap((attachment) => {
      if ((attachment.kind !== "image" && attachment.kind !== "video") || blobs.has(attachment.id)) return [];
      const sourceUrl = attachment.sourceUrl || attachment.previewUrl;
      return sourceUrl ? [{ id: attachment.id, sourceUrl }] : [];
    }),
  );
  await Promise.all(
    [...new Map(recoverable.map((item) => [item.id, item])).values()].map(async ({ id, sourceUrl }) => {
      try {
        const url = new URL(sourceUrl, window.location.href);
        if (url.origin !== window.location.origin) return;
        const response = await fetch(url);
        if (response.ok) blobs.set(id, await response.blob());
      } catch {
        // The original asset may have been removed; keep the text-only attachment metadata.
      }
    }),
  );
  const dataUrls = new Map(
    await Promise.all(
      [...blobs.entries()]
        .filter(([id]) =>
          messages.some((message) =>
            message.attachments?.some((attachment) => attachment.id === id && attachment.kind === "image"),
          ),
        )
        .map(async ([id, blob]) => [id, await fileToDataUrl(blob)] as const),
    ),
  );
  if (blobs.size) {
    void persistAgentMedia([...blobs.entries()].map(([id, blob]) => ({ id, source: blob })));
  }
  return messages.map((message) => ({
    ...message,
    attachments: message.attachments?.map((attachment) => {
      const dataUrl = dataUrls.get(attachment.id);
      if (dataUrl) return { ...attachment, dataUrl, previewUrl: dataUrl };
      const blob = blobs.get(attachment.id);
      if (attachment.kind === "video" && blob) {
        const objectUrl = URL.createObjectURL(blob);
        return { ...attachment, blob, previewUrl: objectUrl, sourceUrl: objectUrl, objectUrl: true };
      }
      return attachment;
    }),
  }));
}

function requestMessage(message: AgentMessage) {
  const labels = message.attachments?.map((attachment) => attachment.label) ?? [];
  const suffix = labels.length ? `\n\n引用：${labels.join("、")}` : "";
  const visuals: AgentVisual[] = [];
  if (message.role === "user") {
    for (const attachment of message.attachments ?? []) {
      if (attachment.dataUrl) visuals.push({ dataUrl: attachment.dataUrl, label: attachment.label });
      for (const frame of attachment.frames ?? []) {
        visuals.push({ dataUrl: frame.dataUrl, label: attachment.label, timestamp: frame.timestamp });
      }
    }
  }
  const generationContext = message.generation
    ? `\n\n[Internal previous image plan: ${JSON.stringify(message.generation)}]`
    : "";
  return {
    role: message.role,
    content: `${message.content}${suffix}${generationContext}`,
    visuals: visuals.length ? visuals : undefined,
  };
}

function latestGeneratedImages(messages: AgentMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const generated = (messages[index].attachments ?? []).filter(
      (attachment) => attachment.kind === "image" && attachment.generated,
    );
    if (generated.length) return generated;
  }
  return [];
}

async function attachmentToDataUrl(attachment: AgentAttachment) {
  if (attachment.dataUrl) return attachment.dataUrl;
  const source = attachment.sourceUrl || attachment.previewUrl;
  if (!source) return null;
  try {
    const url = new URL(source, window.location.href);
    if (url.origin !== window.location.origin && !source.startsWith("blob:")) return null;
    const response = await fetch(source);
    if (!response.ok) return null;
    return await fileToDataUrl(await response.blob());
  } catch {
    return null;
  }
}

function attachmentVisualCount(attachment: AgentAttachment) {
  return (attachment.dataUrl ? 1 : 0) + (attachment.frames?.length ?? 0);
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
    prompt: "基于我上传的参考图，生成一组构图一致但配色和细节不同的视觉变体。",
  },
  {
    icon: "MagicWand",
    title: "拆解画面风格",
    description: "提取可复用的视觉提示词",
    prompt: "分析我上传的参考图，提取主体、构图、材质、光线和色彩风格提示词。",
  },
  {
    icon: "VideoCamera",
    title: "生成动态短片",
    description: "从静帧规划镜头与运动",
    prompt: "根据我上传的图片设计一段短视频，给出镜头运动、主体动作和节奏建议。",
  },
  {
    icon: "Palette",
    title: "统一视觉语言",
    description: "校准整组素材的色彩与质感",
    prompt: "统一我上传素材的色彩、光线和材质表现，让整组内容具有一致的视觉语言。",
  },
  {
    icon: "TextT",
    title: "补全创意提示词",
    description: "将简短想法扩写为生成指令",
    prompt: "把我的简短想法扩写成结构清晰、可直接用于生图的专业提示词。",
  },
  {
    icon: "Crop",
    title: "优化画面构图",
    description: "调整层次、留白和视觉焦点",
    prompt: "分析我上传的画面，优化主体层次、留白比例和视觉焦点，并给出可直接执行的修改建议。",
  },
  {
    icon: "TShirt",
    title: "制作服装变体",
    description: "保留版型，扩展颜色与面料",
    prompt: "保留服装的版型和模特姿态，扩展不同颜色、面料与搭配的商品图变体。",
  },
];

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

function AgentPopover({
  open,
  anchorRef,
  width,
  label,
  onClose,
  children,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLButtonElement | null>;
  width: number;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 12, top: 12, ready: false });

  useLayoutEffect(() => {
    if (!open) return;

    const updatePosition = () => {
      const anchor = anchorRef.current;
      const popover = popoverRef.current;
      if (!anchor || !popover) return;

      const margin = 10;
      const gap = 8;
      const anchorRect = anchor.getBoundingClientRect();
      const popoverHeight = popover.offsetHeight;
      const left = Math.min(
        Math.max(margin, anchorRect.right - width),
        Math.max(margin, window.innerWidth - width - margin),
      );
      const preferredTop = anchorRect.top - popoverHeight - gap;
      const canOpenBelow = anchorRect.bottom + gap + popoverHeight <= window.innerHeight - margin;
      const top = preferredTop >= margin
        ? preferredTop
        : canOpenBelow
          ? anchorRect.bottom + gap
          : Math.max(margin, window.innerHeight - popoverHeight - margin);

      setPosition({ left, top, ready: true });
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [anchorRef, open, width]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, open]);

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <>
      <button
        type="button"
        aria-label={`关闭${label}`}
        className="fixed inset-0 z-[210] cursor-default bg-transparent"
        onClick={onClose}
      />
      <div
        ref={popoverRef}
        role="dialog"
        aria-label={label}
        className="glass popover-enter fixed z-[220]"
        style={{
          left: position.left,
          top: position.top,
          width,
          visibility: position.ready ? "visible" : "hidden",
        }}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}

function AgentActivityPanel({ items, live = false }: { items: AgentActivityItem[]; live?: boolean }) {
  const content = (
    <ol className="tf-agent-activity__steps mt-3 space-y-2.5 pl-5">
      {items.map((item, index) => {
        const active = live && index === items.length - 1;
        return (
          <li
            key={item.id}
            className={cn(
              "relative flex min-h-4 items-start text-[10px] leading-[1.55]",
              item.tone === "warning" ? "text-[#e9c98d]" : active ? "text-[#f5f7f8]" : "text-[#a8aaae]",
            )}
          >
            <span
              className={cn(
                "tf-agent-activity__marker absolute -left-5 top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full",
                active
                  ? item.tone === "warning"
                    ? "tf-agent-activity__marker--warning"
                    : "tf-agent-activity__marker--active"
                  : item.tone === "warning"
                    ? "tf-agent-activity__marker--warning-complete"
                    : "tf-agent-activity__marker--complete",
              )}
            >
              {active ? (
                <span className="tf-agent-activity__pulse h-1.5 w-1.5 rounded-full" />
              ) : (
                <Icon name="Check" size={8} weight="bold" className="relative z-10" />
              )}
            </span>
            <span className={cn(active && "tf-agent-activity__active-label")}>{item.label}</span>
          </li>
        );
      })}
    </ol>
  );

  if (live) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="tf-agent-activity tf-agent-activity--live w-[296px] overflow-hidden rounded-[16px] rounded-bl-[5px] px-3.5 py-3"
      >
        <div className="relative z-10 flex items-center justify-between gap-3">
          <span className="flex items-center gap-2.5 text-[11px] font-medium tracking-[0.02em] text-[#f0f2f3]">
            <span className="tf-agent-activity__core" aria-hidden="true">
              <span />
            </span>
            正在执行
          </span>
          <span className="tf-agent-activity__counter flex items-center gap-1.5 rounded-full px-2 py-1 text-[9px] tabular-nums text-[#a9abad]">
            {items.length} 步
          </span>
        </div>
        {content}
      </div>
    );
  }

  return (
    <details className="tf-agent-activity tf-agent-activity--complete group/activity mb-2.5 overflow-hidden rounded-[12px] px-2.5 py-2">
      <summary className="relative z-10 flex cursor-pointer list-none items-center justify-between gap-3 text-[9px] text-[#a8aaad] marker:hidden">
        <span className="flex items-center gap-2">
          <span className="tf-agent-activity__done flex h-4 w-4 items-center justify-center rounded-full">
            <Icon name="Check" size={9} weight="bold" />
          </span>
          执行记录 · {items.length}/{items.length}
        </span>
        <Icon name="CaretDown" size={9} className="transition-transform group-open/activity:rotate-180" />
      </summary>
      {content}
    </details>
  );
}

export function AgentPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const showToast = useStudio((state) => state.showToast);
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [conversations, setConversations] = useState<AgentConversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyLoadingId, setHistoryLoadingId] = useState<string | null>(null);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<AgentAttachment[]>([]);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [assetPickerOpen, setAssetPickerOpen] = useState(false);
  const [assets, setAssets] = useState<HistoryItem[] | null>(null);
  const [imageModel, setImageModel] = useState<ModelName | null>(null);
  const [imageModelOpen, setImageModelOpen] = useState(false);
  const [continueFromLast, setContinueFromLast] = useState(true);
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [agentActivity, setAgentActivity] = useState<AgentActivityItem[]>([]);
  const [starterPage, setStarterPage] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const imageModelButtonRef = useRef<HTMLButtonElement>(null);
  const agentActivityRef = useRef<AgentActivityItem[]>([]);
  const agentActivityIdRef = useRef(0);

  const visibleStarters = STARTERS.slice(starterPage * 4, starterPage * 4 + 4);

  const writeAgentActivity = (items: AgentActivityItem[]) => {
    agentActivityRef.current = items;
    setAgentActivity(items);
    return items;
  };

  const beginAgentActivity = (label: string) => {
    agentActivityIdRef.current += 1;
    return writeAgentActivity([{ id: `activity-${agentActivityIdRef.current}`, label }]);
  };

  const advanceAgentActivity = (
    label: string,
    options: { replaceActive?: boolean; tone?: AgentActivityItem["tone"] } = {},
  ) => {
    const current = agentActivityRef.current;
    if (options.replaceActive && current.length) {
      return writeAgentActivity([
        ...current.slice(0, -1),
        { ...current[current.length - 1], label, tone: options.tone },
      ]);
    }
    agentActivityIdRef.current += 1;
    return writeAgentActivity([
      ...current,
      { id: `activity-${agentActivityIdRef.current}`, label, tone: options.tone },
    ]);
  };

  const completeAgentActivity = (label: string) =>
    advanceAgentActivity(label).map((item) => ({ ...item }));

  useEffect(() => {
    setConversations(readConversationHistory());
    setHistoryLoaded(true);
  }, []);

  useEffect(() => {
    if (!historyLoaded) return;
    window.localStorage.setItem(AGENT_HISTORY_KEY, JSON.stringify(conversations));
  }, [conversations, historyLoaded]);

  useEffect(() => {
    if (open) return;
    setImageModelOpen(false);
  }, [open]);

  const beginNewChat = () => {
    revokeMessageObjectUrls(messages);
    revokeAttachmentObjectUrls(attachments);
    setActiveConversationId(null);
    setMessages([]);
    setPrompt("");
    setAttachments([]);
    setEditingMessageId(null);
    setContinueFromLast(true);
    setHistoryOpen(false);
    inputRef.current?.focus();
  };

  const openConversation = async (conversation: AgentConversation) => {
    if (historyLoadingId) return;
    setHistoryLoadingId(conversation.id);
    try {
      const hydratedMessages = await hydrateMessageMedia(conversation.messages);
      revokeMessageObjectUrls(messages);
      revokeAttachmentObjectUrls(attachments);
      setActiveConversationId(conversation.id);
      setMessages(hydratedMessages);
      setPrompt("");
      setAttachments([]);
      setEditingMessageId(null);
      setContinueFromLast(Boolean(latestGeneratedImages(hydratedMessages).length));
      setHistoryOpen(false);
    } catch {
      showToast("历史媒体加载失败，请检查浏览器存储权限或空间", "error");
    } finally {
      setHistoryLoadingId(null);
    }
  };

  const deleteConversation = (conversationId: string) => {
    const conversation = conversations.find((item) => item.id === conversationId);
    if (conversation) void deleteAgentMedia(mediaIds(conversation.messages));
    setConversations((current) => current.filter((conversation) => conversation.id !== conversationId));
    if (activeConversationId === conversationId) {
      revokeMessageObjectUrls(messages);
      revokeAttachmentObjectUrls(attachments);
      setActiveConversationId(null);
      setMessages([]);
      setPrompt("");
      setAttachments([]);
      setEditingMessageId(null);
      setContinueFromLast(true);
    }
  };

  const copyMessage = async (message: AgentMessage) => {
    await navigator.clipboard.writeText(message.content);
    setCopiedMessageId(message.id);
    window.setTimeout(() => setCopiedMessageId((current) => (current === message.id ? null : current)), 1600);
  };

  const useStarter = (nextPrompt: string) => {
    setEditingMessageId(null);
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

  const analyzeVideoAttachments = async (current: AgentAttachment[]) => {
    if (!current.some((attachment) => attachment.kind === "video" && !attachment.frames?.length)) return current;
    let occupiedVisuals = current.reduce((total, attachment) => total + attachmentVisualCount(attachment), 0);
    const { extractVideoKeyframes } = await import("@/lib/videoKeyframes");
    const analyzed: AgentAttachment[] = [];
    for (const attachment of current) {
      if (attachment.kind !== "video" || attachment.frames?.length) {
        analyzed.push(attachment);
        continue;
      }
      const sourceUrl = attachment.sourceUrl || attachment.previewUrl;
      if (!sourceUrl) throw new Error("历史视频源已失效，请重新添加视频后再发送");
      const frameSlots = MAX_AGENT_VISUALS - occupiedVisuals;
      if (frameSlots < 2) throw new Error("视觉附件过多，请先移除部分图片后再分析视频");
      try {
        const result = await extractVideoKeyframes(sourceUrl, { maxFrames: frameSlots });
        analyzed.push({
          ...attachment,
          frames: result.frames,
          duration: result.duration,
          width: result.width,
          height: result.height,
        });
        occupiedVisuals += result.frames.length;
      } catch {
        throw new Error("视频分析失败，请尝试使用 MP4（H.264）格式后重试");
      }
    }
    return analyzed;
  };

  const removeAttachment = (attachment: AgentAttachment) => {
    const isUsedByMessage = messages.some((message) => message.attachments?.some((item) => item.id === attachment.id));
    if (attachment.objectUrl && attachment.previewUrl && !isUsedByMessage) URL.revokeObjectURL(attachment.previewUrl);
    setAttachments((current) => current.filter((item) => item.id !== attachment.id));
  };

  const toggleAsset = async (asset: HistoryItem) => {
    const label = `资产：${asset.name}`;
    const existing = attachments.find((attachment) => attachment.label === label);
    if (existing) {
      removeAttachment(existing);
      return;
    }

    if (asset.kind === "video") {
      if (attachments.filter((attachment) => attachment.kind === "video").length >= MAX_AGENT_VIDEOS) {
        showToast("每次最多分析 1 个视频", "info");
        return;
      }
      if (asset.size > MAX_AGENT_VIDEO_BYTES) {
        showToast("视频超过 200 MB，无法添加到 Agent", "info");
        return;
      }
      setAttachments((current) => [
        ...current,
        {
          id: `asset-${asset.name}`,
          label,
          kind: "video",
          previewUrl: asset.url,
          sourceUrl: asset.url,
        },
      ]);
      return;
    }

    let dataUrl: string | undefined;
    if (asset.kind === "image") {
      const imageCount = attachments.filter((attachment) => attachment.dataUrl).length;
      if (imageCount >= MAX_AGENT_IMAGES) {
        showToast(`最多添加 ${MAX_AGENT_IMAGES} 张图片`, "info");
        return;
      }
      try {
        const response = await fetch(asset.url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        if (blob.size > MAX_AGENT_IMAGE_BYTES) {
          showToast("图片超过 10 MB，无法发送给 Agent", "info");
          return;
        }
        dataUrl = await fileToDataUrl(blob);
      } catch {
        showToast("无法读取该资产图片", "error");
        return;
      }
    }

    setAttachments((current) => [
      ...current,
      {
        id: `asset-${asset.name}`,
        label,
        kind: asset.kind === "image" ? "image" : "asset",
        previewUrl: asset.kind === "image" ? asset.url : undefined,
        dataUrl,
      },
    ]);
  };

  const addLocalFiles = async (files: File[]) => {
    const imageSlots = MAX_AGENT_IMAGES - attachments.filter((attachment) => attachment.dataUrl).length;
    let visualCount = attachments.reduce((total, attachment) => total + attachmentVisualCount(attachment), 0);
    let videoCount = attachments.filter((attachment) => attachment.kind === "video").length;
    let acceptedImages = 0;
    const next: AgentAttachment[] = [];

    for (const file of files) {
      if (file.type.startsWith("video/")) {
        if (videoCount >= MAX_AGENT_VIDEOS) {
          showToast("每次最多分析 1 个视频", "info");
          continue;
        }
        if (file.size > MAX_AGENT_VIDEO_BYTES) {
          showToast(`${file.name} 超过 200 MB，已跳过`, "info");
          continue;
        }
        const objectUrl = URL.createObjectURL(file);
        next.push({
          id: attachmentId("video"),
          label: file.name,
          kind: "video",
          previewUrl: objectUrl,
          sourceUrl: objectUrl,
          blob: file,
          objectUrl: true,
        });
        videoCount += 1;
        continue;
      }
      if (!file.type.startsWith("image/")) {
        next.push({ id: attachmentId("file"), label: file.name, kind: "file" });
        continue;
      }
      if (visualCount >= MAX_AGENT_VISUALS) {
        showToast("视觉上下文已满，后续图片已跳过", "info");
        continue;
      }
      if (acceptedImages >= imageSlots) continue;
      if (file.size > MAX_AGENT_IMAGE_BYTES) {
        showToast(`${file.name} 超过 10 MB，已跳过`, "info");
        continue;
      }
      try {
        const dataUrl = await fileToDataUrl(file);
        next.push({
          id: attachmentId("image"),
          label: file.name,
          kind: "image",
          previewUrl: dataUrl,
          dataUrl,
        });
        acceptedImages += 1;
        visualCount += 1;
      } catch {
        showToast(`${file.name} 读取失败`, "error");
      }
    }

    if (files.filter((file) => file.type.startsWith("image/")).length > acceptedImages && imageSlots <= acceptedImages) {
      showToast(`最多添加 ${MAX_AGENT_IMAGES} 张图片`, "info");
    }
    if (next.length) setAttachments((current) => [...current, ...next]);
  };

  const editAndResend = (message: AgentMessage) => {
    if (isSending) return;
    setEditingMessageId(message.id);
    setPrompt(message.content);
    setAttachments(message.attachments ?? []);
    setContinueFromLast(false);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(message.content.length, message.content.length);
    });
  };

  const cancelEditing = () => {
    setEditingMessageId(null);
    setPrompt("");
    setAttachments([]);
    inputRef.current?.focus();
  };

  const persistConversation = (
    conversationId: string,
    title: string,
    nextMessages: AgentMessage[],
    updatedAt: number,
  ) => {
    const entries = mediaEntries(nextMessages);
    if (entries.length) {
      void persistAgentMedia(entries).catch(() => showToast("媒体历史保存失败，请检查浏览器存储空间", "error"));
    }
    setConversations((current) => {
      const existing = current.find((conversation) => conversation.id === conversationId);
      const conversation: AgentConversation = {
        id: conversationId,
        title: existing?.title ?? title,
        createdAt: existing?.createdAt ?? updatedAt,
        updatedAt,
        messages: messagesForStorage(nextMessages),
      };
      return [conversation, ...current.filter((item) => item.id !== conversationId)];
    });
  };

  const requestAgentImagePlan = async (
    task: "image-plan" | "image-repair",
    requestMessages: AgentMessage[],
    referenceImages: string[],
    generationModel: ModelName,
    previousPlan?: AgentImagePlan,
    imageError?: string,
  ) => {
    const normalizedMessages = requestMessages.map(requestMessage);
    if (normalizedMessages.length && referenceImages.length) {
      normalizedMessages[normalizedMessages.length - 1] = {
        ...normalizedMessages[normalizedMessages.length - 1],
        visuals: referenceImages.map((dataUrl, index) => ({
          dataUrl,
          label: index === 0 && continueFromLast ? "上一轮生成结果" : `生图参考 ${index + 1}`,
        })),
      };
    }
    const response = await fetch("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task,
        messages: normalizedMessages,
        imageModel: generationModel,
        previousPlan,
        imageError,
      }),
    });
    const payload = (await response.json().catch(() => ({}))) as { plan?: AgentImagePlan; error?: string };
    if (!response.ok || !payload.plan) {
      throw new Error(payload.error || `生图计划生成失败（HTTP ${response.status}）`);
    }
    return payload.plan;
  };

  const createImageReply = async (
    baseMessages: AgentMessage[],
    pendingMessages: AgentMessage[],
    userMessage: AgentMessage,
    conversationId: string,
    title: string,
    initialPlan?: AgentImagePlan,
    resolvedImageModel?: ModelName,
    outputDirectory?: string,
  ) => {
    const imageTools = await import("@/lib/agentImageGeneration");
    const generationModel = resolvedImageModel ?? imageModel ?? "Nano Banana 2";
    const previousImages = continueFromLast ? latestGeneratedImages(baseMessages) : [];
    const explicitImages = (userMessage.attachments ?? []).filter((attachment) => attachment.kind === "image");
    const referenceAttachments = [...previousImages, ...explicitImages]
      .filter((attachment, index, all) => all.findIndex((item) => item.id === attachment.id) === index)
      .slice(0, MAX_AGENT_IMAGES);
    advanceAgentActivity(referenceAttachments.length ? "检查并读取参考素材" : "确认画面目标与生成约束");
    const referenceImages = (
      await Promise.all(referenceAttachments.map((attachment) => attachmentToDataUrl(attachment)))
    ).filter((value): value is string => Boolean(value));

    const planWithOverloadRetry = async (
      task: "image-plan" | "image-repair",
      previousPlan?: AgentImagePlan,
      imageError?: string,
    ) => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await requestAgentImagePlan(task, pendingMessages, referenceImages, generationModel, previousPlan, imageError);
        } catch (error) {
          if (!imageTools.isImageOverloadError(error) || attempt >= MAX_IMAGE_OVERLOAD_RETRIES) throw error;
          const retry = attempt + 1;
          advanceAgentActivity(`规划服务繁忙，自动重试（${retry}/${MAX_IMAGE_OVERLOAD_RETRIES}）`, {
            tone: "warning",
          });
          await imageTools.waitForImageRetry(imageTools.overloadRetryDelay(retry));
          advanceAgentActivity("重新规划生成方案");
        }
      }
    };

    advanceAgentActivity(referenceImages.length ? "理解修改要求并规划生成方案" : "编写提示词并规划生成参数");
    let currentPlan = initialPlan ?? await planWithOverloadRetry("image-plan");
    advanceAgentActivity(currentPlan.note || "生成方案已准备完成");
    let overloadRetries = 0;
    let repairRetries = 0;

    for (;;) {
      try {
        advanceAgentActivity("提交图片生成任务");
        const jobs = await imageTools.submitAgentImageJobs(currentPlan, generationModel, referenceImages);
        advanceAgentActivity("任务已提交，等待生成结果");
        const result = await imageTools.pollAgentImageJobs(jobs, (completed, total, progress) => {
          const percent = typeof progress === "number" ? ` · ${Math.round(progress * 100)}%` : "";
          advanceAgentActivity(completed ? `生成图片 · ${completed}/${total}${percent}` : `生成图片${percent}`, {
            replaceActive: true,
          });
        });
        if (!result.images.length) throw new Error(result.errors.join("；") || "图片生成没有返回结果");

        let exportedPaths: string[] = [];
        let exportError = "";
        if (outputDirectory) {
          advanceAgentActivity(`保存结果到本地目录 · ${outputDirectory}`);
          try {
            const exportResponse = await fetch("/api/agent/export-media", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ urls: result.images, outputDirectory }),
            });
            const exportPayload = (await exportResponse.json().catch(() => ({}))) as { paths?: string[]; error?: string };
            if (!exportResponse.ok || !exportPayload.paths?.length) {
              throw new Error(exportPayload.error || "保存到指定目录失败");
            }
            exportedPaths = exportPayload.paths;
          } catch (error) {
            exportError = (error as Error)?.message || "保存到指定目录失败";
          }
        }

        const completedAt = Date.now();
        const generatedAttachments: AgentAttachment[] = result.images.map((url, index) => ({
          id: attachmentId("generated-image"),
          label: `生成结果 ${index + 1}`,
          kind: "image",
          previewUrl: url,
          sourceUrl: url,
          generated: true,
        }));
        const partialFailure = result.errors.length
          ? `\n\n其中部分任务未完成：${result.errors.map(imageTools.sanitizeImageError).join("；")}`
          : "";
        const exportNote = exportedPaths.length
          ? `\n\n已保存到本地：\n${exportedPaths.map((filePath) => `- \`${filePath}\``).join("\n")}`
          : exportError
            ? `\n\n图片已生成，但保存到指定目录失败：${exportError}`
            : "";
        const assistantMessage: AgentMessage = {
          id: `assistant-image-${completedAt}`,
          role: "assistant",
          content: `图片已经生成完成。你可以继续描述修改要求，我会基于本轮结果继续调整。${partialFailure}${exportNote}`,
          createdAt: completedAt,
          capability: "image",
          generation: { ...currentPlan, model: generationModel },
          attachments: generatedAttachments,
          activity: completeAgentActivity("图片生成完成"),
        };
        const completedMessages = [...pendingMessages, assistantMessage];
        setMessages(completedMessages);
        persistConversation(conversationId, title, completedMessages, completedAt);
        setContinueFromLast(true);
        return;
      } catch (error) {
        if ((error as Error)?.name === "AbortError") throw error;
        const sanitizedError = imageTools.sanitizeImageError(error);
        if (imageTools.isImageOverloadError(error) && overloadRetries < MAX_IMAGE_OVERLOAD_RETRIES) {
          overloadRetries += 1;
          advanceAgentActivity(`生成服务繁忙，自动重试（${overloadRetries}/${MAX_IMAGE_OVERLOAD_RETRIES}）`, {
            tone: "warning",
          });
          await imageTools.waitForImageRetry(imageTools.overloadRetryDelay(overloadRetries));
          advanceAgentActivity("重新提交生成任务");
          continue;
        }
        if (
          !imageTools.isImageOverloadError(error) &&
          !imageTools.isHardImageError(error) &&
          repairRetries < 1
        ) {
          repairRetries += 1;
          advanceAgentActivity("分析失败原因并自动修复方案", { tone: "warning" });
          try {
            currentPlan = await planWithOverloadRetry("image-repair", currentPlan, sanitizedError);
            advanceAgentActivity("修复方案已准备，重新生成");
            continue;
          } catch {
            // Preserve the original generation error when the repair planner itself fails.
          }
        }
        throw new Error(sanitizedError);
      }
    }
  };

  const createVideoReply = async (
    baseMessages: AgentMessage[],
    pendingMessages: AgentMessage[],
    userMessage: AgentMessage,
    conversationId: string,
    title: string,
    plan: AgentVideoPlan,
  ) => {
    const mediaTools = await import("@/lib/agentImageGeneration");
    const reference = (userMessage.attachments ?? []).find((attachment) => attachment.kind === "image")
      ?? (continueFromLast ? latestGeneratedImages(baseMessages)[0] : undefined);
    let imageUrl: string | undefined;
    if (reference) {
      advanceAgentActivity("上传视频首帧参考");
      const dataUrl = await attachmentToDataUrl(reference);
      if (dataUrl) {
        const form = new FormData();
        form.append("file", await (await fetch(dataUrl)).blob(), "agent-first-frame.png");
        const uploadResponse = await fetch("/api/video/upload", { method: "POST", body: form });
        const uploadPayload = (await uploadResponse.json().catch(() => ({}))) as { url?: string; error?: string };
        if (!uploadResponse.ok || !uploadPayload.url) throw new Error(uploadPayload.error || "视频首帧上传失败");
        imageUrl = uploadPayload.url;
      }
    }
    if ((plan.model === "v3" || plan.model === "v2-6") && !imageUrl) {
      throw new Error(`${plan.model} 需要首帧图片，请添加一张参考图后重试`);
    }

    advanceAgentActivity(plan.note || "提交视频生成任务");
    const submitResponse = await fetch("/api/video/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: plan.model,
        mode: plan.mode,
        duration: plan.duration,
        prompt: plan.prompt,
        sound: plan.sound,
        aspectRatio: plan.aspectRatio,
        imageUrl,
      }),
    });
    const submitPayload = (await submitResponse.json().catch(() => ({}))) as { taskId?: string; error?: string };
    if (!submitResponse.ok || !submitPayload.taskId) {
      throw new Error(submitPayload.error || "视频任务提交失败");
    }

    const taskId = submitPayload.taskId;
    const deadline = Date.now() + 15 * 60_000;
    let remoteUrl = "";
    while (Date.now() < deadline) {
      const pollResponse = await fetch(`/api/video/jobs/${encodeURIComponent(taskId)}`);
      const pollPayload = (await pollResponse.json().catch(() => ({}))) as {
        status?: string;
        progress?: number;
        videoUrl?: string;
        error?: string;
      };
      if (pollPayload.status === "success" && pollPayload.videoUrl) {
        remoteUrl = pollPayload.videoUrl;
        break;
      }
      if (pollPayload.status === "failed") throw new Error(pollPayload.error || "视频生成失败");
      const progress = typeof pollPayload.progress === "number" ? ` · ${Math.round(pollPayload.progress * 100)}%` : "";
      advanceAgentActivity(`生成视频${progress}`, { replaceActive: true });
      await mediaTools.waitForImageRetry(5_000);
    }
    if (!remoteUrl) throw new Error("视频生成等待超时，请稍后从历史资产中查看结果");

    advanceAgentActivity(plan.outputDirectory ? `保存视频到本地目录 · ${plan.outputDirectory}` : "保存视频结果");
    const saveResponse = await fetch("/api/video/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        videoUrl: remoteUrl,
        taskId,
        outputDirectory: plan.outputDirectory,
        meta: {
          taskId,
          model: plan.model,
          mode: plan.mode,
          duration: plan.duration,
          prompt: plan.prompt,
          sound: plan.sound,
          aspectRatio: plan.aspectRatio,
          createdAt: Date.now(),
        },
      }),
    });
    const savePayload = (await saveResponse.json().catch(() => ({}))) as {
      localUrl?: string;
      exportedPath?: string;
      error?: string;
    };
    if (!saveResponse.ok || !savePayload.localUrl) throw new Error(savePayload.error || "视频保存失败");

    const completedAt = Date.now();
    const localNote = savePayload.exportedPath ? `\n\n已保存到本地：\`${savePayload.exportedPath}\`` : "";
    const assistantMessage: AgentMessage = {
      id: `assistant-video-${completedAt}`,
      role: "assistant",
      content: `视频已经生成完成。${localNote}`,
      createdAt: completedAt,
      capability: "video",
      attachments: [{
        id: attachmentId("generated-video"),
        label: "生成视频",
        kind: "video",
        previewUrl: savePayload.localUrl,
        sourceUrl: savePayload.localUrl,
        generated: true,
      }],
      activity: completeAgentActivity("视频生成完成"),
    };
    const completedMessages = [...pendingMessages, assistantMessage];
    setMessages(completedMessages);
    persistConversation(conversationId, title, completedMessages, completedAt);
  };

  const send = async () => {
    const defaultContent = "请分析这些附件，并根据内容选择合适的处理方式。";
    const content = prompt.trim() || (attachments.length ? defaultContent : "");
    if (!content || isSending) return;
    const timestamp = Date.now();
    const userMessage: AgentMessage = {
      id: `user-${timestamp}`,
      role: "user",
      content,
      createdAt: timestamp,
      attachments: [...attachments],
      capability: "chat",
    };
    const conversationId = activeConversationId ?? `conversation-${timestamp}`;
    const title = content.replace(/\s+/g, " ").slice(0, 28);
    const editIndex = editingMessageId ? messages.findIndex((message) => message.id === editingMessageId) : -1;
    const baseMessages = editIndex >= 0 ? messages.slice(0, editIndex) : messages;
    const pendingMessages = [...baseMessages, userMessage];
    setMessages(pendingMessages);
    setActiveConversationId(conversationId);
    persistConversation(conversationId, title, pendingMessages, timestamp);
    setPrompt("");
    setAttachments([]);
    setEditingMessageId(null);
    setIsSending(true);
    beginAgentActivity("理解任务并选择合适的工具");
    let requestMessages = pendingMessages;
    let requestMode: AgentCapability = "chat";

    try {
      if ((userMessage.attachments ?? []).some((attachment) => attachment.kind === "video" && !attachment.frames?.length)) {
        advanceAgentActivity("分析视频内容与画面变化");
      }
      const analyzedAttachments = await analyzeVideoAttachments(userMessage.attachments ?? []);
      if (analyzedAttachments !== userMessage.attachments) {
        const analyzedUserMessage = { ...userMessage, attachments: analyzedAttachments };
        requestMessages = [...baseMessages, analyzedUserMessage];
        setMessages(requestMessages);
        persistConversation(conversationId, title, requestMessages, timestamp);
      }
      advanceAgentActivity(
        webSearchEnabled
          ? "组织上下文，并按需调用联网与本地文件工具"
          : "组织上下文，并按需调用本地文件或生图工具",
      );
      const apiMessages = requestMessages.map(requestMessage);
      if (continueFromLast) {
        const previousVisuals = (
          await Promise.all(latestGeneratedImages(baseMessages).slice(0, MAX_AGENT_IMAGES).map(attachmentToDataUrl))
        ).filter((value): value is string => Boolean(value));
        if (apiMessages.length && previousVisuals.length) {
          const lastIndex = apiMessages.length - 1;
          apiMessages[lastIndex] = {
            ...apiMessages[lastIndex],
            visuals: [
              ...(apiMessages[lastIndex].visuals ?? []),
              ...previousVisuals.map((dataUrl, index) => ({ dataUrl, label: `上一轮生成结果 ${index + 1}` })),
            ],
          };
        }
      }
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task: "agent",
          messages: apiMessages,
          webSearch: webSearchEnabled,
          imageModel,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
        webSearch?: boolean;
        toolTrace?: AgentActivityItem[];
        workspaceRoot?: string;
        mode?: AgentCapability;
        plan?: AgentImagePlan;
        imageModel?: ModelName;
        outputDirectory?: string;
        videoPlan?: AgentVideoPlan;
      };
      if (!response.ok || !payload.message) throw new Error(payload.error || `Agent 请求失败（HTTP ${response.status}）`);
      requestMode = payload.mode ?? "chat";
      if (payload.toolTrace?.length) {
        writeAgentActivity(payload.toolTrace);
      } else {
        advanceAgentActivity("整理分析结果与回答结构");
      }
      if (payload.videoPlan) {
        requestMode = "video";
        await createVideoReply(baseMessages, requestMessages, userMessage, conversationId, title, payload.videoPlan);
        return;
      }
      if (payload.plan) {
        requestMode = "image";
        await createImageReply(
          baseMessages,
          requestMessages,
          userMessage,
          conversationId,
          title,
          payload.plan,
          payload.imageModel,
          payload.outputDirectory,
        );
        return;
      }
      const completedAt = Date.now();
      const assistantMessage: AgentMessage = {
        id: `assistant-${completedAt}`,
        role: "assistant",
        content: payload.message,
        createdAt: completedAt,
        capability: requestMode,
        webSearch: payload.webSearch === true,
        activity: completeAgentActivity(requestMode === "code" ? "Coding 任务已完成" : "回答已完成"),
      };
      const completedMessages = [...requestMessages, assistantMessage];
      setMessages(completedMessages);
      persistConversation(conversationId, title, completedMessages, completedAt);
    } catch (error) {
      const completedAt = Date.now();
      const mediaLabel = requestMode === "image" ? "图片" : requestMode === "video" ? "视频" : "";
      const assistantMessage: AgentMessage = {
        id: `assistant-error-${completedAt}`,
        role: "assistant",
        content: `${mediaLabel ? `${mediaLabel}生成失败` : "请求失败"}：${(error as Error)?.message || "请稍后重试"}`,
        createdAt: completedAt,
        capability: requestMode,
        webSearch: mediaLabel ? false : webSearchEnabled,
        activity: completeAgentActivity("任务未完成"),
      };
      const completedMessages = [...requestMessages, assistantMessage];
      setMessages(completedMessages);
      persistConversation(conversationId, title, completedMessages, completedAt);
    } finally {
      agentActivityRef.current = [];
      setAgentActivity([]);
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
                              onClick={() => void openConversation(conversation)}
                              disabled={Boolean(historyLoadingId)}
                              className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2.5 text-left disabled:cursor-wait disabled:opacity-60"
                            >
                              {historyLoadingId === conversation.id ? (
                                <Icon name="CircleNotch" size={10} className="spin shrink-0 text-fg-mute" />
                              ) : (
                                <span
                                  className={cn(
                                    "h-1.5 w-1.5 shrink-0 rounded-full",
                                    activeConversationId === conversation.id ? "bg-white" : "bg-white/20",
                                  )}
                                />
                              )}
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
                              disabled={Boolean(historyLoadingId)}
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
                        "rounded-[16px] px-3.5 py-3 text-[12px] leading-[1.65]",
                        message.role === "user"
                          ? "whitespace-pre-wrap rounded-br-[5px] bg-[#ececea] text-[#19191b]"
                          : "rounded-bl-[5px] border border-white/[0.075] bg-white/[0.035] text-fg-dim",
                        editingMessageId === message.id && "ring-2 ring-white/30 ring-offset-2 ring-offset-[#111113]",
                      )}
                    >
                      {message.attachments?.some((attachment) => attachment.previewUrl) ? (
                        <div
                          className={cn(
                            "mb-2 grid gap-1.5",
                            (message.attachments ?? []).filter((attachment) => attachment.previewUrl).length === 1
                              ? "grid-cols-1"
                              : "grid-cols-2",
                          )}
                        >
                          {message.attachments
                            .filter((attachment) => attachment.previewUrl)
                            .map((attachment) => (
                              attachment.kind === "video" ? (
                                <div
                                  key={attachment.id}
                                  className="flex max-h-[440px] min-h-24 items-center justify-center overflow-hidden rounded-[11px] bg-black/25"
                                >
                                  <video
                                    src={attachment.previewUrl}
                                    muted
                                    controls
                                    preload="metadata"
                                    className="block max-h-[440px] max-w-full object-contain shadow-[0_5px_18px_rgba(0,0,0,0.18)]"
                                  />
                                </div>
                              ) : (
                                <figure
                                  key={attachment.id}
                                  className="flex max-h-[420px] min-h-24 items-center justify-center overflow-hidden rounded-[11px] bg-black/[0.08]"
                                >
                                  <img
                                    src={attachment.previewUrl}
                                    alt={attachment.label}
                                    className="block max-h-[420px] max-w-full object-contain shadow-[0_5px_18px_rgba(0,0,0,0.18)]"
                                  />
                                </figure>
                              )
                            ))}
                        </div>
                      ) : null}
                      {message.role === "assistant" && message.activity?.length ? (
                        <AgentActivityPanel items={message.activity} />
                      ) : null}
                      {message.role === "assistant" ? <AgentMarkdown content={message.content} /> : message.content}
                    </div>
                    <div
                      className={cn(
                        "mt-1.5 flex h-5 items-center gap-2 px-1 text-[9px] tabular-nums text-fg-mute",
                        message.role === "user" ? "justify-end" : "justify-start",
                      )}
                    >
                      {message.role === "assistant" && message.webSearch ? <span>联网</span> : null}
                      <time dateTime={new Date(message.createdAt).toISOString()}>{formatTime(message.createdAt)}</time>
                      {message.role === "user" ? (
                        <button
                          type="button"
                          onClick={() => editAndResend(message)}
                          disabled={isSending}
                          aria-label="编辑并重新发送"
                          title="编辑并重新发送"
                          className="flex h-5 items-center gap-1 rounded px-1 text-fg-mute transition-colors hover:bg-white/[0.05] hover:text-fg disabled:opacity-35"
                        >
                          <Icon name="PencilLine" size={10} />
                          编辑并重发
                        </button>
                      ) : (
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
                      )}
                    </div>
                  </div>
                </div>
              ))}
              {isSending ? (
                <div className="flex justify-start">
                  <AgentActivityPanel
                    items={agentActivity.length ? agentActivity : [{ id: "activity-start", label: "启动 Agent 任务" }]}
                    live
                  />
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
            {editingMessageId ? (
              <div className="mb-2 flex items-center justify-between rounded-[11px] border border-white/[0.08] bg-white/[0.045] px-2.5 py-2 text-[10px] text-fg-dim">
                <span className="flex min-w-0 items-center gap-1.5">
                  <Icon name="PencilLine" size={11} />
                  <span className="truncate">正在编辑已发送内容，重发后将更新此处之后的对话</span>
                </span>
                <button
                  type="button"
                  onClick={cancelEditing}
                  className="ml-2 shrink-0 rounded-md px-1.5 py-0.5 text-fg-mute transition-colors hover:bg-white/[0.06] hover:text-fg"
                >
                  取消
                </button>
              </div>
            ) : null}
            {latestGeneratedImages(messages).length ? (
              <button
                type="button"
                onClick={() => setContinueFromLast((current) => !current)}
                aria-pressed={continueFromLast}
                className={cn(
                  "mb-2 flex w-full items-center gap-2 rounded-[11px] border px-2.5 py-2 text-left text-[10px] transition-colors",
                  continueFromLast
                    ? "border-[#8fb8ff]/20 bg-[#8fb8ff]/[0.08] text-[#bed4ff]"
                    : "border-white/[0.07] bg-white/[0.025] text-fg-mute hover:bg-white/[0.045]",
                )}
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-black/20">
                  <Icon name="Image" size={12} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">参考上一轮生成结果</span>
                  <span className="mt-0.5 block text-[9px] opacity-65">
                    {continueFromLast ? "已开启 · 本轮会继续修改上一张图" : "已关闭 · 本轮将创建新图片"}
                  </span>
                </span>
                {continueFromLast ? <Icon name="Check" size={11} /> : null}
              </button>
            ) : null}
            {attachments.length ? (
              <div className="mb-1.5 flex gap-2 overflow-x-auto px-1 pb-1">
                {attachments.map((attachment) => (
                  <span
                    key={attachment.id}
                    className={cn(
                      "relative shrink-0 overflow-hidden border border-white/[0.085] bg-white/[0.045] text-[10px] text-fg-dim",
                      attachment.previewUrl
                        ? "h-16 w-16 rounded-[12px]"
                        : "flex h-7 max-w-[230px] items-center gap-1.5 rounded-lg pl-2 pr-1",
                    )}
                    title={attachment.label}
                  >
                    {attachment.previewUrl ? (
                      <>
                        {attachment.kind === "video" ? (
                          <video
                            src={attachment.previewUrl}
                            muted
                            preload="metadata"
                            className="h-full w-full bg-black/20 object-contain"
                          />
                        ) : (
                          <img
                            src={attachment.previewUrl}
                            alt={attachment.label}
                            className="h-full w-full bg-black/20 object-contain"
                          />
                        )}
                        <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/90 to-transparent px-1.5 pb-1 pt-4 text-[8px] text-white/80">
                          {attachment.label}
                        </span>
                      </>
                    ) : (
                      <>
                        <Icon name="Paperclip" size={11} />
                        <span className="truncate">{attachment.label}</span>
                      </>
                    )}
                    <button
                      type="button"
                      aria-label={`移除 ${attachment.label}`}
                      onClick={() => removeAttachment(attachment)}
                      className={cn(
                        "flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors",
                        attachment.previewUrl
                          ? "absolute right-1 top-1 bg-black/65 text-white/80 backdrop-blur hover:bg-black/85 hover:text-white"
                          : "text-fg-mute hover:bg-white/[0.06] hover:text-fg",
                      )}
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
              placeholder={
                "描述任务；需要本地文件时，直接写入文件夹路径…"
              }
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
                    void addLocalFiles(Array.from(event.target.files ?? []));
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
                                 const selected = attachments.some((attachment) => attachment.label === label);
                                 return (
                                  <button
                                    key={asset.name}
                                    type="button"
                                    onClick={() => void toggleAsset(asset)}
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
                            已选择 {attachments.filter((attachment) => attachment.label.startsWith("资产：")).length} 项
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
                <div className="relative">
                    <button
                      ref={imageModelButtonRef}
                      type="button"
                      onClick={() => setImageModelOpen((current) => !current)}
                      title="选择图片模型"
                      aria-haspopup="dialog"
                      aria-expanded={imageModelOpen}
                      className="flex h-8 max-w-[86px] shrink-0 items-center gap-1.5 rounded-[10px] px-2 text-[10px] text-fg-mute transition-colors hover:bg-white/[0.055] hover:text-fg"
                    >
                      <Icon name="Image" size={13} />
                      <span className="truncate">{imageModel ? MODELS.find((item) => item.name === imageModel)?.label ?? imageModel : "自动"}</span>
                      <Icon name="CaretDown" size={9} />
                    </button>
                    <AgentPopover
                      open={imageModelOpen}
                      anchorRef={imageModelButtonRef}
                      width={254}
                      label="选择图片生成模型"
                      onClose={() => setImageModelOpen(false)}
                    >
                        <div className="rounded-[15px] p-1.5">
                          <p className="px-2.5 pb-1.5 pt-1 text-[10px] font-medium text-fg-mute">图片生成模型</p>
                          <button
                            type="button"
                            onClick={() => {
                              setImageModel(null);
                              setImageModelOpen(false);
                            }}
                            className="flex w-full items-center gap-2.5 rounded-[11px] px-2.5 py-2 text-left hover:bg-white/[0.055]"
                          >
                            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/[0.045] text-fg-dim">
                              <Icon name="Sparkle" size={13} />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-[11px] text-fg">自动选择</span>
                              <span className="block truncate text-[9px] text-fg-mute">由 Agent 根据任务决定模型</span>
                            </span>
                            {imageModel === null ? <Icon name="Check" size={12} /> : null}
                          </button>
                          {MODELS.map((item) => (
                            <button
                              key={item.name}
                              type="button"
                              onClick={() => {
                                setImageModel(item.name);
                                setImageModelOpen(false);
                              }}
                              className="flex w-full items-center gap-2.5 rounded-[11px] px-2.5 py-2 text-left hover:bg-white/[0.055]"
                            >
                              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-white/[0.045] text-fg-dim">
                                <Icon name="Image" size={13} />
                              </span>
                              <span className="min-w-0 flex-1">
                                <span className="block text-[11px] text-fg">{item.label}</span>
                                <span className="block truncate text-[9px] text-fg-mute">{item.blurb}</span>
                              </span>
                              {imageModel === item.name ? <Icon name="Check" size={12} /> : null}
                            </button>
                          ))}
                        </div>
                    </AgentPopover>
                </div>
              </div>
              <button
                type="button"
                onClick={() => void send()}
                disabled={(!prompt.trim() && !attachments.length) || isSending}
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
