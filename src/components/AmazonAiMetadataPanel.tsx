"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn, downloadUrl, formatBytes } from "@/lib/utils";
import { Icon } from "./icons";

export type AmazonMetadataImage = {
  index: number;
  src: string;
  label: string;
};

type ApiSuccess = {
  index: number;
  originalName: string;
  name: string;
  url: string;
  bytes: number;
  format: "jpeg" | "png";
  status: "tagged" | "already-tagged";
};

type ApiFailure = {
  index: number;
  originalName: string;
  error: string;
};

type PanelResult = {
  successful: Array<ApiSuccess & { imageIndex: number }>;
  failed: Array<ApiFailure & { imageIndex: number }>;
};

function extensionForBlob(blob: Blob) {
  if (blob.type.includes("png")) return ".png";
  if (blob.type.includes("jpeg") || blob.type.includes("jpg")) return ".jpg";
  if (blob.type.includes("webp")) return ".webp";
  return ".img";
}

export function AmazonAiMetadataPanel({
  images,
  initialIndices,
  taggedIndices,
  nodeLabel,
  canvasZoom,
  onClose,
  onVerified,
}: {
  images: AmazonMetadataImage[];
  initialIndices: number[];
  taggedIndices: number[];
  nodeLabel: string;
  canvasZoom: number;
  onClose: () => void;
  onVerified: (indices: number[]) => void;
}) {
  const [selectedIndices, setSelectedIndices] = useState(() => new Set(initialIndices));
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PanelResult | null>(null);
  const [mounted, setMounted] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const tagged = useMemo(() => new Set(taggedIndices), [taggedIndices]);
  const selectedImages = images.filter((image) => selectedIndices.has(image.index));

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  useEffect(() => setMounted(true), []);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const anchor = anchorRef.current;
    if (!mounted || !panel || !anchor) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const anchorRect = anchor.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        const width = panelRect.width || 430;
        const height = panelRect.height || 452;
        const left = Math.max(12, Math.min(window.innerWidth - width - 12, anchorRect.right - width));
        const safeBottom = window.innerHeight - 84;
        const preferredTop = anchorRect.bottom + 8;
        const top = preferredTop + height > safeBottom
          ? Math.max(12, safeBottom - height)
          : preferredTop;
        setPosition((current) => current && Math.abs(current.left - left) < 1 && Math.abs(current.top - top) < 1
          ? current
          : { left: Math.round(left), top: Math.round(top) });
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [canvasZoom, mounted]);

  const toggleImage = (index: number) => {
    if (busy) return;
    setSelectedIndices((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
    setResult(null);
    setError(null);
  };

  const processImages = async () => {
    if (!confirmed || !selectedImages.length || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);

    try {
      const prepared: Array<{ image: AmazonMetadataImage; blob: Blob; name: string }> = [];
      const localFailures: Array<ApiFailure & { imageIndex: number }> = [];
      for (const image of selectedImages) {
        try {
          const response = await fetch(image.src);
          if (!response.ok) throw new Error(`读取图片失败 HTTP ${response.status}`);
          const blob = await response.blob();
          prepared.push({
            image,
            blob,
            name: `${nodeLabel}-${image.index + 1}${extensionForBlob(blob)}`,
          });
        } catch (fetchError) {
          localFailures.push({
            index: -1,
            imageIndex: image.index,
            originalName: image.label,
            error: fetchError instanceof Error ? fetchError.message : "读取图片失败",
          });
        }
      }

      if (!prepared.length) throw new Error(localFailures[0]?.error || "无法读取所选图片");
      const form = new FormData();
      for (const item of prepared) form.append("files", item.blob, item.name);
      form.append("names", JSON.stringify(prepared.map((item) => item.name)));
      const response = await fetch("/api/image/amazon-ai-metadata", { method: "POST", body: form });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        successful?: ApiSuccess[];
        failed?: ApiFailure[];
      };
      if (!response.ok) throw new Error("处理失败，请重试");

      const successful = (payload.successful ?? []).map((item) => ({
        ...item,
        imageIndex: prepared[item.index]?.image.index ?? -1,
      }));
      const failed = [
        ...localFailures,
        ...(payload.failed ?? []).map((item) => ({
          ...item,
          imageIndex: prepared[item.index]?.image.index ?? -1,
          error: "处理失败，请重试",
        })),
      ];
      const verifiedIndices = successful.map((item) => item.imageIndex).filter((index) => index >= 0);
      if (verifiedIndices.length) onVerified(verifiedIndices);
      setResult({ successful, failed });
      if (!successful.length) setError(failed[0]?.error || "没有图片处理成功");
    } catch (processError) {
      setError(processError instanceof Error ? processError.message : "处理失败，请重试");
    } finally {
      setBusy(false);
    }
  };

  const downloadAll = () => {
    if (!result?.successful.length) return;
    result.successful.forEach((file) => downloadUrl(file.url, file.name));
  };

  const panel = (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="亚马逊合规"
      className="tf-node-popover popover-enter fixed z-[220] w-[430px] origin-top-right overflow-hidden rounded-[16px] border border-line bg-panel/98 text-left shadow-[0_20px_60px_rgba(0,0,0,.48)] backdrop-blur-xl"
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        visibility: position ? "visible" : "hidden",
      }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="flex items-center justify-between border-b border-line px-4 py-3.5">
        <div className="flex items-center gap-2 text-[13px] font-medium text-fg">
          <Icon name="SealCheck" size={15} weight="duotone" />
          亚马逊合规
        </div>
        <button type="button" aria-label="关闭亚马逊合规" disabled={busy} onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-full text-fg-mute transition-colors hover:bg-white/[.07] hover:text-fg disabled:opacity-40">
          <Icon name="X" size={11} weight="bold" />
        </button>
      </div>

      <div className="max-h-[560px] overflow-y-auto overscroll-contain p-4">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium text-fg-dim">选择要处理的图片</span>
          {images.length > 1 ? (
            <div className="flex items-center gap-1 text-[10px]">
              <button type="button" disabled={busy} onClick={() => setSelectedIndices(new Set(images.map((image) => image.index)))} className="rounded-md px-2 py-1 text-fg-mute hover:bg-white/[.05] hover:text-fg">全选</button>
              <button type="button" disabled={busy} onClick={() => setSelectedIndices(new Set())} className="rounded-md px-2 py-1 text-fg-mute hover:bg-white/[.05] hover:text-fg">清空</button>
            </div>
          ) : null}
        </div>

        <div className="mt-2 grid grid-cols-5 gap-1.5">
          {images.map((image) => {
            const active = selectedIndices.has(image.index);
            const verified = tagged.has(image.index);
            return (
              <button
                key={`${image.index}-${image.src.slice(0, 28)}`}
                type="button"
                disabled={busy}
                aria-pressed={active}
                aria-label={`${active ? "取消选择" : "选择"}${image.label}${verified ? "，已完成" : ""}`}
                onClick={() => toggleImage(image.index)}
                className={cn(
                  "group/image relative aspect-square overflow-hidden rounded-[9px] border bg-ink/55 p-1 transition-[border-color,transform,opacity] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40",
                  active ? "border-white/50" : "border-line opacity-60 hover:opacity-90",
                )}
              >
                <img src={image.src} alt="" className="h-full w-full object-contain" draggable={false} />
                <span className={cn(
                  "absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full border backdrop-blur",
                  active ? "border-white/30 bg-white text-ink" : "border-white/15 bg-ink/75 text-transparent",
                )}>
                  <Icon name="Check" size={10} weight="bold" />
                </span>
                {verified ? (
                  <span title="已完成" className="absolute bottom-1 left-1 flex h-5 w-5 items-center justify-center rounded-full border border-emerald-300/20 bg-emerald-950/75 text-emerald-300 backdrop-blur">
                    <Icon name="SealCheck" size={10} weight="fill" />
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
        <div className="mt-2 text-[10px] tabular-nums text-fg-mute">已选择 {selectedImages.length}/{images.length} 张</div>

        <label className="mt-4 flex cursor-pointer items-start gap-2.5 rounded-[12px] border border-line bg-white/[.02] p-3 transition-colors hover:border-line-2">
          <input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} className="mt-0.5 h-3.5 w-3.5 accent-white" />
          <span className="text-[10px] leading-relaxed text-fg-dim">我确认所选图片包含完全由 AI 生成的写实人物，并适用于亚马逊相关要求。</span>
        </label>

        {error ? (
          <div role="alert" className="mt-3 flex items-start gap-2 rounded-[10px] border border-danger/20 bg-danger/[.06] px-3 py-2.5 text-[10px] leading-relaxed text-danger">
            <Icon name="Warning" size={12} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {result ? (
          <div className="mt-3 overflow-hidden rounded-[12px] border border-line">
            <div className="flex items-center justify-between bg-white/[.025] px-3 py-2.5">
              <span className="text-[10px] text-fg-dim">处理完成：{result.successful.length} 成功{result.failed.length ? `，${result.failed.length} 失败` : ""}</span>
              {result.successful.length ? (
                <button type="button" onClick={downloadAll} className="flex h-7 items-center gap-1.5 rounded-full border border-white/12 bg-white/[.05] px-2.5 text-[10px] text-fg transition-colors hover:bg-white/[.1] active:scale-[.98]">
                  <Icon name="Download" size={10} weight="bold" />
                  {result.successful.length > 1 ? "逐张下载" : "下载副本"}
                </button>
              ) : null}
            </div>
            <div className="max-h-[150px] overflow-y-auto">
              {result.successful.map((file) => (
                <div key={file.name} className="flex items-center gap-2 border-t border-line px-3 py-2 text-[9px]">
                  <Icon name="Check" size={10} className="shrink-0 text-emerald-300" weight="bold" />
                  <span className="min-w-0 flex-1 truncate text-fg-dim">图片 {file.imageIndex + 1}</span>
                  <span className="text-fg-mute">已完成</span>
                  <span className="font-mono text-fg-mute">{formatBytes(file.bytes)}</span>
                  <button type="button" aria-label={`下载图片 ${file.imageIndex + 1}`} onClick={() => downloadUrl(file.url, file.name)} className="flex h-6 w-6 items-center justify-center rounded-full text-fg-mute hover:bg-white/[.07] hover:text-fg"><Icon name="Download" size={10} /></button>
                </div>
              ))}
              {result.failed.map((file) => (
                <div key={`${file.imageIndex}-${file.originalName}`} className="flex items-start gap-2 border-t border-line px-3 py-2 text-[9px] text-danger">
                  <Icon name="Warning" size={10} className="mt-0.5 shrink-0" />
                  <span className="min-w-0 flex-1">图片 {file.imageIndex + 1}：{file.error}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <button
          type="button"
          disabled={!confirmed || !selectedImages.length || busy}
          onClick={() => void processImages()}
          className={cn(
            "mt-4 flex h-10 w-full items-center justify-center gap-2 rounded-[10px] text-[11px] font-medium transition-[background,color,transform] active:scale-[.99]",
            !confirmed || !selectedImages.length || busy
              ? "cursor-not-allowed bg-white/[.07] text-fg-mute"
              : "bg-accent text-ink hover:bg-accent-2",
          )}
        >
          <Icon name={busy ? "CircleNotch" : "SealCheck"} size={13} className={busy ? "animate-spin" : ""} weight="bold" />
          {busy ? "正在处理" : `开始处理 (${selectedImages.length})`}
        </button>
        <p className="mt-2 text-center text-[9px] leading-relaxed text-fg-mute">建议在全部裁剪、压缩和导出完成后，将此操作作为上传亚马逊前的最后一步。</p>
      </div>
    </div>
  );

  return (
    <>
      <span ref={anchorRef} aria-hidden="true" className="pointer-events-none absolute right-0 top-full h-0 w-0" />
      {mounted ? createPortal(panel, document.body) : null}
    </>
  );
}
