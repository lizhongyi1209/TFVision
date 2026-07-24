"use client";

// TFvision studio store — React Flow graph state + generation orchestration +
// workspace persistence. API layer mirrors TVision's o1key contract.

import { create } from "zustand";
import {
  applyEdgeChanges,
  applyNodeChanges,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type Connection,
  type XYPosition,
} from "@xyflow/react";
import {
  MAX_BATCH_PROMPTS,
  MAX_COMBINATION_GROUPS,
  MAX_IMAGE_REFERENCES,
  type CombinationGroup,
  type CombinationOption,
  type ImageNodeData,
  type JobStatusResponse,
  type NodeKind,
  type PublicSettings,
  type TextNodeData,
  type VideoNodeData,
  type WorkspaceFile,
} from "./types";
import { styleSuffix } from "./models";
import { downscaleImageSrc, fakeProgressCurve } from "./utils";

export type AppNode = Node<TextNodeData | ImageNodeData | VideoNodeData>;

export interface BoardMeta {
  id: string;
  name: string;
}

interface BoardSnapshot {
  nodes: AppNode[];
  edges: Edge[];
  counters: Record<string, number>;
}

interface Toast {
  id: number;
  msg: string;
  kind: "info" | "success" | "error";
}

/** Add-node menu invocation context. */
export interface MenuState {
  /** Canvas-space position new nodes should land at. */
  flowPosition: XYPosition;
  /** Screen-space anchor for rendering the menu. */
  screen: { x: number; y: number };
  /** When set, the new node auto-connects from this source node. */
  sourceNodeId?: string;
  /** When set, the new node auto-connects into this target node. */
  targetNodeId?: string;
}

