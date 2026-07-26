"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
  h1: ({ children }) => <h1 className="mb-2 mt-4 text-[15px] font-semibold leading-snug text-fg first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2 mt-4 text-[14px] font-semibold leading-snug text-fg first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1.5 mt-3 text-[13px] font-semibold leading-snug text-fg first:mt-0">{children}</h3>,
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5 marker:text-fg-mute">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5 marker:text-fg-mute">{children}</ol>,
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-l-2 border-white/20 pl-3 text-fg-mute">{children}</blockquote>
  ),
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="break-words text-[#8fb8ff] underline decoration-[#8fb8ff]/35 underline-offset-2 hover:text-[#b4ceff]"
    >
      {children}
    </a>
  ),
  strong: ({ children }) => <strong className="font-semibold text-fg">{children}</strong>,
  hr: () => <hr className="my-4 border-white/10" />,
  pre: ({ children }) => (
    <pre className="my-3 overflow-x-auto rounded-[10px] border border-white/[0.08] bg-black/25 p-3 text-[11px] leading-relaxed text-fg-dim">
      {children}
    </pre>
  ),
  code: ({ children, className, ...props }) => (
    <code
      className={
        className
          ? `${className} font-mono`
          : "rounded bg-white/[0.08] px-1 py-0.5 font-mono text-[0.92em] text-fg"
      }
      {...props}
    >
      {children}
    </code>
  ),
  table: ({ children }) => (
    <div className="my-3 max-w-full overflow-x-auto rounded-[10px] border border-white/[0.09]">
      <table className="w-full min-w-[360px] border-collapse text-left text-[11px] leading-relaxed">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-white/[0.065] text-fg">{children}</thead>,
  tbody: ({ children }) => <tbody className="divide-y divide-white/[0.07]">{children}</tbody>,
  tr: ({ children }) => <tr className="divide-x divide-white/[0.07] align-top">{children}</tr>,
  th: ({ children }) => <th className="px-2.5 py-2 font-semibold">{children}</th>,
  td: ({ children }) => <td className="px-2.5 py-2">{children}</td>,
};

export function AgentMarkdown({ content }: { content: string }) {
  return (
    <div className="min-w-0 break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
