"use client";

// 空画布中央的快捷工作流卡片（对齐 libTV 的模板入口，但以电商图片工作流为主）。
// 点击一键在画布上铺好一条连好线的节点链。

import { useStudio } from "@/lib/store";
import { useReactFlow } from "@xyflow/react";
import { Icon } from "./icons";

interface Template {
  id: string;
  icon: string;
  label: string;
  hint: string;
  build: (
    addNode: ReturnType<typeof useStudio.getState>["addNode"],
    onConnect: ReturnType<typeof useStudio.getState>["onConnect"],
    origin: { x: number; y: number },
  ) => void;
}

const GAP_X = 560;

const TEMPLATES: Template[] = [
  {
    id: "product-shot",
    icon: "Image",
    label: "商品图精修",
    hint: "上传商品图 → 指令化修图",
    build: (addNode, onConnect, o) => {
      const a = addNode("image", { x: o.x, y: o.y }, { label: "商品原图" });
      const b = addNode("image", { x: o.x + GAP_X, y: o.y }, {
        label: "精修结果",
        prompt: "将背景替换为纯白色 (#FFFFFF) 无缝影棚背景，保持商品本身完全一致，柔和均匀布光，商品下方保留自然的浅接触阴影，输出专业电商主图。",
      });
      onConnect({ source: a, target: b, sourceHandle: null, targetHandle: null });
    },
  },
  {
    id: "model-swap",
    icon: "TShirt",
    label: "模特换装",
    hint: "模特图 + 服装图 → 上身效果",
    build: (addNode, onConnect, o) => {
      const model = addNode("image", { x: o.x, y: o.y - 170 }, { label: "模特图" });
      const garment = addNode("image", { x: o.x, y: o.y + 170 }, { label: "服装图" });
      const result = addNode("image", { x: o.x + GAP_X, y: o.y }, {
        label: "换装结果",
        prompt: "以第一张图中的人物为基础，将其上装替换为第二张图中的服装。忠实还原第二件服装的设计、颜色、面料质感、图案与版型，自然贴合人物姿势。其余一切保持不变：同样的脸、发型、表情、体型、姿势、下装、鞋、背景、光影与构图。写实电商时尚摄影。",
      });
      onConnect({ source: model, target: result, sourceHandle: null, targetHandle: null });
      onConnect({ source: garment, target: result, sourceHandle: null, targetHandle: null });
    },
  },
  {
    id: "reverse-remake",
    icon: "Eye",
    label: "反推重绘",
    hint: "参考图 → 反推提示词 → 重生成",
    build: (addNode, onConnect, o) => {
      const src = addNode("image", { x: o.x, y: o.y }, { label: "参考图" });
      const text = addNode("text", { x: o.x + 490, y: o.y }, { label: "反推提示词" });
      const out = addNode("image", { x: o.x + 490 + 440, y: o.y }, { label: "重绘结果" });
      onConnect({ source: src, target: text, sourceHandle: null, targetHandle: null });
      onConnect({ source: text, target: out, sourceHandle: null, targetHandle: null });
    },
  },
  {
    id: "img2video",
    icon: "FilmSlate",
    label: "首帧图生视频",
    hint: "图片节点 → 视频节点",
    build: (addNode, onConnect, o) => {
      const img = addNode("image", { x: o.x, y: o.y }, { label: "首帧图" });
      const vid = addNode("video", { x: o.x + GAP_X, y: o.y }, { label: "成片" });
      onConnect({ source: img, target: vid, sourceHandle: null, targetHandle: null });
    },
  },
];

export function TemplateBar() {
  const nodes = useStudio((s) => s.nodes);
  const loaded = useStudio((s) => s.loaded);
  const addNode = useStudio((s) => s.addNode);
  const onConnect = useStudio((s) => s.onConnect);
  const rf = useReactFlow();

  if (!loaded || nodes.length > 0) return null;

  const run = (t: Template) => {
    const center = rf.screenToFlowPosition({ x: window.innerWidth / 2 - 500, y: window.innerHeight / 2 - 120 });
    t.build(addNode, onConnect, center);
  };

  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-8">
      <div className="flex items-center gap-2 text-[13px] text-fg-mute">
        <Icon name="Hand" size={15} />
        <span className="text-fg-dim">双击画布</span> 自由生成节点
      </div>
      <div className="pointer-events-auto flex flex-wrap justify-center gap-3 px-8">
        {TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => run(t)}
            className="group flex w-[210px] items-center gap-3 rounded-panel border border-line bg-panel/80 px-4 py-3.5 text-left backdrop-blur transition-all hover:border-accent/50 hover:bg-panel-2"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-white/[0.04] text-fg-dim transition-colors group-hover:bg-accent/15 group-hover:text-accent">
              <Icon name={t.icon} size={17} />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[13px] font-medium text-fg">{t.label}</span>
              <span className="truncate text-[11px] text-fg-mute">{t.hint}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
