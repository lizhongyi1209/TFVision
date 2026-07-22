"use client";

// 文本节点 — prompt source. Feeds image/video nodes.
// 富文本内联编辑：contentEditable 直接在节点内排版（标题/加粗/列表/分隔线），
// 选中节点时上方浮出格式工具条；纯文本始终同步写回 data.text 供下游取提示词。

import { memo, useCallback, useEffect, useRef } from "react";
import type { NodeProps } from "@xyflow/react";
import type { AppNode } from "@/lib/store";
import { useStudio } from "@/lib/store";
import type { TextNodeData } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Icon } from "../icons";
import { NodeShell } from "./NodeShell";

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** 旧数据只有纯文本：按行还原为段落。 */
const textToHtml = (t: string) =>
  t
    .split("\n")
    .map((line) => `<p>${escapeHtml(line) || "<br>"}</p>`)
    .join("");

type Tool =
  | { type: "divider" }
  | { type: "cmd"; icon: string; title: string; cmd: string; arg?: string };

const TOOLS: Tool[] = [
  { type: "cmd", icon: "Eraser", title: "清除格式", cmd: "clear" },
  { type: "divider" },
  { type: "cmd", icon: "TextHOne", title: "一级标题", cmd: "formatBlock", arg: "H1" },
  { type: "cmd", icon: "TextHTwo", title: "二级标题", cmd: "formatBlock", arg: "H2" },
  { type: "cmd", icon: "TextHThree", title: "三级标题", cmd: "formatBlock", arg: "H3" },
  { type: "cmd", icon: "Paragraph", title: "正文", cmd: "formatBlock", arg: "P" },
  { type: "divider" },
  { type: "cmd", icon: "TextB", title: "加粗", cmd: "bold" },
  { type: "cmd", icon: "TextItalic", title: "斜体", cmd: "italic" },
  { type: "divider" },
  { type: "cmd", icon: "ListBullets", title: "无序列表", cmd: "insertUnorderedList" },
  { type: "cmd", icon: "ListNumbers", title: "有序列表", cmd: "insertOrderedList" },
  { type: "divider" },
  { type: "cmd", icon: "Minus", title: "分隔线", cmd: "insertHorizontalRule" },
];

export const TextNode = memo(function TextNode({ id, selected, data }: NodeProps<AppNode>) {
  const d = data as TextNodeData;
  const updateNode = useStudio((s) => s.updateNode);
  const showToast = useStudio((s) => s.showToast);
  const editorRef = useRef<HTMLDivElement>(null);
  /** 编辑器最近一次写回 store 的纯文本；用于区分自身输入与外部改写（如视觉反推）。 */
  const lastText = useRef<string | null>(null);

  // 外部更新（反推提示词 / 切换画板）时同步 DOM；自身输入不重设，避免光标跳动。
  useEffect(() => {
    const el = editorRef.current;
    if (!el || d.text === lastText.current) return;
    el.innerHTML = d.html ?? textToHtml(d.text);
    lastText.current = d.text;
  }, [d.text, d.html]);

  const emit = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const text = el.innerText.replace(/\n+$/, "");
    lastText.current = text;
    updateNode(id, { text, html: el.innerHTML });
  }, [id, updateNode]);

  const exec = (cmd: string, arg?: string) => {
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    if (cmd === "clear") {
      document.execCommand("removeFormat");
      document.execCommand("formatBlock", false, "P");
    } else {
      document.execCommand(cmd, false, arg);
    }
    emit();
  };

  const toolbar = (
    <div className="glass flex items-center gap-0.5 rounded-2xl px-1.5 py-1">
      {TOOLS.map((t, i) =>
        t.type === "divider" ? (
          <span key={i} className="mx-1 h-4 w-px bg-line-2" />
        ) : (
          <button
            key={i}
            type="button"
            title={t.title}
            // mousedown 阻止默认：保持编辑器焦点与选区，命令才能作用于当前选中文本
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => exec(t.cmd, t.arg)}
            className="rounded-lg p-1.5 text-fg-dim transition-colors hover:bg-white/10 hover:text-fg"
          >
            <Icon name={t.icon} size={14} />
          </button>
        ),
      )}
      <span className="mx-1 h-4 w-px bg-line-2" />
      <button
        type="button"
        title="复制文本"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          navigator.clipboard.writeText(d.text).then(() => showToast("已复制文本", "success"));
        }}
        className="rounded-lg p-1.5 text-fg-dim transition-colors hover:bg-white/10 hover:text-fg"
      >
        <Icon name="Copy" size={14} />
      </button>
    </div>
  );

  return (
    <NodeShell
      id={id}
      selected={selected}
      label={d.label}
      icon="TextT"
      width={d.width || 380}
      height={d.height}
      toolbar={selected ? toolbar : undefined}
      showHeaderActions={false}
    >
      <div data-body style={d.height ? { height: d.height } : undefined} className="relative bg-panel p-3">
        {d.text ? null : (
          <div className="pointer-events-none absolute inset-x-3 top-3 flex flex-col gap-1.5 text-[12px] text-fg-mute">
            <span>写下你想要的画面、场景或指令。例如：</span>
            <span className="text-fg-mute/70">一件白色亚麻衬衫平铺在米色布面上，自然晨光</span>
          </div>
        )}
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          onInput={emit}
          // 粘贴一律转纯文本，避免带入外部样式
          onPaste={(e) => {
            e.preventDefault();
            document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
          }}
          className={cn(
            "tf-richtext nodrag nowheel w-full cursor-text text-[13px] leading-relaxed text-fg",
            d.height ? "h-full overflow-y-auto" : "min-h-[164px]",
          )}
          onMouseDown={(e) => e.stopPropagation()}
          spellCheck={false}
        />
      </div>

      <div className="flex items-center justify-between border-t border-line bg-card px-2.5 py-2 nodrag" onMouseDown={(e) => e.stopPropagation()}>
        <span className="text-[11px] text-fg-mute">{d.text.length} 字</span>
        {d.error ? (
          <span className="max-w-[160px] truncate text-[11px] text-danger" title={d.error}>
            {d.error}
          </span>
        ) : null}
      </div>
    </NodeShell>
  );
});