const uid = () => `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const KIND_LABEL: Record<NodeKind, string> = { text: "文本节点", image: "图片节点", video: "视频节点" };

export function defaultTextData(label: string): TextNodeData {
  return { label, text: "", reversing: false };
}

export function defaultImageData(label: string): ImageNodeData {
  return {
    label,
    url: null,
    urls: [],
    activeIndex: 0,
    status: "idle",
    progress: 0,
    jobIds: [],
    prompt: "",
    batchPromptEnabled: false,
    batchPrompts: [],
    combinationEnabled: false,
    combinationGroups: [],
    styleId: "none",
    model: "Nano Banana Pro",
    resolution: "2K",
    aspectRatio: "auto",
    billing: "特价",
    quality: "auto",
    count: 1,
  };
}

export function defaultVideoData(label: string): VideoNodeData {
  return {
    label,
    url: null,
    status: "idle",
    progress: 0,
    prompt: "",
    model: "v3",
    mode: "720p",
    duration: 5,
    aspectRatio: "智能",
    sound: false,
    cameraFixed: false,
  };
}

// Poll timers live outside the store so they never serialize.
const pollTimers = new Map<string, ReturnType<typeof setTimeout>>();
const submitControllers = new Map<string, AbortController>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function clearPoll(nodeId: string) {
  const t = pollTimers.get(nodeId);
  if (t) clearTimeout(t);
  pollTimers.delete(nodeId);
}

function clearImageRuntime(nodeId: string) {
  clearPoll(nodeId);
  submitControllers.get(nodeId)?.abort();
  submitControllers.delete(nodeId);
}

async function srcToRefDataUrl(src: string): Promise<string> {
  // data URLs are re-compressed too (bounds request size); /api/media URLs are same-origin.
  const { dataUrl } = await downscaleImageSrc(src, 1600, 0.92);
  return dataUrl;
}

const isCombinationOptionValid = (option: CombinationOption) => Boolean(option.image);

function expandCombinationGroups(groups: CombinationGroup[], limit: number): CombinationOption[][] | null {
  let combinations: CombinationOption[][] = [[]];
  for (const group of groups) {
    const options = group.options.filter(isCombinationOptionValid);
    combinations = combinations.flatMap((combination) => options.map((option) => [...combination, option]));
    if (combinations.length > limit) return null;
  }
  return combinations;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

interface ImageGenerationRequest {
  prompt: string;
  sources: string[];
  label?: string;
}

interface StudioState {
  // graph
  nodes: AppNode[];
  edges: Edge[];
  counters: Record<string, number>;

  // workspace
  workspaceName: string;
  boards: BoardMeta[];
  activeBoardId: string;
  boardsData: Record<string, BoardSnapshot>;
  loaded: boolean;

  // ui
  settings: PublicSettings | null;
  settingsOpen: boolean;
  historyOpen: boolean;
  shortcutsOpen: boolean;
  menu: MenuState | null;
  toast: Toast | null;
  /** 画布工具：move = 移动/框选（V）；hand = 抓手平移（H）。会话级，不持久化。 */
  tool: "move" | "hand";

  // graph actions
  onNodesChange: (changes: NodeChange<AppNode>[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (conn: Connection) => void;
  addNode: (kind: NodeKind, position: XYPosition, init?: Record<string, unknown>) => string;
  removeNode: (id: string) => void;
  removeEdge: (id: string) => void;
  updateNode: (id: string, patch: Record<string, unknown>) => void;
  duplicateNode: (id: string) => void;
  renameWorkspace: (name: string) => void;

  // menu / panels
  openMenu: (menu: MenuState) => void;
  closeMenu: () => void;
  setSettingsOpen: (open: boolean) => void;
  setHistoryOpen: (open: boolean) => void;
  setShortcutsOpen: (open: boolean) => void;
  setTool: (tool: "move" | "hand") => void;

  // toast
  showToast: (msg: string, kind?: Toast["kind"]) => void;
  clearToast: () => void;

  // settings
  fetchSettings: () => Promise<void>;
  saveSettings: (patch: { apiKey?: string; clearApiKey?: boolean }) => Promise<boolean>;

  // generation
  generateImage: (nodeId: string) => Promise<string | undefined>;
  cancelImageGeneration: (nodeId: string) => void;
  generateVideo: (nodeId: string) => Promise<void>;
  reversePrompt: (textNodeId: string) => Promise<void>;

  // boards / persistence
  loadWorkspace: () => Promise<void>;
  scheduleSave: () => void;
  saveWorkspaceNow: () => Promise<void>;
  addBoard: () => void;
  switchBoard: (id: string) => void;
  renameBoard: (id: string, name: string) => void;
  deleteBoard: (id: string) => void;
}

export const useStudio = create<StudioState>((set, get) => ({
  nodes: [],
  edges: [],
  counters: {},

  workspaceName: "未命名工作区",
  boards: [{ id: "b1", name: "画布 1" }],
  activeBoardId: "b1",
  boardsData: {},
  loaded: false,

  settings: null,
  settingsOpen: false,
  historyOpen: false,
  shortcutsOpen: false,
  menu: null,
  toast: null,
  tool: "move",

  onNodesChange: (changes) => {
    set({ nodes: applyNodeChanges(changes, get().nodes) as AppNode[] });
    // Node removal via keyboard lands here too — stop any orphaned polls.
    for (const c of changes) {
      if (c.type === "remove") clearImageRuntime(c.id);
    }
    get().scheduleSave();
  },

  onEdgesChange: (changes) => {
    set({ edges: applyEdgeChanges(changes, get().edges) });
    get().scheduleSave();
  },

  onConnect: (conn) => {
    if (!conn.source || !conn.target || conn.source === conn.target) return;
    const { nodes, edges } = get();
    const source = nodes.find((n) => n.id === conn.source);
    const target = nodes.find((n) => n.id === conn.target);
    if (!source || !target) return;
    // Valid flows: image→image (参考), text→image (提示词), image→text (反推),
    // image→video (首帧), text→video (提示词).
    const ok =
      (source.type === "image" && (target.type === "image" || target.type === "text" || target.type === "video")) ||
      (source.type === "text" && (target.type === "image" || target.type === "video"));
    if (!ok) {
      get().showToast("这两种节点之间不支持连线", "error");
      return;
    }
    if (edges.some((e) => e.source === conn.source && e.target === conn.target)) return;
    const edge: Edge = {
      id: `e-${conn.source}-${conn.target}-${Date.now().toString(36)}`,
      source: conn.source,
      target: conn.target,
    };
    set({ edges: [...edges, edge] });
    get().scheduleSave();
  },

  addNode: (kind, position, init) => {
    const { nodes, counters } = get();
    const n = (counters[kind] ?? 0) + 1;
    const label = `${KIND_LABEL[kind]} ${n}`;
    const extra = (init ?? {}) as Record<string, unknown>;
    const data = (
      kind === "text"
        ? { ...defaultTextData(label), ...extra }
        : kind === "image"
          ? { ...defaultImageData(label), ...extra }
          : { ...defaultVideoData(label), ...extra }
    ) as TextNodeData | ImageNodeData | VideoNodeData;
    const id = uid();
    const node: AppNode = { id, type: kind, position, data } as AppNode;
    set({ nodes: [...nodes, node], counters: { ...counters, [kind]: n } });
    get().scheduleSave();
    return id;
  },

  removeNode: (id) => {
    clearImageRuntime(id);
    set({
      nodes: get().nodes.filter((n) => n.id !== id),
      edges: get().edges.filter((e) => e.source !== id && e.target !== id),
    });
    get().scheduleSave();
  },

  removeEdge: (id) => {
    set({ edges: get().edges.filter((e) => e.id !== id) });
    get().scheduleSave();
  },

  updateNode: (id, patch) => {
    set({
      nodes: get().nodes.map((n) => (n.id === id ? ({ ...n, data: { ...n.data, ...patch } } as AppNode) : n)),
    });
    get().scheduleSave();
  },

  duplicateNode: (id) => {
    const src = get().nodes.find((n) => n.id === id);
    if (!src) return;
    const kind = (src.type ?? "image") as NodeKind;
    const pos = { x: src.position.x + 60, y: src.position.y + 60 };
    const data = JSON.parse(JSON.stringify(src.data)) as Record<string, unknown>;
    // Duplicates never inherit an in-flight job.
    data.status = "idle";
    data.progress = 0;
    data.jobIds = [];
    data.taskId = undefined;
    if (kind === "image" && data.isGeneratedResult) {
      delete data.label;
      data.isGeneratedResult = undefined;
      data.generationSourceId = undefined;
      data.cancelledAt = undefined;
    }
    get().addNode(kind, pos, data);
  },

  renameWorkspace: (name) => {
    set({ workspaceName: name.trim() || "未命名工作区" });
    void get().saveWorkspaceNow();
  },

  openMenu: (menu) => set({ menu }),
  closeMenu: () => set({ menu: null }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setHistoryOpen: (open) => set({ historyOpen: open }),
  setShortcutsOpen: (open) => set({ shortcutsOpen: open }),
  setTool: (tool) => set({ tool }),

  showToast: (msg, kind = "info") => set({ toast: { id: Date.now(), msg, kind } }),
  clearToast: () => set({ toast: null }),

  fetchSettings: async () => {
    try {
      const res = await fetch("/api/settings");
      const s = (await res.json()) as PublicSettings;
      set({ settings: s });
      if (!s.hasApiKey) set({ settingsOpen: true });
    } catch {
      // leave null; settings panel will show a retry
    }
  },

  saveSettings: async (patch) => {
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error();
      const s = (await res.json()) as PublicSettings;
      set({ settings: s });
      return true;
    } catch {
      get().showToast("保存设置失败", "error");
      return false;
    }
  },

  // ── Image generation ───────────────────────────────────────────────────────

  cancelImageGeneration: (nodeId) => {
    const node = get().nodes.find((candidate) => candidate.id === nodeId);
    const data = node?.data as ImageNodeData | undefined;
    if (!node || node.type !== "image" || !data?.isGeneratedResult || data.status !== "running") return;

    clearImageRuntime(nodeId);
    get().updateNode(nodeId, {
      status: "cancelled",
      progress: 0,
      cancelledAt: Date.now(),
      error: undefined,
    });
    settleGenerationEdge(nodeId, "cancelled", set, get);
    get().showToast("已取消本次生成", "info");
  },

  generateImage: async (nodeId) => {
    const state = get();
    const node = state.nodes.find((n) => n.id === nodeId);
    if (!node || node.type !== "image") return;
    const data = node.data as ImageNodeData;
    if (data.isGeneratedResult) return;

    // Assemble prompt: upstream text nodes first, then the node's own prompt.
    const upstream = state.edges.filter((e) => e.target === nodeId);
    const textParts: string[] = [];
    const refSrcs: string[] = [];
    for (const e of upstream) {
      const src = state.nodes.find((n) => n.id === e.source);
      if (!src) continue;
      if (src.type === "text") {
        const t = (src.data as TextNodeData).text.trim();
        if (t) textParts.push(t);
      } else if (src.type === "image") {
        const imageData = src.data as ImageNodeData;
        const sources = imageData.urls.length ? imageData.urls : imageData.url ? [imageData.url] : [];
        refSrcs.push(...sources);
      }
    }
    const suffix = styleSuffix(data.styleId);
    const hasEditGuide = Boolean(
      data.editGuide &&
      data.editMask &&
      typeof data.editMaskImageIndex === "number" &&
      data.editMaskImageIndex === data.activeIndex,
    );
    const localEditInstruction = hasEditGuide
      ? "局部编辑要求：最后一张参考图中的珊瑚色涂抹表示直接修改范围；珊瑚色线条若圈出或指向内容，则表示需要修改其圈定或指向的内容。只根据提示词修改这些被标记的内容；其他主体、背景、构图、光线和细节必须保持与原图一致。最终结果中不要保留珊瑚色标记。"
      : "";
    const ownSources = data.urls.length ? data.urls : data.url ? [data.url] : [];
    const globalSources = [...ownSources, ...refSrcs];
    let requests: ImageGenerationRequest[];

    if (data.combinationEnabled) {
      const groups = (Array.isArray(data.combinationGroups) ? data.combinationGroups : []).slice(0, MAX_COMBINATION_GROUPS);
      if (groups.length < 2) {
        get().showToast("组合生图至少需要两个分类", "error");
        return;
      }
      const emptyGroup = groups.find((group) => !group.options.some(isCombinationOptionValid));
      if (emptyGroup) {
        get().showToast(`“${emptyGroup.name || "未命名分类"}”还没有有效选项`, "error");
        return;
      }
      const combinations = expandCombinationGroups(groups, MAX_BATCH_PROMPTS);
      if (!combinations) {
        get().showToast(`组合数量超过 ${MAX_BATCH_PROMPTS}，请减少分类选项`, "error");
        return;
      }
      const hasUserPrompt = Boolean(data.prompt.trim() || textParts.length);
      if (!hasUserPrompt) {
        get().showToast("请填写组合生图的通用提示词", "error");
        return;
      }

      requests = combinations.map((combination) => {
        const combinationImages = combination.flatMap((option) => option.image ? [option.image] : []);
        const sources = [...globalSources, ...combinationImages];
        if (hasEditGuide && data.editGuide) sources.push(data.editGuide);
        const mappingLines: string[] = [];
        let imageOffset = globalSources.length;
        combination.forEach((option, index) => {
          if (!option.image) return;
          imageOffset += 1;
          mappingLines.push(`- ${groups[index].name || `分类 ${index + 1}`}：第 ${imageOffset} 张参考图`);
        });
        const mapping = mappingLines.length ? `组合参考对应关系：\n${mappingLines.join("\n")}` : "";
        const label = combination.map((option, index) => {
          const groupName = groups[index].name.trim() || `分类 ${index + 1}`;
          const optionIndex = groups[index].options.filter(isCombinationOptionValid).findIndex((candidate) => candidate.id === option.id) + 1;
          return `${groupName} ${optionIndex}`;
        }).join(" · ");
        return {
          prompt: [...textParts, data.prompt.trim(), mapping, suffix, localEditInstruction].filter(Boolean).join("\n\n"),
          sources,
          label,
        };
      });
      if (requests.some((request) => request.sources.length > MAX_IMAGE_REFERENCES)) {
        get().showToast(`每个组合最多使用 ${MAX_IMAGE_REFERENCES} 张参考图，请减少全局参考图或图片分类`, "error");
        return;
      }
    } else {
      const ownPrompts = data.batchPromptEnabled
        ? (Array.isArray(data.batchPrompts) ? data.batchPrompts : [])
            .slice(0, MAX_BATCH_PROMPTS)
            .map((item) => item.trim())
            .filter(Boolean)
        : [data.prompt.trim()];
      if (data.batchPromptEnabled && !ownPrompts.length) {
        get().showToast("请至少填写一套批量提示词", "error");
        return;
      }
      const sources = globalSources.slice(0, MAX_IMAGE_REFERENCES - (hasEditGuide ? 1 : 0));
      if (hasEditGuide && data.editGuide) sources.push(data.editGuide);
      requests = ownPrompts
        .map((own) => ({
          prompt: [...textParts, own, suffix, localEditInstruction].filter(Boolean).join("\n\n"),
          sources,
        }))
        .filter((request) => Boolean(request.prompt));
      if (!requests.length) {
        get().showToast("请先输入提示词，或连入一个文本节点", "error");
        return;
      }
    }

    const prompt = requests.length === 1
      ? requests[0].prompt
      : requests.map((request, index) => `【第 ${index + 1} 组】\n${request.prompt}`).join("\n\n");
    const sourceWidth = data.width || 470;
    const sourceHeight = data.height ?? sourceWidth;
    const existingResults = state.nodes.filter(
      (candidate) =>
        candidate.type === "image" && (candidate.data as ImageNodeData).generationSourceId === nodeId,
    );
    const resultNumber = Math.max(
      0,
      ...existingResults.map((candidate) => {
        const match = String((candidate.data as ImageNodeData).label).match(/(\d+)$/);
        return match ? Number(match[1]) : 0;
      }),
    ) + 1;
    const nextResultY = existingResults.length
      ? Math.max(...existingResults.map((candidate) => candidate.position.y)) + Math.min(sourceHeight, 560) + 110
      : node.position.y;
    const resultPosition = {
      x: node.position.x + sourceWidth + 180,
      y: nextResultY,
    };
    const startedAt = Date.now();
    const resultNodeId = get().addNode("image", resultPosition, {
      label: `生成结果 ${resultNumber}`,
      url: null,
      urls: [],
      activeIndex: 0,
      status: "running",
      progress: 0,
      error: undefined,
      startedAt,
      jobIds: [],
      jobLabels: [],
      resultLabels: [],
      prompt,
      batchPromptEnabled: !data.combinationEnabled && requests.length > 1,
      batchPrompts: requests.map((request) => request.prompt),
      combinationEnabled: Boolean(data.combinationEnabled),
      combinationGroups: data.combinationEnabled ? data.combinationGroups : [],
      batchSize: requests.length,
      submissionFailures: 0,
      styleId: data.styleId,
      model: data.model,
      resolution: data.resolution,
      aspectRatio: data.aspectRatio,
      billing: data.billing,
      quality: data.quality,
      count: data.count,
      width: sourceWidth,
      height: sourceHeight,
      isGeneratedResult: true,
      generationSourceId: nodeId,
    });
    const generationEdge: Edge = {
      id: `e-generate-${nodeId}-${resultNodeId}`,
      source: nodeId,
      target: resultNodeId,
      animated: true,
      className: "tf-generation-edge",
      data: { generation: true },
    };
    set({ edges: [...get().edges, generationEdge] });
    get().scheduleSave();

    // Submission continues independently so the result node and its connection
    // appear immediately. The source node remains editable and can launch more runs.
    void (async () => {
      try {
        const imageCache = new Map<string, Promise<string>>();
        const preparedRequests = await Promise.all(requests.map(async (request) => ({
          prompt: request.prompt,
          label: request.label,
          images: await Promise.all(request.sources.map((src) => {
            const cached = imageCache.get(src);
            if (cached) return cached;
            const pending = srcToRefDataUrl(src);
            imageCache.set(src, pending);
            return pending;
          })),
        })));

        if (!imageResultIsRunning(resultNodeId, get)) return;
        const controller = new AbortController();
        submitControllers.set(resultNodeId, controller);
        const submissions = await Promise.allSettled(
          preparedRequests.map(async (request) => {
            const res = await fetch("/api/jobs", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                prompt: request.prompt,
                model: data.model,
                resolution: data.resolution,
                aspectRatio: data.aspectRatio,
                billing: data.billing,
                quality: data.quality,
                count: data.count,
                images: request.images,
              }),
              signal: controller.signal,
            });
            const payload = (await res.json()) as { jobs?: { id: string }[]; error?: string };
            if (!res.ok || !payload.jobs?.length) throw new Error(payload.error || "提交失败");
            return { ids: payload.jobs.map((job) => job.id), label: request.label };
          }),
        );
        submitControllers.delete(resultNodeId);
        if (!imageResultIsRunning(resultNodeId, get)) return;
        const jobIds = submissions.flatMap((submission) => submission.status === "fulfilled" ? submission.value.ids : []);
        const jobLabels = submissions.flatMap((submission) => submission.status === "fulfilled"
          ? submission.value.ids.map((_, index) => submission.value.label
            ? `${submission.value.label}${submission.value.ids.length > 1 ? ` · ${index + 1}` : ""}`
            : "")
          : []);
        const submissionFailures = submissions.length - submissions.filter((submission) => submission.status === "fulfilled").length;
        if (!jobIds.length) {
          const firstFailure = submissions.find((submission) => submission.status === "rejected");
          if (firstFailure?.status === "rejected") throw firstFailure.reason;
          throw new Error("提交失败");
        }
        get().updateNode(resultNodeId, { jobIds, jobLabels, submissionFailures });
        if (submissionFailures) {
          get().showToast(`已提交 ${requests.length - submissionFailures} 组，${submissionFailures} 组提交失败`, "error");
        }
        pollImageNode(resultNodeId, jobIds, set, get, submissionFailures, jobLabels);
      } catch (e) {
        submitControllers.delete(resultNodeId);
        if (!imageResultIsRunning(resultNodeId, get)) return;
        const message = e instanceof Error ? e.message : typeof e === "string" ? e : "提交失败";
        get().updateNode(resultNodeId, { status: "failed", error: message, progress: 0 });
        settleGenerationEdge(resultNodeId, "failed", set, get);
        get().showToast(message, "error");
      }
    })();

    return resultNodeId;
  },

  // ── Video generation ───────────────────────────────────────────────────────

  generateVideo: async (nodeId) => {
    const state = get();
    const node = state.nodes.find((n) => n.id === nodeId);
    if (!node || node.type !== "video") return;
    const data = node.data as VideoNodeData;
    if (data.status === "running") return;

    const upstream = state.edges.filter((e) => e.target === nodeId);
    const textParts: string[] = [];
    let firstFrameSrc: string | null = null;
    for (const e of upstream) {
      const src = state.nodes.find((n) => n.id === e.source);
      if (!src) continue;
      if (src.type === "text") {
        const t = (src.data as TextNodeData).text.trim();
        if (t) textParts.push(t);
      } else if (src.type === "image" && !firstFrameSrc) {
        firstFrameSrc = (src.data as ImageNodeData).url;
      }
    }
    const prompt = [...textParts, data.prompt.trim()].filter(Boolean).join("\n\n");
    if (!prompt) {
      get().showToast("请先输入视频提示词", "error");
      return;
    }
    const needsFrame = data.model === "v3" || data.model === "v2-6";
    if (needsFrame && !firstFrameSrc) {
      get().showToast("该模型需要首帧图片：请连入一个已有图片的图片节点", "error");
      return;
    }

    get().updateNode(nodeId, { status: "running", progress: 0, error: undefined, startedAt: Date.now() });

    try {
      // Upload the first frame (if any) to get a public URL the gateway can fetch.
      let imageUrl: string | undefined;
      if (firstFrameSrc) {
        const blob = await (await fetch(firstFrameSrc)).blob();
        const fd = new FormData();
        fd.append("file", blob, "frame.png");
        const upRes = await fetch("/api/video/upload", { method: "POST", body: fd });
        const upPayload = (await upRes.json()) as { url?: string; error?: string };
        if (!upRes.ok || !upPayload.url) throw new Error(upPayload.error || "首帧上传失败");
        imageUrl = upPayload.url;
      }

      const res = await fetch("/api/video/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: data.model,
          mode: data.mode,
          duration: data.duration,
          prompt,
          sound: data.sound,
          cameraFixed: data.cameraFixed,
          aspectRatio: data.aspectRatio,
          imageUrl,
        }),
      });
      const payload = (await res.json()) as { taskId?: string; error?: string };
      if (!res.ok || !payload.taskId) throw new Error(payload.error || "视频任务提交失败");
      get().updateNode(nodeId, { taskId: payload.taskId });
      pollVideoNode(nodeId, payload.taskId, prompt, set, get);
    } catch (e) {
      get().updateNode(nodeId, { status: "failed", error: (e as Error).message, progress: 0 });
      get().showToast((e as Error).message, "error");
    }
  },

  // ── 视觉反推 ────────────────────────────────────────────────────────────────

  reversePrompt: async (textNodeId) => {
    const state = get();
    const node = state.nodes.find((n) => n.id === textNodeId);
    if (!node || node.type !== "text") return;
    const upstream = state.edges.filter((e) => e.target === textNodeId);
    let imageSrc: string | null = null;
    for (const e of upstream) {
      const src = state.nodes.find((n) => n.id === e.source);
      if (src?.type === "image" && (src.data as ImageNodeData).url) {
        imageSrc = (src.data as ImageNodeData).url;
        break;
      }
    }
    if (!imageSrc) {
      get().showToast("请先连入一个已有图片的图片节点", "error");
      return;
    }
    get().updateNode(textNodeId, { reversing: true, error: undefined });
    try {
      const image = await srcToRefDataUrl(imageSrc);
      const res = await fetch("/api/reverse-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image }),
      });
      const payload = (await res.json()) as { prompt?: string; error?: string };
      if (!res.ok || !payload.prompt) throw new Error(payload.error || "视觉反推失败");
      // 反推结果为纯文本：同时清掉旧的富文本 html，编辑器按新 text 重建
      get().updateNode(textNodeId, { text: payload.prompt, html: undefined, reversing: false });
      get().showToast("视觉反推完成", "success");
    } catch (e) {
      get().updateNode(textNodeId, { reversing: false, error: (e as Error).message });
      get().showToast((e as Error).message, "error");
    }
  },

  // ── Workspace persistence ──────────────────────────────────────────────────

  loadWorkspace: async () => {
    try {
      const res = await fetch("/api/boards");
      const file = (await res.json()) as WorkspaceFile | null;
      if (file && Array.isArray(file.boards) && file.boards.length) {
        const boardsData: Record<string, BoardSnapshot> = {};
        for (const b of file.boards) {
          const rawNodes = (b.nodes as AppNode[]) ?? [];
          const interruptedResultIds = new Set(
            rawNodes
              .filter((node) => {
                if (node.type !== "image") return false;
                const data = node.data as ImageNodeData;
                return data.isGeneratedResult && data.status === "running" && !data.jobIds?.length;
              })
              .map((node) => node.id),
          );
          const nodes = rawNodes.map((node) => {
            if (!interruptedResultIds.has(node.id)) return node;
            return {
              ...node,
              data: {
                ...node.data,
                status: "failed",
                progress: 0,
                error: "提交过程被中断，请从原节点重新生成。",
              },
            } as AppNode;
          });
          const edges = ((b.edges as Edge[]) ?? []).map((edge) =>
            interruptedResultIds.has(edge.target) && edge.data?.generation === true
              ? {
                  ...edge,
                  animated: false,
                  className: "tf-generation-edge tf-generation-edge--failed",
                }
              : edge,
          );
          boardsData[b.id] = {
            nodes,
            edges,
            counters: b.counters ?? {},
          };
        }
        const activeId = file.boards.some((b) => b.id === file.activeId) ? file.activeId : file.boards[0].id;
        const active = boardsData[activeId];
        set({
          workspaceName: file.workspaceName || "未命名工作区",
          boards: file.boards.map((b) => ({ id: b.id, name: b.name })),
          activeBoardId: activeId,
          boardsData,
          nodes: active.nodes,
          edges: active.edges,
          counters: active.counters,
          loaded: true,
        });
        // Resume any generation that was mid-flight when the page closed.
        for (const n of active.nodes) {
          if (n.type === "image") {
            const d = n.data as ImageNodeData;
            if (d.status === "running" && d.jobIds?.length) {
              pollImageNode(n.id, d.jobIds, set, get, d.submissionFailures ?? 0, d.jobLabels);
            }
          } else if (n.type === "video") {
            const d = n.data as VideoNodeData;
            if (d.status === "running" && d.taskId) pollVideoNode(n.id, d.taskId, d.prompt, set, get);
          }
        }
        return;
      }
    } catch {
      // fall through to fresh workspace
    }
    set({ loaded: true });
  },

  scheduleSave: () => {
    if (!get().loaded) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void get().saveWorkspaceNow(), 1200);
  },

  saveWorkspaceNow: async () => {
    const s = get();
    if (!s.loaded) return;
    const boardsData = { ...s.boardsData, [s.activeBoardId]: { nodes: s.nodes, edges: s.edges, counters: s.counters } };
    const file: WorkspaceFile = {
      workspaceName: s.workspaceName,
      activeId: s.activeBoardId,
      boards: s.boards.map((b) => ({
        id: b.id,
        name: b.name,
        updatedAt: Date.now(),
        nodes: (boardsData[b.id]?.nodes ?? []) as unknown[],
        edges: (boardsData[b.id]?.edges ?? []) as unknown[],
        counters: boardsData[b.id]?.counters ?? {},
      })),
    };
    try {
      await fetch("/api/boards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(file),
      });
    } catch {
      // silent: next change retries
    }
  },

  addBoard: () => {
    const s = get();
    const id = `b-${Date.now().toString(36)}`;
    const name = `画布 ${s.boards.length + 1}`;
    // stash current
    const boardsData = { ...s.boardsData, [s.activeBoardId]: { nodes: s.nodes, edges: s.edges, counters: s.counters } };
    boardsData[id] = { nodes: [], edges: [], counters: {} };
    set({
      boards: [...s.boards, { id, name }],
      boardsData,
      activeBoardId: id,
      nodes: [],
      edges: [],
      counters: {},
    });
    get().scheduleSave();
  },

  switchBoard: (id) => {
    const s = get();
    if (id === s.activeBoardId) return;
    const boardsData = { ...s.boardsData, [s.activeBoardId]: { nodes: s.nodes, edges: s.edges, counters: s.counters } };
    const target = boardsData[id] ?? { nodes: [], edges: [], counters: {} };
    set({ boardsData, activeBoardId: id, nodes: target.nodes, edges: target.edges, counters: target.counters });
    get().scheduleSave();
  },

  renameBoard: (id, name) => {
    set({ boards: get().boards.map((b) => (b.id === id ? { ...b, name: name.trim() || b.name } : b)) });
    void get().saveWorkspaceNow();
  },

  deleteBoard: (id) => {
    const s = get();
    if (s.boards.length <= 1) {
      get().showToast("至少保留一个画布", "error");
      return;
    }
    const rest = s.boards.filter((b) => b.id !== id);
    const boardsData = { ...s.boardsData };
    delete boardsData[id];
    if (id === s.activeBoardId) {
      const next = rest[0];
      const snap = boardsData[next.id] ?? { nodes: [], edges: [], counters: {} };
      set({ boards: rest, boardsData, activeBoardId: next.id, nodes: snap.nodes, edges: snap.edges, counters: snap.counters });
    } else {
      set({ boards: rest, boardsData });
    }
    get().scheduleSave();
  },
}));

// ── Polling loops (module scope; survive component unmounts) ─────────────────

type SetFn = (partial: Partial<StudioState>) => void;
type GetFn = () => StudioState;

function nodeExists(get: GetFn, nodeId: string): boolean {
  return get().nodes.some((n) => n.id === nodeId);
}

function patchNode(get: GetFn, nodeId: string, patch: Record<string, unknown>) {
  if (!nodeExists(get, nodeId)) return;
  get().updateNode(nodeId, patch);
}

function imageResultIsRunning(nodeId: string, get: GetFn): boolean {
  const node = get().nodes.find((candidate) => candidate.id === nodeId);
  return node?.type === "image" && (node.data as ImageNodeData).status === "running";
}

function settleGenerationEdge(
  resultNodeId: string,
  status: "success" | "failed" | "cancelled",
  set: SetFn,
  get: GetFn,
) {
  let changed = false;
  const edges = get().edges.map((edge) => {
    if (edge.target !== resultNodeId || edge.data?.generation !== true) return edge;
    changed = true;
    return {
      ...edge,
      animated: false,
      className: `tf-generation-edge tf-generation-edge--${status}`,
    };
  });
  if (!changed) return;
  set({ edges });
  get().scheduleSave();
}

function pollImageNode(
  nodeId: string,
  jobIds: string[],
  set: SetFn,
  get: GetFn,
  submissionFailures = 0,
  jobLabels: string[] = [],
) {
  clearPoll(nodeId);
  const startedAt = ((get().nodes.find((n) => n.id === nodeId)?.data as ImageNodeData | undefined)?.startedAt) ?? Date.now();

  const tick = async () => {
    if (!nodeExists(get, nodeId)) return clearPoll(nodeId);
    let results: JobStatusResponse[];
    try {
      results = await mapWithConcurrency(
        jobIds,
        24,
        async (id) => (await fetch(`/api/jobs/${encodeURIComponent(id)}`)).json() as Promise<JobStatusResponse>,
      );
    } catch {
      // transient network error — keep polling
      pollTimers.set(nodeId, setTimeout(tick, 3200));
      return;
    }
    if (!imageResultIsRunning(nodeId, get)) return clearPoll(nodeId);

    const done = results.filter((r) => r.status !== "running");
    const failed = results.filter((r) => r.status === "failed");

    if (done.length === results.length) {
      clearPoll(nodeId);
      const entries = results.flatMap((result, index) => result.status === "success"
        ? result.images.map((url, imageIndex) => ({
            url,
            label: jobLabels[index]
              ? `${jobLabels[index]}${result.images.length > 1 ? ` · ${imageIndex + 1}` : ""}`
              : "",
          }))
        : []);
      const urls = entries.map((entry) => entry.url);
      const resultLabels = entries.map((entry) => entry.label);
      if (urls.length) {
        patchNode(get, nodeId, {
          status: "success",
          progress: 100,
          urls,
          resultLabels,
          url: urls[0],
          activeIndex: 0,
          error: failed.length || submissionFailures
            ? [failed.length ? `${failed.length} 张生成失败` : "", submissionFailures ? `${submissionFailures} 组提交失败` : ""].filter(Boolean).join("，")
            : undefined,
        });
        settleGenerationEdge(nodeId, "success", set, get);
        if (failed.length || submissionFailures) {
          get().showToast(`部分成功：${failed.length + submissionFailures} 项失败`, "error");
        }
      } else {
        const msg = failed[0]?.error || "生成失败";
        patchNode(get, nodeId, { status: "failed", progress: 0, error: msg });
        settleGenerationEdge(nodeId, "failed", set, get);
        get().showToast(msg, "error");
      }
      return;
    }

    // Fake progress with real upstream progress as a floor.
    const elapsed = (Date.now() - startedAt) / 1000;
    const real = results.length
      ? results.reduce((sum, result) => sum + (result.progress ?? 0) * 100, 0) / results.length
      : 0;
    const fake = fakeProgressCurve(elapsed);
    patchNode(get, nodeId, { progress: Math.min(99, Math.max(fake, real)) });
    pollTimers.set(nodeId, setTimeout(tick, 2600));
  };

  pollTimers.set(nodeId, setTimeout(tick, 1600));
}

function pollVideoNode(nodeId: string, taskId: string, prompt: string, _set: SetFn, get: GetFn) {
  clearPoll(nodeId);
  const startedAt = ((get().nodes.find((n) => n.id === nodeId)?.data as VideoNodeData | undefined)?.startedAt) ?? Date.now();

  const tick = async () => {
    if (!nodeExists(get, nodeId)) return clearPoll(nodeId);
    let payload: { status: string; progress?: number; videoUrl?: string; error?: string };
    try {
      payload = await (await fetch(`/api/video/jobs/${encodeURIComponent(taskId)}`)).json();
    } catch {
      pollTimers.set(nodeId, setTimeout(tick, 6000));
      return;
    }

    if (payload.status === "success" && payload.videoUrl) {
      clearPoll(nodeId);
      // Persist to output/ so the URL survives upstream expiry.
      const node = get().nodes.find((n) => n.id === nodeId);
      const d = node?.data as VideoNodeData | undefined;
      try {
        const saveRes = await fetch("/api/video/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            videoUrl: payload.videoUrl,
            taskId,
            meta: {
              taskId,
              model: d?.model ?? "v3",
              mode: d?.mode ?? "720p",
              duration: d?.duration ?? 5,
              prompt,
              sound: d?.sound ?? false,
              aspectRatio: d?.aspectRatio ?? "智能",
              createdAt: Date.now(),
            },
          }),
        });
        const savePayload = (await saveRes.json()) as { localUrl?: string; error?: string };
        const url = savePayload.localUrl ?? payload.videoUrl;
        patchNode(get, nodeId, { status: "success", progress: 100, url, remoteUrl: payload.videoUrl });
      } catch {
        patchNode(get, nodeId, { status: "success", progress: 100, url: payload.videoUrl, remoteUrl: payload.videoUrl });
      }
      get().showToast("视频生成完成", "success");
      return;
    }

    if (payload.status === "failed") {
      clearPoll(nodeId);
      const msg = payload.error || "视频生成失败";
      patchNode(get, nodeId, { status: "failed", progress: 0, error: msg });
      get().showToast(msg, "error");
      return;
    }

    const elapsed = (Date.now() - startedAt) / 1000;
    // Video runs are minutes-long; stretch the fake curve accordingly.
    const fake = fakeProgressCurve(elapsed / 4);
    const real = payload.progress ?? 0;
    patchNode(get, nodeId, { progress: Math.min(99, Math.max(fake, real)) });
    pollTimers.set(nodeId, setTimeout(tick, 6000));
  };

  pollTimers.set(nodeId, setTimeout(tick, 4000));
}
