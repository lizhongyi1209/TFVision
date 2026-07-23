"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { Icon } from "./icons";

type Size = { width: number; height: number };
type Rect = { x: number; y: number; width: number; height: number };
type Corner = "nw" | "ne" | "sw" | "se";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const normalizeAngle = (value: number) => ((value + 180) % 360 + 360) % 360 - 180;

function loadCanvasImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    if (!src.startsWith("data:") && !src.startsWith("blob:")) image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片加载失败"));
    image.src = src;
  });
}

function useWorkspaceSize(ref: React.RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

function fitImage(workspace: Size, image: Size) {
  if (!workspace.width || !workspace.height || !image.width || !image.height) return { width: 0, height: 0 };
  const scale = Math.min((workspace.width - 48) / image.width, (workspace.height - 48) / image.height);
  return { width: image.width * scale, height: image.height * scale };
}

function EditorFrame({
  title,
  description,
  onClose,
  onSave,
  busy,
  saveDisabled = false,
  saveLabel = "保存覆盖",
  sidebar,
  children,
}: {
  title: string;
  description: string;
  onClose: () => void;
  onSave: () => void;
  busy: boolean;
  saveDisabled?: boolean;
  saveLabel?: string;
  sidebar: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/72 p-5 backdrop-blur-md" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <div role="dialog" aria-modal="true" aria-label={title} className="tf-editor-enter flex h-[min(780px,calc(100vh-40px))] w-[min(1180px,calc(100vw-40px))] flex-col overflow-hidden rounded-[20px] border border-white/12 bg-[#111113] shadow-[0_34px_100px_rgba(0,0,0,0.7)]">
        <header className="flex h-[72px] shrink-0 items-center justify-between border-b border-line px-5">
          <div>
            <div className="text-[14px] font-medium text-fg">{title}</div>
            <div className="mt-1 text-[11px] text-fg-mute">{description}</div>
          </div>
          <button type="button" aria-label="关闭编辑器" onClick={onClose} disabled={busy} className="flex h-9 w-9 items-center justify-center rounded-full text-fg-mute transition-colors hover:bg-white/[0.06] hover:text-fg disabled:opacity-40">
            <Icon name="X" size={15} />
          </button>
        </header>
        <div className="flex min-h-0 flex-1">
          <div className="relative min-w-0 flex-1 overflow-hidden bg-[#09090a]">{children}</div>
          <aside className="w-[228px] shrink-0 border-l border-line bg-[#151517] p-4">{sidebar}</aside>
        </div>
        <footer className="flex h-[68px] shrink-0 items-center justify-end gap-2 border-t border-line px-5">
          <button type="button" onClick={onClose} disabled={busy} className="h-9 rounded-full px-4 text-[12px] text-fg-dim transition-colors hover:bg-white/[0.05] hover:text-fg disabled:opacity-40">取消</button>
          <button type="button" onClick={onSave} disabled={busy || saveDisabled} className="flex h-9 min-w-[92px] items-center justify-center gap-1.5 rounded-full bg-accent px-4 text-[12px] font-medium text-ink transition-colors hover:bg-accent-2 disabled:opacity-50">
            {busy ? <Icon name="CircleNotch" size={13} className="spin" /> : <Icon name="Check" size={13} weight="bold" />}
            {busy ? "处理中" : saveLabel}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

const CROP_RATIOS = [
  { label: "自由", value: null },
  { label: "1:1", value: 1 },
  { label: "4:3", value: 4 / 3 },
  { label: "3:4", value: 3 / 4 },
  { label: "16:9", value: 16 / 9 },
  { label: "9:16", value: 9 / 16 },
] as const;

function cropForRatio(ratio: number | null, image: Size): Rect {
  if (!ratio || !image.width || !image.height) return { x: 0.08, y: 0.08, width: 0.84, height: 0.84 };
  const imageRatio = image.width / image.height;
  let width = 0.84;
  let height = (width * imageRatio) / ratio;
  if (height > 0.84) {
    height = 0.84;
    width = (height * ratio) / imageRatio;
  }
  return { x: (1 - width) / 2, y: (1 - height) / 2, width, height };
}

export function CropEditor({ src, onClose, onApply }: { src: string; onClose: () => void; onApply: (src: string) => void }) {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [imageSize, setImageSize] = useState<Size>({ width: 0, height: 0 });
  const [ratio, setRatio] = useState<number | null>(null);
  const [crop, setCrop] = useState<Rect>({ x: 0.08, y: 0.08, width: 0.84, height: 0.84 });
  const [busy, setBusy] = useState(false);
  const workspace = useWorkspaceSize(workspaceRef);
  const display = useMemo(() => fitImage(workspace, imageSize), [workspace, imageSize]);

  const chooseRatio = (next: number | null) => {
    setRatio(next);
    setCrop(cropForRatio(next, imageSize));
  };

  const beginCrop = (mode: "move" | Corner, event: ReactPointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const wrapper = (event.currentTarget.closest("[data-crop-stage]") as HTMLElement | null);
    if (!wrapper) return;
    const bounds = wrapper.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const start = crop;
    const imageRatio = imageSize.width / imageSize.height || 1;
    const onMove = (pointer: PointerEvent) => {
      const dx = (pointer.clientX - startX) / bounds.width;
      const dy = (pointer.clientY - startY) / bounds.height;
      const minW = 40 / bounds.width;
      const minH = 40 / bounds.height;
      if (mode === "move") {
        setCrop({ ...start, x: clamp(start.x + dx, 0, 1 - start.width), y: clamp(start.y + dy, 0, 1 - start.height) });
        return;
      }
      if (ratio) {
        const fromLeft = mode.includes("w");
        const fromTop = mode.includes("n");
        const anchorX = fromLeft ? start.x + start.width : start.x;
        const anchorY = fromTop ? start.y + start.height : start.y;
        const pointerX = clamp((pointer.clientX - bounds.left) / bounds.width, 0, 1);
        const pointerY = clamp((pointer.clientY - bounds.top) / bounds.height, 0, 1);
        const maxW = fromLeft ? anchorX : 1 - anchorX;
        const maxH = fromTop ? anchorY : 1 - anchorY;
        let width = clamp(Math.abs(pointerX - anchorX), minW, maxW);
        let height = (width * imageRatio) / ratio;
        if (height > maxH) {
          height = maxH;
          width = (height * ratio) / imageRatio;
        }
        if (height < minH) {
          height = Math.min(maxH, minH);
          width = Math.min(maxW, (height * ratio) / imageRatio);
        }
        setCrop({ x: fromLeft ? anchorX - width : anchorX, y: fromTop ? anchorY - height : anchorY, width, height });
        return;
      }
      let left = start.x;
      let top = start.y;
      let right = start.x + start.width;
      let bottom = start.y + start.height;
      if (mode.includes("w")) left = clamp(left + dx, 0, right - minW);
      if (mode.includes("e")) right = clamp(right + dx, left + minW, 1);
      if (mode.includes("n")) top = clamp(top + dy, 0, bottom - minH);
      if (mode.includes("s")) bottom = clamp(bottom + dy, top + minH, 1);
      setCrop({ x: left, y: top, width: right - left, height: bottom - top });
    };
    const onUp = () => window.removeEventListener("pointermove", onMove);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  };

  const save = async () => {
    setBusy(true);
    try {
      const image = await loadCanvasImage(src);
      const sx = Math.round(crop.x * image.naturalWidth);
      const sy = Math.round(crop.y * image.naturalHeight);
      const sw = Math.max(1, Math.round(crop.width * image.naturalWidth));
      const sh = Math.max(1, Math.round(crop.height * image.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = sw;
      canvas.height = sh;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法创建裁剪画布");
      context.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
      onApply(canvas.toDataURL("image/png"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <EditorFrame
      title="裁剪图片"
      description="拖动选区移动，拖拽四角调整范围；保存后覆盖当前图片。"
      onClose={onClose}
      onSave={() => void save()}
      busy={busy}
      sidebar={<>
        <div className="mb-3 text-[11px] font-medium text-fg-dim">裁剪比例</div>
        <div className="grid grid-cols-2 gap-1.5">
          {CROP_RATIOS.map((item) => <button key={item.label} type="button" onClick={() => chooseRatio(item.value)} className={cn("h-9 rounded-control border text-[11px] transition-colors", ratio === item.value ? "border-white/30 bg-white/[0.09] text-fg" : "border-line bg-white/[0.02] text-fg-mute hover:border-line-2 hover:text-fg")}>{item.label}</button>)}
        </div>
        <div className="mt-5 rounded-control border border-line bg-white/[0.025] p-3 text-[10px] leading-relaxed text-fg-mute">
          输出尺寸<br /><span className="text-fg-dim">{imageSize.width ? `${Math.round(crop.width * imageSize.width)} × ${Math.round(crop.height * imageSize.height)} px` : "读取中"}</span>
        </div>
      </>}
    >
      <div ref={workspaceRef} className="absolute inset-0 flex items-center justify-center p-6">
        <div data-crop-stage className="relative overflow-hidden shadow-[0_18px_70px_rgba(0,0,0,0.5)]" style={{ width: display.width, height: display.height }}>
          <img src={src} alt="待裁剪图片" className="absolute inset-0 h-full w-full select-none object-fill" draggable={false} onLoad={(event) => setImageSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />
          <div className="absolute border border-white/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.62)]" style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%` }} onPointerDown={(event) => beginCrop("move", event)}>
            <div className="pointer-events-none absolute inset-x-0 top-1/3 border-t border-white/25" /><div className="pointer-events-none absolute inset-x-0 top-2/3 border-t border-white/25" /><div className="pointer-events-none absolute inset-y-0 left-1/3 border-l border-white/25" /><div className="pointer-events-none absolute inset-y-0 left-2/3 border-l border-white/25" />
            {(["nw", "ne", "sw", "se"] as Corner[]).map((corner) => <button key={corner} type="button" aria-label={`调整裁剪区域 ${corner}`} onPointerDown={(event) => beginCrop(corner, event)} className={cn("absolute h-4 w-4 rounded-[3px] border-2 border-[#111] bg-white shadow", corner.includes("n") ? "-top-2" : "-bottom-2", corner.includes("w") ? "-left-2" : "-right-2", corner === "nw" || corner === "se" ? "cursor-nwse-resize" : "cursor-nesw-resize")} />)}
          </div>
        </div>
      </div>
    </EditorFrame>
  );
}

type BrushMode = "paint" | "line" | "erase";
type BrushPoint = { x: number; y: number };
type BrushStroke = { mode: BrushMode; size: number; points: BrushPoint[] };

function renderBrushStrokes(context: CanvasRenderingContext2D, strokes: BrushStroke[], width: number, height: number, color: string) {
  context.clearRect(0, 0, width, height);
  for (const stroke of strokes) {
    context.save();
    context.globalCompositeOperation = stroke.mode === "erase" ? "destination-out" : "source-over";
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = Math.max(1, stroke.size * width);
    context.lineCap = "round";
    context.lineJoin = "round";
    const first = stroke.points[0];
    if (!first) {
      context.restore();
      continue;
    }
    if (stroke.points.length === 1) {
      context.beginPath();
      context.arc(first.x * width, first.y * height, context.lineWidth / 2, 0, Math.PI * 2);
      context.fill();
      context.restore();
      continue;
    }
    context.beginPath();
    context.moveTo(first.x * width, first.y * height);
    if (stroke.points.length === 2) {
      const last = stroke.points[1];
      context.lineTo(last.x * width, last.y * height);
    } else {
      for (let index = 1; index < stroke.points.length - 1; index += 1) {
        const point = stroke.points[index];
        const next = stroke.points[index + 1];
        context.quadraticCurveTo(
          point.x * width,
          point.y * height,
          ((point.x + next.x) / 2) * width,
          ((point.y + next.y) / 2) * height,
        );
      }
      const last = stroke.points.at(-1);
      if (last) context.lineTo(last.x * width, last.y * height);
    }
    context.stroke();
    context.restore();
  }
}

export function BrushEditor({
  src,
  hasExistingMask,
  onClose,
  onApply,
  onRemoveMask,
}: {
  src: string;
  hasExistingMask: boolean;
  onClose: () => void;
  onApply: (result: { mask: string; guide: string }) => void;
  onRemoveMask: () => void;
}) {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [imageSize, setImageSize] = useState<Size>({ width: 0, height: 0 });
  const [mode, setMode] = useState<BrushMode>("paint");
  const [brushSize, setBrushSize] = useState(52);
  const [lineSize, setLineSize] = useState(7);
  const [strokes, setStrokes] = useState<BrushStroke[]>([]);
  const [redoStack, setRedoStack] = useState<BrushStroke[]>([]);
  const drawingRef = useRef(false);
  const [cursor, setCursor] = useState<BrushPoint | null>(null);
  const [busy, setBusy] = useState(false);
  const workspace = useWorkspaceSize(workspaceRef);
  const display = useMemo(() => fitImage(workspace, imageSize), [workspace, imageSize]);
  const activeSize = mode === "line" ? lineSize : brushSize;
  const sizeMin = mode === "line" ? 2 : 12;
  const sizeMax = mode === "line" ? 24 : 160;
  const sizeProgress = ((activeSize - sizeMin) / (sizeMax - sizeMin)) * 100;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !imageSize.width || !imageSize.height) return;
    canvas.width = imageSize.width;
    canvas.height = imageSize.height;
    const context = canvas.getContext("2d");
    if (!context) return;
    renderBrushStrokes(context, strokes, imageSize.width, imageSize.height, "rgba(255, 104, 76, 0.58)");
  }, [imageSize, strokes]);

  const pointFromEvent = (event: ReactPointerEvent<HTMLCanvasElement>): BrushPoint => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: clamp((event.clientX - bounds.left) / bounds.width, 0, 1),
      y: clamp((event.clientY - bounds.top) / bounds.height, 0, 1),
    };
  };

  const beginStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointFromEvent(event);
    drawingRef.current = true;
    setCursor(point);
    setRedoStack([]);
    setStrokes((current) => [...current, { mode, size: activeSize / Math.max(1, display.width), points: [point] }]);
  };

  const continueStroke = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = pointFromEvent(event);
    setCursor(point);
    if (!drawingRef.current) return;
    setStrokes((current) => current.map((stroke, index) => index === current.length - 1 ? { ...stroke, points: [...stroke.points, point] } : stroke));
  };

  const finishStroke = () => {
    drawingRef.current = false;
  };

  const undo = () => setStrokes((current) => {
    const last = current.at(-1);
    if (!last) return current;
    setRedoStack((redo) => [last, ...redo]);
    return current.slice(0, -1);
  });
  const redo = () => setRedoStack((current) => {
    const first = current[0];
    if (!first) return current;
    setStrokes((items) => [...items, first]);
    return current.slice(1);
  });

  const save = async () => {
    if (!strokes.length) return;
    setBusy(true);
    try {
      const base = await loadCanvasImage(src);
      const maskCanvas = document.createElement("canvas");
      maskCanvas.width = base.naturalWidth;
      maskCanvas.height = base.naturalHeight;
      const maskContext = maskCanvas.getContext("2d");
      if (!maskContext) throw new Error("无法创建蒙版画布");
      renderBrushStrokes(maskContext, strokes, maskCanvas.width, maskCanvas.height, "#ffffff");

      const tintCanvas = document.createElement("canvas");
      tintCanvas.width = base.naturalWidth;
      tintCanvas.height = base.naturalHeight;
      const tintContext = tintCanvas.getContext("2d");
      if (!tintContext) throw new Error("无法创建引导画布");
      tintContext.drawImage(maskCanvas, 0, 0);
      tintContext.globalCompositeOperation = "source-in";
      tintContext.fillStyle = "rgba(255, 104, 76, 0.7)";
      tintContext.fillRect(0, 0, tintCanvas.width, tintCanvas.height);

      const guideCanvas = document.createElement("canvas");
      guideCanvas.width = base.naturalWidth;
      guideCanvas.height = base.naturalHeight;
      const guideContext = guideCanvas.getContext("2d");
      if (!guideContext) throw new Error("无法创建引导图");
      guideContext.drawImage(base, 0, 0);
      guideContext.drawImage(tintCanvas, 0, 0);
      onApply({ mask: maskCanvas.toDataURL("image/png"), guide: guideCanvas.toDataURL("image/jpeg", 0.92) });
    } finally {
      setBusy(false);
    }
  };

  return <EditorFrame title="局部编辑画笔" description="涂抹修改范围，或用自由线条圈出、指向希望 AI 理解的内容。" onClose={onClose} onSave={() => void save()} busy={busy} saveDisabled={!strokes.length} saveLabel="保存标记" sidebar={<>
    <div className="grid grid-cols-3 gap-1 rounded-[14px] border border-line bg-white/[0.025] p-1.5">
      <button type="button" onClick={() => setMode("paint")} className={cn("flex h-9 items-center justify-center gap-1.5 rounded-[9px] text-[11px] transition-colors", mode === "paint" ? "bg-white/[0.1] text-fg shadow-[inset_0_1px_0_rgba(255,255,255,.08)]" : "text-fg-mute hover:text-fg")}><Icon name="PaintBrush" size={12} />画笔</button>
      <button type="button" onClick={() => setMode("line")} className={cn("flex h-9 items-center justify-center gap-1.5 rounded-[9px] text-[11px] transition-colors", mode === "line" ? "bg-[#ff684c]/12 text-[#ff9a85] shadow-[inset_0_1px_0_rgba(255,255,255,.08)]" : "text-fg-mute hover:text-fg")}><Icon name="PencilLine" size={12} />画线</button>
      <button type="button" onClick={() => setMode("erase")} className={cn("flex h-9 items-center justify-center gap-1.5 rounded-[9px] text-[11px] transition-colors", mode === "erase" ? "bg-white/[0.1] text-fg shadow-[inset_0_1px_0_rgba(255,255,255,.08)]" : "text-fg-mute hover:text-fg")}><Icon name="Eraser" size={12} />橡皮擦</button>
    </div>
    <div className="mt-3 rounded-[14px] border border-line bg-white/[0.025] p-3.5">
      <label className="mb-3 flex items-center justify-between text-[11px] font-medium text-fg-dim"><span>{mode === "line" ? "线条宽度" : mode === "erase" ? "橡皮大小" : "笔刷大小"}</span><span className="rounded-full bg-white/[0.05] px-2 py-0.5 font-mono text-[10px] tabular-nums text-fg-mute">{activeSize}px</span></label>
      <input aria-label={mode === "line" ? "线条宽度" : mode === "erase" ? "橡皮大小" : "画笔大小"} type="range" min={sizeMin} max={sizeMax} value={activeSize} onChange={(event) => mode === "line" ? setLineSize(Number(event.target.value)) : setBrushSize(Number(event.target.value))} className="tf-editor-range" style={{ background: `linear-gradient(90deg, rgba(255,255,255,.82) ${sizeProgress}%, rgba(255,255,255,.1) ${sizeProgress}%)` }} />
    </div>
    <div className="mt-3 grid grid-cols-2 gap-1.5">
      <button type="button" disabled={!strokes.length} onClick={undo} className="flex h-9 items-center justify-center gap-1 rounded-control border border-line text-[10px] text-fg-mute transition-colors hover:border-line-2 hover:text-fg disabled:opacity-30"><Icon name="CaretLeft" size={11} />撤销</button>
      <button type="button" disabled={!redoStack.length} onClick={redo} className="flex h-9 items-center justify-center gap-1 rounded-control border border-line text-[10px] text-fg-mute transition-colors hover:border-line-2 hover:text-fg disabled:opacity-30">重做<Icon name="CaretRight" size={11} /></button>
    </div>
    <button type="button" disabled={!strokes.length} onClick={() => { setStrokes([]); setRedoStack([]); }} className="mt-1.5 flex h-9 w-full items-center justify-center gap-1.5 rounded-control border border-line text-[10px] text-fg-mute transition-colors hover:border-danger/30 hover:text-danger disabled:opacity-30"><Icon name="Trash" size={11} />清除本次标记</button>
    {hasExistingMask ? <button type="button" onClick={onRemoveMask} className="mt-3 flex h-9 w-full items-center justify-center gap-1.5 rounded-control border border-danger/20 bg-danger/[0.04] text-[10px] text-danger/80 transition-colors hover:border-danger/40 hover:bg-danger/[0.08]"><Icon name="X" size={11} />移除已有蒙版</button> : null}
    <div className="mt-4 rounded-control border border-line bg-white/[0.02] p-3 text-[10px] leading-relaxed text-fg-mute"><span className="text-fg-dim">{strokes.length ? `已记录 ${strokes.length} 笔` : "尚未标记"}</span><br />涂抹表示修改范围；线条可圈选或指向内容。标记不会写入原图。</div>
  </>}>
    <div ref={workspaceRef} className="absolute inset-0 flex items-center justify-center p-6">
      <div className="relative overflow-visible shadow-[0_18px_70px_rgba(0,0,0,0.5)]" style={{ width: display.width, height: display.height }}>
        <img src={src} alt="局部编辑底图" className="absolute inset-0 h-full w-full select-none object-fill" draggable={false} onLoad={(event) => setImageSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />
        <canvas ref={canvasRef} aria-label="局部编辑蒙版画布" className="absolute inset-0 h-full w-full touch-none" onPointerDown={beginStroke} onPointerMove={continueStroke} onPointerUp={finishStroke} onPointerCancel={finishStroke} onPointerEnter={(event) => setCursor(pointFromEvent(event))} onPointerLeave={() => { if (!drawingRef.current) setCursor(null); }} />
        {cursor ? <div className={cn("pointer-events-none absolute rounded-full border shadow-[0_0_0_1px_rgba(0,0,0,.3)]", mode === "paint" ? "border-white/90 bg-[#ff684c]/20" : mode === "line" ? "border-[#ff9a85] bg-[#ff684c]/55" : "border-dashed border-white/90 bg-black/10")} style={{ left: `${cursor.x * 100}%`, top: `${cursor.y * 100}%`, width: activeSize, height: activeSize, transform: "translate(-50%, -50%)" }} /> : null}
      </div>
    </div>
  </EditorFrame>;
}

export function StickerEditor({ baseSrc, stickerSrc, onClose, onApply }: { baseSrc: string; stickerSrc: string; onClose: () => void; onApply: (src: string) => void }) {
  const workspaceRef = useRef<HTMLDivElement>(null);
  const [baseSize, setBaseSize] = useState<Size>({ width: 0, height: 0 });
  const [stickerSize, setStickerSize] = useState<Size>({ width: 1, height: 1 });
  const [position, setPosition] = useState({ x: 0.5, y: 0.5 });
  const [scale, setScale] = useState(0.32);
  const [rotation, setRotation] = useState(0);
  const [busy, setBusy] = useState(false);
  const workspace = useWorkspaceSize(workspaceRef);
  const display = useMemo(() => fitImage(workspace, baseSize), [workspace, baseSize]);
  const stickerAspect = stickerSize.width / stickerSize.height || 1;

  const beginDrag = (event: ReactPointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const start = position;
    const onMove = (pointer: PointerEvent) => setPosition({ x: clamp(start.x + (pointer.clientX - startX) / display.width, 0, 1), y: clamp(start.y + (pointer.clientY - startY) / display.height, 0, 1) });
    const onUp = () => window.removeEventListener("pointermove", onMove);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  };

  const beginScale = (event: ReactPointerEvent) => {
    event.preventDefault(); event.stopPropagation();
    const wrapper = event.currentTarget.closest("[data-sticker-stage]") as HTMLElement | null;
    if (!wrapper) return;
    const bounds = wrapper.getBoundingClientRect();
    const centerX = bounds.left + position.x * bounds.width;
    const centerY = bounds.top + position.y * bounds.height;
    const startDistance = Math.hypot(event.clientX - centerX, event.clientY - centerY) || 1;
    const startScale = scale;
    const onMove = (pointer: PointerEvent) => setScale(clamp(startScale * Math.hypot(pointer.clientX - centerX, pointer.clientY - centerY) / startDistance, 0.05, 2));
    const onUp = () => window.removeEventListener("pointermove", onMove);
    window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp, { once: true });
  };

  const beginRotate = (event: ReactPointerEvent) => {
    event.preventDefault(); event.stopPropagation();
    const wrapper = event.currentTarget.closest("[data-sticker-stage]") as HTMLElement | null;
    if (!wrapper) return;
    const bounds = wrapper.getBoundingClientRect();
    const centerX = bounds.left + position.x * bounds.width;
    const centerY = bounds.top + position.y * bounds.height;
    const startAngle = Math.atan2(event.clientY - centerY, event.clientX - centerX) * 180 / Math.PI;
    const startRotation = rotation;
    const onMove = (pointer: PointerEvent) => setRotation(normalizeAngle(Math.round(startRotation + Math.atan2(pointer.clientY - centerY, pointer.clientX - centerX) * 180 / Math.PI - startAngle)));
    const onUp = () => window.removeEventListener("pointermove", onMove);
    window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp, { once: true });
  };

  const save = async () => {
    setBusy(true);
    try {
      const [base, sticker] = await Promise.all([loadCanvasImage(baseSrc), loadCanvasImage(stickerSrc)]);
      const canvas = document.createElement("canvas");
      canvas.width = base.naturalWidth; canvas.height = base.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法创建贴图画布");
      context.drawImage(base, 0, 0);
      const stickerWidth = base.naturalWidth * scale;
      const stickerHeight = stickerWidth / (sticker.naturalWidth / sticker.naturalHeight || 1);
      context.save();
      context.translate(position.x * base.naturalWidth, position.y * base.naturalHeight);
      context.rotate(rotation * Math.PI / 180);
      context.drawImage(sticker, -stickerWidth / 2, -stickerHeight / 2, stickerWidth, stickerHeight);
      context.restore();
      onApply(canvas.toDataURL("image/png"));
    } finally { setBusy(false); }
  };

  const stickerDisplayWidth = display.width * scale;
  const stickerDisplayHeight = stickerDisplayWidth / stickerAspect;
  return <EditorFrame title="添加贴图" description="拖动贴图改变位置，使用控制点缩放或旋转；保存后合并为一张图片。" onClose={onClose} onSave={() => void save()} busy={busy} sidebar={<>
    <div className="rounded-[14px] border border-line bg-white/[0.025] p-3.5">
      <label className="mb-3 flex items-center justify-between text-[11px] font-medium text-fg-dim"><span className="flex items-center gap-1.5"><Icon name="ArrowsOutSimple" size={12} />缩放</span><span className="rounded-full bg-white/[0.05] px-2 py-0.5 font-mono text-[10px] tabular-nums text-fg-mute">{Math.round(scale * 100)}%</span></label>
      <input aria-label="贴图缩放" type="range" min="5" max="200" value={Math.round(scale * 100)} onChange={(event) => setScale(Number(event.target.value) / 100)} className="tf-editor-range" style={{ background: `linear-gradient(90deg, rgba(255,255,255,.82) ${((scale * 100 - 5) / 195) * 100}%, rgba(255,255,255,.1) ${((scale * 100 - 5) / 195) * 100}%)` }} />
    </div>
    <div className="mt-2 rounded-[14px] border border-line bg-white/[0.025] p-3.5">
      <label className="mb-3 flex items-center justify-between text-[11px] font-medium text-fg-dim"><span className="flex items-center gap-1.5"><Icon name="ArrowsClockwise" size={12} />旋转</span><span className="rounded-full bg-white/[0.05] px-2 py-0.5 font-mono text-[10px] tabular-nums text-fg-mute">{rotation}°</span></label>
      <input aria-label="贴图旋转" type="range" min="-180" max="180" value={rotation} onChange={(event) => setRotation(Number(event.target.value))} className="tf-editor-range" style={{ background: `linear-gradient(90deg, rgba(255,255,255,.82) ${((rotation + 180) / 360) * 100}%, rgba(255,255,255,.1) ${((rotation + 180) / 360) * 100}%)` }} />
    </div>
    <button type="button" onClick={() => { setPosition({ x: 0.5, y: 0.5 }); setScale(0.32); setRotation(0); }} className="mt-3 flex h-9 w-full items-center justify-center gap-1.5 rounded-control border border-line text-[11px] text-fg-mute transition-colors hover:border-line-2 hover:bg-white/[0.03] hover:text-fg"><Icon name="ArrowsClockwise" size={11} />重置变换</button>
  </>}>
    <div ref={workspaceRef} className="absolute inset-0 flex items-center justify-center p-6">
      <div data-sticker-stage className="relative shadow-[0_18px_70px_rgba(0,0,0,0.5)]" style={{ width: display.width, height: display.height }}>
        <img src={baseSrc} alt="贴图底图" className="absolute inset-0 h-full w-full select-none object-fill" draggable={false} onLoad={(event) => setBaseSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />
        <div className="tf-sticker-frame absolute cursor-move touch-none select-none border border-white/65 shadow-[0_0_0_1px_rgba(0,0,0,0.45),0_12px_34px_rgba(0,0,0,0.16)]" style={{ left: `${position.x * 100}%`, top: `${position.y * 100}%`, width: stickerDisplayWidth, height: stickerDisplayHeight, transform: `translate(-50%, -50%) rotate(${rotation}deg)` }} onPointerDown={beginDrag}>
          <img src={stickerSrc} alt="当前贴图" className="pointer-events-none h-full w-full object-contain" draggable={false} onLoad={(event) => setStickerSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />
          <span className="pointer-events-none absolute -left-px -top-px h-4 w-4 border-l-2 border-t-2 border-white" /><span className="pointer-events-none absolute -right-px -top-px h-4 w-4 border-r-2 border-t-2 border-white" /><span className="pointer-events-none absolute -bottom-px -left-px h-4 w-4 border-b-2 border-l-2 border-white" /><span className="pointer-events-none absolute -bottom-px -right-px h-4 w-4 border-b-2 border-r-2 border-white" />
          <button type="button" aria-label="旋转贴图" onPointerDown={beginRotate} className="tf-transform-handle absolute -top-12 left-1/2 flex h-8 w-8 cursor-grab items-center justify-center rounded-full text-fg active:cursor-grabbing" style={{ transform: `translateX(-50%) rotate(${-rotation}deg)` }}><Icon name="ArrowsClockwise" size={13} weight="bold" /></button>
          <div className="pointer-events-none absolute -top-4 left-1/2 h-4 border-l border-dashed border-white/55" />
          <button type="button" aria-label="缩放贴图" onPointerDown={beginScale} className="tf-transform-handle absolute -bottom-4 -right-4 flex h-8 w-8 cursor-nwse-resize items-center justify-center rounded-full text-fg" style={{ transform: `rotate(${-rotation}deg)` }}><Icon name="ArrowsOutSimple" size={13} weight="bold" /></button>
          <div className="pointer-events-none absolute -bottom-11 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-white/12 bg-black/75 px-2 py-1 font-mono text-[9px] tabular-nums text-white/75 shadow-[0_6px_20px_rgba(0,0,0,0.32)] backdrop-blur-md" style={{ transform: `translateX(-50%) rotate(${-rotation}deg)` }}><span>{Math.round(scale * 100)}%</span><span className="text-white/25">·</span><span>{rotation}°</span></div>
        </div>
      </div>
    </div>
  </EditorFrame>;
}
