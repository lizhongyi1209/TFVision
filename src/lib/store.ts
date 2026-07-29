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
  type GroupNodeData,
  type ImageNodeData,
  type JobStatusResponse,
  type NodeKind,
  type PublicSettings,
  type RouteName,
  type ShotSegment,
  type TextNodeData,
  type VideoNodeData,
  type VideoReferenceAsset,
  type WorkspaceFile,
} from "./types";
import { downscaleImageSrc, fakeProgressCurve } from "./utils";
import { isSeedanceModel, resolveKeyframeSlots, shouldUseConnectedImageAsFirstFrame, supportsShots } from "./videoGateway";
import { requestTokenBalanceRefresh, settingsPatchUpdatesToken } from "./tokenBalanceRefresh";
import { presentImageGenerationError } from "./agentImageGeneration";
import {
  captureNodeDeletion,
  restoreNodeDeletion,
  type NodeDeletionSnapshot,
} from "./nodeDeletionUndo";
import {
  forgetVideoReferenceBlob,
  readVideoReferenceBlob,
  rememberVideoReferenceBlob,
} from "./videoReferenceStorage";

export type AppNode = Node<TextNodeData | ImageNodeData | VideoNodeData | GroupNodeData>;

export function canConnectNodeKinds(source: string | undefined, target: string | undefined): boolean {
  if (!source || !target) return false;
  if (source === "imageAsset") return target === "text" || target === "imageGenerator" || target === "videoGenerator";
  if (source === "videoAsset") return target === "videoGenerator";
  if (source === "text") return target === "imageGenerator" || target === "videoGenerator";
  if (source === "imageGenerator") return target === "imageAsset";
  if (source === "videoGenerator") return target === "videoAsset";
  // Legacy boards are migrated on load, but keeping these rules makes a
  // partially migrated snapshot safe to inspect and reconnect.
  if (source === "image") return target === "text" || target === "image" || target === "video" || target === "imageGenerator" || target === "videoGenerator";
  if (source === "video") return target === "video" || target === "videoGenerator";
  return false;
}

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

const KIND_LABEL: Record<NodeKind, string> = {
  text: "文本节点",
  imageAsset: "图片素材",
  imageGenerator: "图片生成",
  videoAsset: "视频素材",
  videoGenerator: "视频生成",
};

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
    model: "seedance-2.0",
    mode: "720p",
    duration: 5,
    aspectRatio: "智能",
    sound: false,
    audioMode: "off",
    negativePrompt: "",
    webSearch: false,
    cameraFixed: false,
    seedText: "",
    referType: "feature",
    keepOriginalSound: false,
    characterOrientation: "video",
    elementId: "",
    elementReferenceId: "element_1",
    shotMode: "auto",
    shotModeExplicit: false,
    shotsEnabled: false,
    shots: [],
    inputMode: "references",
    referenceAssets: [],
    keyframeAssets: [],
  };
}

function migrateLegacyBoard(rawNodes: AppNode[], rawEdges: Edge[]) {
  const occupiedIds = new Set(rawNodes.map((node) => node.id));
  const split = new Map<string, { assetId?: string; generatorId: string }>();
  const addedInputEdges: Edge[] = [];
  const nodes: AppNode[] = [];

  const nextSplitId = (base: string) => {
    let candidate = `${base}-generator`;
    let index = 2;
    while (occupiedIds.has(candidate)) candidate = `${base}-generator-${index++}`;
    occupiedIds.add(candidate);
    return candidate;
  };

  for (const node of rawNodes) {
    if (node.type === "image") {
      const data = node.data as ImageNodeData;
      if (data.isGeneratedResult) {
        nodes.push({ ...node, type: "imageAsset" } as AppNode);
        split.set(node.id, { assetId: node.id, generatorId: node.id });
        continue;
      }
      const urls = data.urls?.length ? data.urls : data.url ? [data.url] : [];
      if (!urls.length) {
        nodes.push({ ...node, type: "imageGenerator", data: { ...data, width: data.width || 420, height: Math.max(520, data.height ?? 520) } } as AppNode);
        split.set(node.id, { generatorId: node.id });
        continue;
      }
      const generatorId = nextSplitId(node.id);
      const assetData: ImageNodeData = {
        ...data,
        label: String(data.label || "图片素材").replace("图片节点", "图片素材"),
        status: "idle",
        progress: 0,
        error: undefined,
        jobIds: [],
        isGeneratedResult: undefined,
        generationSourceId: undefined,
      };
      const generatorData: ImageNodeData = {
        ...data,
        label: `${String(data.label || "图片").replace(/节点\s*\d*$/, "").trim()}生成`,
        url: null,
        urls: [],
        activeIndex: 0,
        status: "idle",
        progress: 0,
        error: undefined,
        jobIds: [],
        editMask: undefined,
        editGuide: undefined,
        editMaskImageIndex: undefined,
        amazonAiDisclosure: undefined,
        mediaWidth: undefined,
        mediaHeight: undefined,
        width: 420,
        height: 520,
      };
      const width = data.width || 470;
      nodes.push({ ...node, type: "imageAsset", data: assetData } as AppNode);
      nodes.push({
        ...node,
        id: generatorId,
        type: "imageGenerator",
        selected: false,
        position: { x: node.position.x + width + 150, y: node.position.y },
        data: generatorData,
      } as AppNode);
      split.set(node.id, { assetId: node.id, generatorId });
      addedInputEdges.push({ id: `e-migrate-${node.id}-${generatorId}`, source: node.id, target: generatorId });
      continue;
    }

    if (node.type === "video") {
      const data = node.data as VideoNodeData;
      if (data.isGeneratedResult) {
        nodes.push({ ...node, type: "videoAsset" } as AppNode);
        split.set(node.id, { assetId: node.id, generatorId: node.id });
        continue;
      }
      const hasMedia = Boolean(data.sourceVideo || data.url || data.remoteUrl);
      if (!hasMedia) {
        nodes.push({ ...node, type: "videoGenerator", data: { ...data, width: data.width || 460, height: undefined } } as AppNode);
        split.set(node.id, { generatorId: node.id });
        continue;
      }
      const generatorId = nextSplitId(node.id);
      const assetData: VideoNodeData = {
        ...data,
        label: String(data.label || "视频素材").replace("视频节点", "视频素材"),
        status: "idle",
        progress: 0,
        error: undefined,
        taskId: undefined,
        isGeneratedResult: undefined,
        generationSourceId: undefined,
      };
      const generatorData: VideoNodeData = {
        ...data,
        label: `${String(data.label || "视频").replace(/节点\s*\d*$/, "").trim()}生成`,
        url: null,
        remoteUrl: undefined,
        sourceVideo: undefined,
        status: "idle",
        progress: 0,
        error: undefined,
        taskId: undefined,
        mediaWidth: undefined,
        mediaHeight: undefined,
        mediaFrameRate: undefined,
        clipStart: undefined,
        clipEnd: undefined,
        width: 460,
        height: undefined,
      };
      const width = data.width || 430;
      nodes.push({ ...node, type: "videoAsset", data: assetData } as AppNode);
      nodes.push({
        ...node,
        id: generatorId,
        type: "videoGenerator",
        selected: false,
        position: { x: node.position.x + width + 150, y: node.position.y },
        data: generatorData,
      } as AppNode);
      split.set(node.id, { assetId: node.id, generatorId });
      addedInputEdges.push({ id: `e-migrate-${node.id}-${generatorId}`, source: node.id, target: generatorId });
      continue;
    }

    nodes.push(node);
  }

  const edges = rawEdges.map((edge) => {
    const sourceSplit = split.get(edge.source);
    const targetSplit = split.get(edge.target);
    const source = sourceSplit
      ? edge.data?.generation === true
        ? sourceSplit.generatorId
        : sourceSplit.assetId ?? sourceSplit.generatorId
      : edge.source;
    const target = targetSplit ? targetSplit.generatorId : edge.target;
    return { ...edge, source, target };
  });
  const edgeKeys = new Set(edges.map((edge) => `${edge.source}:${edge.target}`));
  for (const edge of addedInputEdges) {
    if (!edgeKeys.has(`${edge.source}:${edge.target}`)) edges.push(edge);
  }
  return { nodes, edges };
}

// Poll timers live outside the store so they never serialize.
const pollTimers = new Map<string, ReturnType<typeof setTimeout>>();
const submitControllers = new Map<string, AbortController>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const MAX_NODE_DELETION_HISTORY = 30;
const nodeDeletionHistory = new Map<string, NodeDeletionSnapshot<AppNode, Edge>[]>();
const pendingRemovedEdges = new Map<string, Edge[]>();
const pendingRemovedEdgeTimers = new Map<string, ReturnType<typeof setTimeout>>();

interface NodeClipboardSnapshot {
  nodes: AppNode[];
  edges: Edge[];
  pasteCount: number;
}

let nodeClipboard: NodeClipboardSnapshot | null = null;

function cloneSerializable<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function resetCopiedNodeData(node: AppNode): Record<string, unknown> {
  const data = cloneSerializable(node.data) as Record<string, unknown>;
  if (data.status === "running") data.status = "idle";
  data.progress = data.status === "success" ? 100 : 0;
  data.jobIds = [];
  data.taskId = undefined;
  data.startedAt = undefined;
  data.generationDurationMs = undefined;
  data.error = undefined;
  data.cancelledAt = undefined;
  return data;
}

async function cloneLocalVideoAsset(asset: VideoReferenceAsset): Promise<VideoReferenceAsset> {
  const next = cloneSerializable(asset);
  const blob = asset.localKey
    ? await readVideoReferenceBlob(asset.localKey)
    : asset.localUrl?.startsWith("blob:")
      ? await fetch(asset.localUrl).then((response) => response.ok ? response.blob() : null).catch(() => null)
      : null;
  if (!blob) {
    if (next.localUrl?.startsWith("blob:")) delete next.localUrl;
    delete next.localKey;
    return next;
  }
  const key = `video-copy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await rememberVideoReferenceBlob(key, blob);
  return {
    ...next,
    id: key,
    localKey: key,
    localUrl: URL.createObjectURL(blob),
  };
}

async function prepareCopiedNodeData(node: AppNode): Promise<Record<string, unknown>> {
  const data = resetCopiedNodeData(node);
  if (node.type !== "videoAsset" && node.type !== "videoGenerator") return data;
  const videoData = data as VideoNodeData;
  const [sourceVideo, referenceAssets, keyframeAssets] = await Promise.all([
    videoData.sourceVideo ? cloneLocalVideoAsset(videoData.sourceVideo) : undefined,
    Promise.all((videoData.referenceAssets ?? []).map(cloneLocalVideoAsset)),
    Promise.all((videoData.keyframeAssets ?? []).map(cloneLocalVideoAsset)),
  ]);
  return { ...videoData, sourceVideo, referenceAssets, keyframeAssets };
}

function clearPoll(nodeId: string) {
  const t = pollTimers.get(nodeId);
  if (t) clearTimeout(t);
  pollTimers.delete(nodeId);
}

async function ensurePublicVideoReferenceUrl(
  asset: VideoReferenceAsset,
  model: VideoNodeData["model"],
  characterOrientation: VideoNodeData["characterOrientation"] = "video",
): Promise<string> {
  const hasTrim = asset.kind === "video" && Number.isFinite(asset.trimStart) && Number.isFinite(asset.trimEnd);
  if (!hasTrim && typeof asset.url === "string" && /^https?:\/\//i.test(asset.url)) return asset.url;
  let blob: Blob | null = null;
  if (asset.localKey) blob = await readVideoReferenceBlob(asset.localKey);
  if (!blob && asset.localUrl?.startsWith("blob:")) {
    blob = await fetch(asset.localUrl).then((response) => response.ok ? response.blob() : null).catch(() => null);
  }
  if (!blob && typeof asset.url === "string" && asset.url) {
    blob = await fetch(asset.url).then((response) => response.ok ? response.blob() : null).catch(() => null);
  }
  if (!blob) throw new Error(`${asset.name} 的本地文件已失效，请重新添加`);
  const form = new FormData();
  form.append("file", blob, asset.name);
  form.append("model", model);
  if (model === "v3-motion-control") form.append("characterOrientation", characterOrientation ?? "video");
  if (hasTrim) {
    form.append("trimStart", String(asset.trimStart));
    form.append("trimEnd", String(asset.trimEnd));
  }
  const response = await fetch("/api/video/upload", { method: "POST", body: form });
  const payload = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!response.ok || !payload.url) throw new Error(payload.error || `${asset.name} 上传失败`);
  return payload.url;
}

function clearVideoReferenceFiles(node: AppNode | undefined) {
  if (!node || (node.type !== "videoAsset" && node.type !== "videoGenerator")) return;
  const data = node.data as VideoNodeData;
  const assets = [
    ...(data.sourceVideo ? [data.sourceVideo] : []),
    ...(Array.isArray(data.referenceAssets) ? data.referenceAssets : []),
    ...(Array.isArray(data.keyframeAssets) ? data.keyframeAssets : []),
  ];
  for (const asset of assets) {
    if (asset.localUrl?.startsWith("blob:")) URL.revokeObjectURL(asset.localUrl);
    if (asset.localKey) void forgetVideoReferenceBlob(asset.localKey);
  }
}

function clearImageRuntime(nodeId: string) {
  clearPoll(nodeId);
  submitControllers.get(nodeId)?.abort();
  submitControllers.delete(nodeId);
}

function disposeDeletionSnapshot(snapshot: NodeDeletionSnapshot<AppNode, Edge>) {
  const removedIds = new Set(snapshot.removedNodeIds);
  for (const node of snapshot.nodes) {
    if (removedIds.has(node.id)) clearVideoReferenceFiles(node);
  }
}

function rememberNodeDeletion(boardId: string, nodes: AppNode[], edges: Edge[], nodeIds: string[]) {
  const snapshot = captureNodeDeletion(nodes, edges, nodeIds);
  if (!snapshot) return null;
  const history = nodeDeletionHistory.get(boardId) ?? [];
  history.push(snapshot);
  while (history.length > MAX_NODE_DELETION_HISTORY) {
    const discarded = history.shift();
    if (discarded) disposeDeletionSnapshot(discarded);
  }
  nodeDeletionHistory.set(boardId, history);
  return snapshot;
}

function rememberPendingRemovedEdges(boardId: string, edges: Edge[]) {
  if (!edges.length) return;
  const merged = new Map((pendingRemovedEdges.get(boardId) ?? []).map((edge) => [edge.id, edge]));
  for (const edge of edges) merged.set(edge.id, edge);
  pendingRemovedEdges.set(boardId, Array.from(merged.values()));
  const previousTimer = pendingRemovedEdgeTimers.get(boardId);
  if (previousTimer) clearTimeout(previousTimer);
  pendingRemovedEdgeTimers.set(boardId, setTimeout(() => {
    pendingRemovedEdges.delete(boardId);
    pendingRemovedEdgeTimers.delete(boardId);
  }, 100));
}

function takePendingRemovedEdges(boardId: string) {
  const edges = pendingRemovedEdges.get(boardId) ?? [];
  pendingRemovedEdges.delete(boardId);
  const timer = pendingRemovedEdgeTimers.get(boardId);
  if (timer) clearTimeout(timer);
  pendingRemovedEdgeTimers.delete(boardId);
  return edges;
}

function clearNodeDeletionHistory(boardId?: string) {
  const boardIds = boardId
    ? [boardId]
    : Array.from(new Set([...nodeDeletionHistory.keys(), ...pendingRemovedEdges.keys()]));
  for (const id of boardIds) {
    const history = nodeDeletionHistory.get(id) ?? [];
    for (const snapshot of history) disposeDeletionSnapshot(snapshot);
    nodeDeletionHistory.delete(id);
    pendingRemovedEdges.delete(id);
    const timer = pendingRemovedEdgeTimers.get(id);
    if (timer) clearTimeout(timer);
    pendingRemovedEdgeTimers.delete(id);
  }
}

async function srcToRefDataUrl(src: string): Promise<string> {
  // data URLs are re-compressed too (bounds request size); /api/media URLs are same-origin.
  const { dataUrl } = await downscaleImageSrc(src, 1600, 0.92);
  return dataUrl;
}

const isCombinationOptionValid = (option: CombinationOption) => Boolean(option.image);

function nextGeneratedImageLabel(baseLabel: string, nodes: AppNode[], ignoredNodeIds: Set<string>) {
  const base = baseLabel.trim() || "生成结果";
  const usedLabels = new Set(
    nodes.flatMap((candidate) => {
      if (candidate.type !== "imageAsset" || ignoredNodeIds.has(candidate.id)) return [];
      const label = String((candidate.data as ImageNodeData).label ?? "").trim();
      return label ? [label] : [];
    }),
  );
  if (!usedLabels.has(base)) return base;

  let suffix = 1;
  while (usedLabels.has(`${base}${suffix}`)) suffix += 1;
  return `${base}${suffix}`;
}

function nextGeneratedVideoLabel(baseLabel: string, nodes: AppNode[]) {
  const base = `${baseLabel.trim() || "视频节点"} · 结果`;
  const usedLabels = new Set(
    nodes.flatMap((candidate) => {
      if (candidate.type !== "videoAsset") return [];
      const label = String((candidate.data as VideoNodeData).label ?? "").trim();
      return label ? [label] : [];
    }),
  );
  if (!usedLabels.has(base)) return base;

  let suffix = 2;
  while (usedLabels.has(`${base} ${suffix}`)) suffix += 1;
  return `${base} ${suffix}`;
}

function absoluteNodePosition(node: AppNode, nodes: AppNode[]): XYPosition {
  let x = node.position.x;
  let y = node.position.y;
  let parentId = node.parentId;
  const visited = new Set<string>();
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = nodes.find((candidate) => candidate.id === parentId);
    if (!parent) break;
    x += parent.position.x;
    y += parent.position.y;
    parentId = parent.parentId;
  }
  return { x, y };
}

function ungroupNodes(nodes: AppNode[], groupId: string, selectChildren = true): AppNode[] {
  const group = nodes.find((node) => node.id === groupId && node.type === "group");
  if (!group) return nodes;
  const groupPosition = absoluteNodePosition(group, nodes);
  return nodes
    .filter((node) => node.id !== groupId)
    .map((node) => {
      if (node.parentId !== groupId) return node;
      return {
        ...node,
        parentId: undefined,
        extent: undefined,
        expandParent: undefined,
        zIndex: undefined,
        selected: selectChildren,
        position: {
          x: groupPosition.x + node.position.x,
          y: groupPosition.y + node.position.y,
        },
      } as AppNode;
    });
}

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
  undoDelete: () => boolean;
  removeEdge: (id: string) => void;
  updateNode: (id: string, patch: Record<string, unknown>) => void;
  duplicateNode: (id: string) => void;
  copySelectedNodes: () => number;
  pasteCopiedNodes: () => Promise<number>;
  createGroup: (nodeIds: string[]) => string | undefined;
  ungroupNode: (groupId: string) => void;
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
  saveSettings: (patch: { apiKey?: string; clearApiKey?: boolean; route?: RouteName }) => Promise<boolean>;

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

  workspaceName: "画布 1",
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
  tool: "hand",

  onNodesChange: (changes) => {
    const state = get();
    const currentNodes = state.nodes;
    const removedNodeIds = changes.flatMap((change) => change.type === "remove" ? [change.id] : []);
    if (removedNodeIds.length) {
      const deletionEdges = new Map(state.edges.map((edge) => [edge.id, edge]));
      for (const edge of takePendingRemovedEdges(state.activeBoardId)) deletionEdges.set(edge.id, edge);
      rememberNodeDeletion(state.activeBoardId, currentNodes, Array.from(deletionEdges.values()), removedNodeIds);
    }
    const removedGroupIds = changes.flatMap((change) => {
      if (change.type !== "remove") return [];
      return currentNodes.some((node) => node.id === change.id && node.type === "group") ? [change.id] : [];
    });
    const preparedNodes = removedGroupIds.reduce(
      (nextNodes, groupId) => ungroupNodes(nextNodes, groupId),
      currentNodes,
    );
    const nonGroupChanges = changes.filter(
      (change) => !(change.type === "remove" && removedGroupIds.includes(change.id)),
    );
    const nextNodes = applyNodeChanges(nonGroupChanges, preparedNodes) as AppNode[];
    const removedIds = new Set(removedNodeIds);
    const nextEdges = removedIds.size
      ? state.edges.filter((edge) => !removedIds.has(edge.source) && !removedIds.has(edge.target))
      : state.edges;
    set({ nodes: nextNodes, edges: nextEdges });
    // Node removal via keyboard lands here too — stop any orphaned polls.
    for (const c of changes) {
      if (c.type === "remove") {
        clearImageRuntime(c.id);
      }
    }
    get().scheduleSave();
  },

  onEdgesChange: (changes) => {
    const state = get();
    const removedIds = new Set(changes.flatMap((change) => change.type === "remove" ? [change.id] : []));
    if (removedIds.size) {
      rememberPendingRemovedEdges(
        state.activeBoardId,
        state.edges.filter((edge) => removedIds.has(edge.id)),
      );
    }
    set({ edges: applyEdgeChanges(changes, state.edges) });
    get().scheduleSave();
  },

  onConnect: (conn) => {
    if (!conn.source || !conn.target || conn.source === conn.target) return;
    const { nodes, edges } = get();
    const source = nodes.find((n) => n.id === conn.source);
    const target = nodes.find((n) => n.id === conn.target);
    if (!source || !target) return;
    if (!canConnectNodeKinds(source.type, target.type)) {
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
        : kind === "imageAsset" || kind === "imageGenerator"
          ? {
              ...defaultImageData(label),
              ...(kind === "imageGenerator" ? { width: 420, height: 520 } : {}),
              ...extra,
            }
          : { ...defaultVideoData(label), ...extra }
    ) as TextNodeData | ImageNodeData | VideoNodeData;
    const id = uid();
    const node: AppNode = { id, type: kind, position, data } as AppNode;
    set({ nodes: [...nodes, node], counters: { ...counters, [kind]: n } });
    get().scheduleSave();
    return id;
  },

  removeNode: (id) => {
    const state = get();
    const node = state.nodes.find((candidate) => candidate.id === id);
    if (!node) return;
    rememberNodeDeletion(state.activeBoardId, state.nodes, state.edges, [id]);
    if (node?.type === "group") {
      set({ nodes: ungroupNodes(state.nodes, id) });
      get().scheduleSave();
      return;
    }
    clearImageRuntime(id);
    set({
      nodes: state.nodes.filter((n) => n.id !== id),
      edges: state.edges.filter((e) => e.source !== id && e.target !== id),
    });
    get().scheduleSave();
  },

  undoDelete: () => {
    const state = get();
    const history = nodeDeletionHistory.get(state.activeBoardId);
    const snapshot = history?.pop();
    if (!snapshot) return false;
    if (!history?.length) nodeDeletionHistory.delete(state.activeBoardId);

    const restored = restoreNodeDeletion(state.nodes, state.edges, snapshot);
    set(restored);
    for (const nodeId of snapshot.removedNodeIds) {
      const node = restored.nodes.find((candidate) => candidate.id === nodeId);
      if (!node) continue;
      if (node.type === "imageAsset") {
        const data = node.data as ImageNodeData;
        if (data.status === "running" && data.jobIds?.length) {
          pollImageNode(node.id, data.jobIds, set, get, data.submissionFailures ?? 0, data.jobLabels);
        }
      } else if (node.type === "videoAsset") {
        const data = node.data as VideoNodeData;
        if (data.status === "running" && data.taskId) pollVideoNode(node.id, data.taskId, data.prompt, set, get);
      }
    }
    get().scheduleSave();
    get().showToast(`已恢复 ${snapshot.removedNodeIds.length} 个节点`, "success");
    return true;
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
    const kind = (src.type ?? "imageAsset") as NodeKind;
    const pos = { x: src.position.x + 60, y: src.position.y + 60 };
    const data = JSON.parse(JSON.stringify(src.data)) as Record<string, unknown>;
    // Duplicates never inherit an in-flight job.
    data.status = "idle";
    data.progress = 0;
    data.jobIds = [];
    data.taskId = undefined;
    data.generationDurationMs = undefined;
    if (kind === "imageAsset" && data.isGeneratedResult) {
      delete data.label;
      data.isGeneratedResult = undefined;
      data.generationSourceId = undefined;
      data.generationReferenceImages = undefined;
      data.cancelledAt = undefined;
    }
    const duplicateId = get().addNode(kind, pos, data);
    if (src.parentId) {
      set({
        nodes: get().nodes.map((node) =>
          node.id === duplicateId
            ? ({ ...node, parentId: src.parentId, zIndex: 1 } as AppNode)
            : node,
        ),
      });
      get().scheduleSave();
    }
  },

  copySelectedNodes: () => {
    const { nodes, edges } = get();
    const copiedIds = new Set(nodes.filter((node) => node.selected).map((node) => node.id));
    if (!copiedIds.size) return 0;

    // Selecting a group copies its full contents, including nested groups.
    let addedChild = true;
    while (addedChild) {
      addedChild = false;
      for (const node of nodes) {
        if (node.parentId && copiedIds.has(node.parentId) && !copiedIds.has(node.id)) {
          copiedIds.add(node.id);
          addedChild = true;
        }
      }
    }
    const copiedNodes = nodes
      .filter((node) => copiedIds.has(node.id))
      .map((node) => node.parentId && !copiedIds.has(node.parentId)
        ? ({ ...node, parentId: undefined, position: absoluteNodePosition(node, nodes) } as AppNode)
        : node);
    nodeClipboard = {
      nodes: cloneSerializable(copiedNodes),
      edges: cloneSerializable(edges.filter((edge) => copiedIds.has(edge.source) && copiedIds.has(edge.target))),
      pasteCount: 0,
    };
    get().showToast(`已复制 ${copiedIds.size} 个节点`, "success");
    return copiedIds.size;
  },

  pasteCopiedNodes: async () => {
    const clipboard = nodeClipboard;
    if (!clipboard?.nodes.length) return 0;
    clipboard.pasteCount += 1;
    const offset = 48 * clipboard.pasteCount;
    const idMap = new Map(clipboard.nodes.map((node) => [node.id, uid()]));
    const preparedData = await Promise.all(clipboard.nodes.map(prepareCopiedNodeData));
    const pastedNodes = clipboard.nodes.map((node, index) => {
      const copiedParentId = node.parentId ? idMap.get(node.parentId) : undefined;
      const absolutePosition = absoluteNodePosition(node, clipboard.nodes);
      return {
        ...cloneSerializable(node),
        id: idMap.get(node.id)!,
        parentId: copiedParentId,
        position: copiedParentId
          ? { ...node.position }
          : { x: absolutePosition.x + offset, y: absolutePosition.y + offset },
        data: preparedData[index],
        selected: !copiedParentId,
        dragging: false,
        measured: undefined,
      } as AppNode;
    });
    const pastedEdges = clipboard.edges.flatMap((edge) => {
      const source = idMap.get(edge.source);
      const target = idMap.get(edge.target);
      if (!source || !target) return [];
      return [{
        ...cloneSerializable(edge),
        id: `e-${source}-${target}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        source,
        target,
        selected: false,
      } satisfies Edge];
    });
    set((state) => ({
      nodes: [...state.nodes.map((node) => ({ ...node, selected: false })), ...pastedNodes],
      edges: [...state.edges.map((edge) => ({ ...edge, selected: false })), ...pastedEdges],
    }));
    get().scheduleSave();
    get().showToast(`已粘贴 ${pastedNodes.length} 个节点`, "success");
    return pastedNodes.length;
  },

  createGroup: (nodeIds) => {
    const { nodes, counters } = get();
    const requestedIds = new Set(nodeIds);
    const members = nodes.filter(
      (node) => requestedIds.has(node.id) && node.type !== "group" && !node.parentId,
    );
    if (members.length < 2) {
      get().showToast("请至少框选 2 个未分组节点", "error");
      return undefined;
    }

    const boxes = members.map((node) => {
      const dataWidth = Number((node.data as { width?: number }).width);
      const dataHeight = Number((node.data as { height?: number }).height);
      const width = node.measured?.width ?? node.width ?? (dataWidth > 0 ? dataWidth : 420);
      const height = node.measured?.height ?? node.height ?? (dataHeight > 0 ? dataHeight : 300);
      return { x: node.position.x, y: node.position.y, width, height };
    });
    const minX = Math.min(...boxes.map((box) => box.x));
    const minY = Math.min(...boxes.map((box) => box.y));
    const maxX = Math.max(...boxes.map((box) => box.x + box.width));
    const maxY = Math.max(...boxes.map((box) => box.y + box.height));
    const sidePadding = 32;
    const topPadding = 72;
    const bottomPadding = 32;
    const groupPosition = { x: minX - sidePadding, y: minY - topPadding };
    const groupWidth = Math.max(360, maxX - minX + sidePadding * 2);
    const groupHeight = Math.max(240, maxY - minY + topPadding + bottomPadding);
    const number = (counters.group ?? 0) + 1;
    const groupId = uid();
    const group: AppNode = {
      id: groupId,
      type: "group",
      position: groupPosition,
      data: { label: `分组 ${number}`, color: "graphite" } satisfies GroupNodeData,
      width: groupWidth,
      height: groupHeight,
      dragHandle: ".tf-group-drag-handle",
      selected: true,
      deletable: true,
      zIndex: 0,
    };
    const memberIds = new Set(members.map((node) => node.id));
    const remainingNodes = nodes.filter((node) => !memberIds.has(node.id)).map((node) => ({ ...node, selected: false }));
    const groupedMembers = members.map((node) => ({
      ...node,
      parentId: groupId,
      // The group is a visual background and shared drag origin only. Members
      // stay layout-independent so dialogs/resizing never expand or shift it.
      extent: undefined,
      expandParent: undefined,
      zIndex: 1,
      selected: false,
      position: {
        x: node.position.x - groupPosition.x,
        y: node.position.y - groupPosition.y,
      },
    }));
    set({
      nodes: [...remainingNodes, group, ...groupedMembers] as AppNode[],
      counters: { ...counters, group: number },
    });
    get().scheduleSave();
    get().showToast(`已将 ${members.length} 个节点建组`, "success");
    return groupId;
  },

  ungroupNode: (groupId) => {
    const group = get().nodes.find((node) => node.id === groupId && node.type === "group");
    if (!group) return;
    set({ nodes: ungroupNodes(get().nodes, groupId) });
    get().scheduleSave();
    get().showToast("已取消分组", "success");
  },

  renameWorkspace: (name) => {
    const s = get();
    const activeBoard = s.boards.find((board) => board.id === s.activeBoardId);
    const nextName = name.trim() || activeBoard?.name || "画布 1";
    set({
      workspaceName: nextName,
      boards: s.boards.map((board) => board.id === s.activeBoardId ? { ...board, name: nextName } : board),
    });
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
      if (settingsPatchUpdatesToken(patch)) requestTokenBalanceRefresh();
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
    if (!node || node.type !== "imageAsset" || !data?.isGeneratedResult || data.status !== "running") return;

    clearImageRuntime(nodeId);
    get().updateNode(nodeId, {
      status: "cancelled",
      progress: 0,
      cancelledAt: Date.now(),
      generationDurationMs: data.startedAt ? Math.max(0, Date.now() - data.startedAt) : undefined,
      error: undefined,
    });
    settleGenerationEdge(nodeId, "cancelled", set, get);
    get().showToast("已取消本次生成", "info");
  },

  generateImage: async (nodeId) => {
    const state = get();
    const node = state.nodes.find((n) => n.id === nodeId);
    if (!node || node.type !== "imageGenerator") return;
    const data = node.data as ImageNodeData;
    if (data.isGeneratedResult) return;

    // Assemble prompt: upstream text nodes first, then the node's own prompt.
    const upstream = state.edges.filter((e) => e.target === nodeId);
    const textParts: string[] = [];
    const refSrcs: string[] = [];
    let hasUpstreamTextNode = false;
    let upstreamPrimaryImage: AppNode | undefined;
    for (const e of upstream) {
      const src = state.nodes.find((n) => n.id === e.source);
      if (!src) continue;
      if (src.type === "text") {
        hasUpstreamTextNode = true;
        const t = (src.data as TextNodeData).text.trim();
        if (t) textParts.push(t);
      } else if (src.type === "imageAsset") {
        const imageData = src.data as ImageNodeData;
        const sources = imageData.urls.length ? imageData.urls : imageData.url ? [imageData.url] : [];
        if (sources.length && !upstreamPrimaryImage) upstreamPrimaryImage = src;
        refSrcs.push(...sources);
      }
    }
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
    const effectiveNodePrompt = hasUpstreamTextNode ? "" : data.prompt.trim();
    let requests: ImageGenerationRequest[];

    if (data.combinationEnabled) {
      const groups = (Array.isArray(data.combinationGroups) ? data.combinationGroups : []).slice(0, MAX_COMBINATION_GROUPS);
      const minimumUploadedGroupCount = ownSources.length ? 1 : 2;
      if (groups.length < minimumUploadedGroupCount) {
        get().showToast(
          ownSources.length ? "请至少添加一个组合图片分类" : "节点无参考图时，组合生图至少需要两个图片分类",
          "error",
        );
        return;
      }
      const emptyGroup = groups.find((group) => !group.options.some(isCombinationOptionValid));
      if (emptyGroup) {
        get().showToast(`“${emptyGroup.name || "未命名分类"}”还没有有效选项`, "error");
        return;
      }
      const primarySources: Array<string | null> = ownSources.length ? ownSources : [null];
      const combinations = expandCombinationGroups(groups, Math.floor(MAX_BATCH_PROMPTS / primarySources.length));
      if (!combinations) {
        get().showToast(`组合数量超过 ${MAX_BATCH_PROMPTS}，请减少分类选项`, "error");
        return;
      }
      const hasUserPrompt = Boolean(effectiveNodePrompt || textParts.length);
      if (!hasUserPrompt) {
        get().showToast("请填写组合生图的通用提示词", "error");
        return;
      }

      requests = primarySources.flatMap((primarySource, primaryIndex) => combinations.map((combination) => {
        const combinationImages = combination.flatMap((option) => option.image ? [option.image] : []);
        const sources = [...(primarySource ? [primarySource] : []), ...refSrcs, ...combinationImages];
        const useEditGuide = Boolean(
          hasEditGuide &&
          data.editGuide &&
          primarySource &&
          primarySource === ownSources[data.editMaskImageIndex ?? -1],
        );
        if (useEditGuide && data.editGuide) sources.push(data.editGuide);
        const mappingLines: string[] = primarySource ? ["- 节点参考图：第 1 张参考图（主图）"] : [];
        let imageOffset = (primarySource ? 1 : 0) + refSrcs.length;
        combination.forEach((option, index) => {
          if (!option.image) return;
          imageOffset += 1;
          mappingLines.push(`- ${groups[index].name || `分类 ${index + 1 + (primarySource ? 1 : 0)}`}：第 ${imageOffset} 张参考图`);
        });
        const mapping = mappingLines.length ? `组合参考对应关系：\n${mappingLines.join("\n")}` : "";
        const labelParts = primarySource ? [`节点参考图 ${primaryIndex + 1}`] : [];
        labelParts.push(...combination.map((option, index) => {
          const groupName = groups[index].name.trim() || `分类 ${index + 1 + (primarySource ? 1 : 0)}`;
          const optionIndex = groups[index].options.filter(isCombinationOptionValid).findIndex((candidate) => candidate.id === option.id) + 1;
          return `${groupName} ${optionIndex}`;
        }));
        return {
          prompt: [...textParts, effectiveNodePrompt, mapping, useEditGuide ? localEditInstruction : ""].filter(Boolean).join("\n\n"),
          sources,
          label: labelParts.join(" · "),
        };
      }));
      if (requests.some((request) => request.sources.length > MAX_IMAGE_REFERENCES)) {
        get().showToast(`每个组合最多使用 ${MAX_IMAGE_REFERENCES} 张参考图，请减少连线参考图或图片分类`, "error");
        return;
      }
    } else {
      const ownPrompts = hasUpstreamTextNode
        ? [""]
        : data.batchPromptEnabled
        ? (Array.isArray(data.batchPrompts) ? data.batchPrompts : [])
            .slice(0, MAX_BATCH_PROMPTS)
            .map((item) => item.trim())
            .filter(Boolean)
        : [data.prompt.trim()];
      if (data.batchPromptEnabled && !hasUpstreamTextNode && !ownPrompts.length) {
        get().showToast("请至少填写一套批量提示词", "error");
        return;
      }
      const sources = globalSources.slice(0, MAX_IMAGE_REFERENCES - (hasEditGuide ? 1 : 0));
      if (hasEditGuide && data.editGuide) sources.push(data.editGuide);
      requests = ownPrompts
        .map((own) => ({
          prompt: [...textParts, own, localEditInstruction].filter(Boolean).join("\n\n"),
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
    const generationReferenceImages = Array.from(new Set(
      requests.flatMap((request) => request.sources)
        .filter((source) => !data.editGuide || source !== data.editGuide),
    ));
    const sourceWidth = data.width || 470;
    const sourceHeight = data.height ?? sourceWidth;
    const sourcePosition = absoluteNodePosition(node, state.nodes);
    const existingResults = state.nodes.filter(
      (candidate) =>
        candidate.type === "imageAsset" && (candidate.data as ImageNodeData).generationSourceId === nodeId,
    );
    const nextResultY = existingResults.length
      ? Math.max(...existingResults.map((candidate) => absoluteNodePosition(candidate, state.nodes).y)) + Math.min(sourceHeight, 560) + 110
      : sourcePosition.y;
    const primaryReferenceNode = ownSources.length ? node : upstreamPrimaryImage;
    const resultLabel = nextGeneratedImageLabel(
      primaryReferenceNode ? String((primaryReferenceNode.data as ImageNodeData).label ?? "") : "生成结果",
      state.nodes,
      new Set([nodeId, ...(primaryReferenceNode ? [primaryReferenceNode.id] : [])]),
    );
    const resultPosition = {
      x: sourcePosition.x + sourceWidth + 180,
      y: nextResultY,
    };
    const startedAt = Date.now();
    const resultNodeId = get().addNode("imageAsset", resultPosition, {
      label: resultLabel,
      url: null,
      urls: [],
      activeIndex: 0,
      status: "running",
      progress: 0,
      error: undefined,
      startedAt,
      generationDurationMs: undefined,
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
      width: 470,
      height: 470,
      isGeneratedResult: true,
      generationSourceId: nodeId,
      generationReferenceImages,
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
        const message = presentImageGenerationError(
          e instanceof Error ? e.message : typeof e === "string" ? e : "提交失败",
        );
        get().updateNode(resultNodeId, {
          status: "failed",
          error: message,
          progress: 0,
          generationDurationMs: Math.max(0, Date.now() - startedAt),
        });
        settleGenerationEdge(resultNodeId, "failed", set, get);
      }
    })();

    return resultNodeId;
  },

  // ── Video generation ───────────────────────────────────────────────────────

  generateVideo: async (nodeId) => {
    const state = get();
    const node = state.nodes.find((n) => n.id === nodeId);
    if (!node || node.type !== "videoGenerator") return;
    const data = node.data as VideoNodeData;
    if (data.isGeneratedResult) return;

    // 画布连线直接参与生成：文本作为公共提示词，图片作为视觉参考。
    const upstreamEdges = state.edges.filter((edge) => edge.target === nodeId && edge.data?.generation !== true);
    const upstreamTextParts: string[] = [];
    const upstreamImageAssets: VideoReferenceAsset[] = [];
    const upstreamVideoAssets: VideoReferenceAsset[] = [];
    const seenUpstreamImages = new Set<string>();
    for (const edge of upstreamEdges) {
      const source = state.nodes.find((candidate) => candidate.id === edge.source);
      if (source?.type === "text") {
        const text = (source.data as TextNodeData).text.trim();
        if (text) upstreamTextParts.push(text);
      } else if (source?.type === "imageAsset") {
        const image = source.data as ImageNodeData;
        const src = image.urls?.[image.activeIndex ?? 0] ?? image.url;
        if (!src || seenUpstreamImages.has(src)) continue;
        seenUpstreamImages.add(src);
        upstreamImageAssets.push({
          id: `canvas-image-${source.id}`,
          kind: "image",
          name: `${image.label || "画布参考图"}.png`,
          url: src,
        });
      } else if (source?.type === "videoAsset") {
        const video = source.data as VideoNodeData;
        if (video.sourceVideo) {
          upstreamVideoAssets.push({
            ...video.sourceVideo,
            trimStart: video.clipStart ?? video.sourceVideo.trimStart,
            trimEnd: video.clipEnd ?? video.sourceVideo.trimEnd,
            id: `canvas-video-${source.id}`,
            name: video.sourceVideo.name || `${video.label || "画布参考视频"}.mp4`,
          });
        } else {
          const src = video.url ?? video.remoteUrl;
          if (src) {
            upstreamVideoAssets.push({
              id: `canvas-video-${source.id}`,
              kind: "video",
              name: `${video.label || "画布参考视频"}.mp4`,
              url: src,
              mimeType: "video/mp4",
              trimStart: video.clipStart,
              trimEnd: video.clipEnd,
            });
          }
        }
      }
    }
    const prompt = [...upstreamTextParts, data.prompt.trim()].filter(Boolean).join("\n");
    const ownReferenceAssets = Array.isArray(data.referenceAssets) ? data.referenceAssets.filter(Boolean) : [];
    const sourceReferenceAssets = data.model === "v3-omni" && data.sourceVideo ? [data.sourceVideo] : [];
    const referenceAssets = [
      ...sourceReferenceAssets,
      ...ownReferenceAssets.filter((asset) => !sourceReferenceAssets.some((source) => source.id === asset.id)),
      ...upstreamImageAssets,
      ...upstreamVideoAssets,
    ];
    const referenceImages = referenceAssets.filter((asset) => asset.kind === "image");
    const referenceVideos = referenceAssets.filter((asset) => asset.kind === "video");
    const referenceAudios = referenceAssets.filter((asset) => asset.kind === "audio");
    const configuredShotMode = data.shotsEnabled || data.shotMode === "custom"
      ? "custom"
      : data.model === "v3-omni" && data.shotModeExplicit !== true
        ? "auto"
        : data.shotMode ?? "single";
    const shotMode = data.model === "v3-omni" && referenceVideos.length
      ? data.referType === "base" ? "single" : configuredShotMode === "single" ? "auto" : configuredShotMode
      : configuredShotMode;
    const shotsEnabled = shotMode === "custom" && supportsShots(data.model);
    const ownShots: ShotSegment[] = Array.isArray(data.shots) ? data.shots : [];
    const shots: ShotSegment[] = shotsEnabled && upstreamTextParts.length
      ? ownShots.map((shot) => ({ ...shot, prompt: [...upstreamTextParts, shot.prompt.trim()].filter(Boolean).join("\n") }))
      : ownShots;
    if (!shotsEnabled && !prompt) {
      get().showToast("请先输入视频提示词", "error");
      return;
    }
    if (!shotsEnabled && data.model === "v3-omni" && prompt.length > 3072) {
      get().showToast("可灵 Omni 提示词不能超过 3072 字符", "error");
      return;
    }
    if (shotsEnabled) {
      if (isSeedanceModel(data.model) || data.model === "v2-6") {
        get().showToast("当前模型不支持分镜模式", "error");
        return;
      }
      if (!shots.length || shots.length > 6) {
        get().showToast("分镜数量需要为 1-6 段", "error");
        return;
      }
      const invalidShot = shots.find((shot) => !shot.prompt.trim() || shot.prompt.length > 512 || !Number.isInteger(shot.duration) || shot.duration < 1);
      if (invalidShot) {
        get().showToast(`第 ${invalidShot.index} 段分镜需为 1 秒以上，且提示词不超过 512 字符`, "error");
        return;
      }
      const total = shots.reduce((sum, shot) => sum + shot.duration, 0);
      if (total !== data.duration) {
        get().showToast(`各分镜时长之和 (${total}s) 必须等于总时长 (${data.duration}s)`, "error");
        return;
      }
    }
    const inputMode = data.inputMode === "keyframes" ? "keyframes" : "references";
    const keyframeAssets = Array.isArray(data.keyframeAssets)
      ? data.keyframeAssets.filter((asset) => asset && asset.kind === "image")
      : [];
    const { firstFrame: firstFrameAsset, lastFrame: lastFrameAsset } = resolveKeyframeSlots(
      keyframeAssets,
      inputMode === "keyframes" ? upstreamImageAssets : [],
    );
    const needsFrame = data.model === "v3" || data.model === "v2-6";
    if (inputMode === "keyframes" && needsFrame && !firstFrameAsset) {
      get().showToast("首尾帧模式需要添加首帧图片", "error");
      return;
    }
    if (inputMode === "references" && needsFrame && !referenceImages.length) {
      get().showToast("该旧模型需要至少一张参考图作为首帧", "error");
      return;
    }
    if (data.model === "v3-omni") {
      if (referenceAudios.length) {
        get().showToast("可灵 v3 Omni 暂不支持参考音频，请移除音频或切换 Seedance", "error");
        return;
      }
      if (referenceVideos.length > 1) {
        get().showToast("可灵 v3 Omni 最多支持 1 段参考视频", "error");
        return;
      }
      if (lastFrameAsset && !firstFrameAsset) {
        get().showToast("可灵 Omni 不支持仅尾帧，请先添加首帧", "error");
        return;
      }
      const imageLimit = referenceVideos.length ? 4 : 7;
      const totalImages = referenceImages.length + keyframeAssets.length;
      if (totalImages > imageLimit) {
        get().showToast(`当前组合下可灵 v3 Omni 最多支持 ${imageLimit} 张图片`, "error");
        return;
      }
      if (referenceVideos.length && data.referType === "base") {
        if (shotsEnabled) {
          get().showToast("视频编辑（base）模式不支持分镜", "error");
          return;
        }
        if (keyframeAssets.length) {
          get().showToast("视频编辑（base）模式不支持首尾帧", "error");
          return;
        }
      }
      const audioMode = data.audioMode ?? (data.keepOriginalSound ? "original" : data.sound ? "native" : "off");
      if (referenceVideos.length && data.referType !== "base" && audioMode === "native") {
        get().showToast("视频参考（feature）模式不能生成原生音频，请选择保留原声或关闭声音", "error");
        return;
      }
      if (referenceVideos.length && data.referType === "base" && audioMode === "native") {
        get().showToast("视频编辑（base）模式只能关闭音频或保留原声", "error");
        return;
      }
      if (!referenceVideos.length && audioMode === "original") {
        get().showToast("没有参考视频时不能保留原声", "error");
        return;
      }
      if (!firstFrameAsset && !referenceVideos.length && data.aspectRatio === "智能") {
        get().showToast("没有首帧或参考视频时，请选择 16:9、9:16 或 1:1", "error");
        return;
      }
    }
    if (data.model === "v3-motion-control") {
      if (referenceAudios.length) {
        get().showToast("可灵动作控制不支持参考音频", "error");
        return;
      }
      if (referenceVideos.length !== 1) {
        get().showToast("可灵动作控制必须提供 1 段动作参考视频", "error");
        return;
      }
      if (referenceImages.length !== 1) {
        get().showToast("请提供 1 张形象参考图", "error");
        return;
      }
      const motionVideo = referenceVideos[0];
      const motionDuration = motionVideo.duration != null
        ? Math.max(0, (motionVideo.trimEnd ?? motionVideo.duration) - (motionVideo.trimStart ?? 0))
        : undefined;
      const maxDuration = data.characterOrientation === "image" ? 10 : 30;
      if (motionDuration != null && (motionDuration < 3 || motionDuration > maxDuration)) {
        get().showToast(`动作参考视频时长必须在 3-${maxDuration} 秒之间`, "error");
        return;
      }
      if (prompt.length > 2500) {
        get().showToast("可灵动作控制提示词不能超过 2500 字符", "error");
        return;
      }
    }
    if (inputMode === "references" && isSeedanceModel(data.model)) {
      if (referenceImages.length > 9 || referenceVideos.length > 3 || referenceAudios.length > 3) {
        get().showToast("Seedance 参考素材数量超出模型上限", "error");
        return;
      }
      if (referenceAudios.length && !referenceImages.length && !referenceVideos.length) {
        get().showToast("参考音频不能单独使用，请同时添加参考图片或参考视频", "error");
        return;
      }
    }

    const sourcePosition = absoluteNodePosition(node, state.nodes);
    const sourceWidth = data.width || 430;
    const sourceHeight = data.height || 280;
    const existingResults = state.nodes.filter(
      (candidate) =>
        candidate.type === "videoAsset" && (candidate.data as VideoNodeData).generationSourceId === nodeId,
    );
    const nextResultY = existingResults.length
      ? Math.max(...existingResults.map((candidate) => absoluteNodePosition(candidate, state.nodes).y)) + Math.min(sourceHeight, 560) + 110
      : sourcePosition.y;
    const startedAt = Date.now();
    const resultNodeId = get().addNode("videoAsset", {
      x: sourcePosition.x + sourceWidth + 180,
      y: nextResultY,
    }, {
      label: nextGeneratedVideoLabel(data.label, state.nodes),
      url: null,
      remoteUrl: undefined,
      status: "running",
      progress: 0,
      error: undefined,
      startedAt,
      taskId: undefined,
      prompt,
      model: data.model,
      mode: data.mode,
      duration: data.duration,
      aspectRatio: data.aspectRatio,
      sound: data.sound,
      audioMode: data.audioMode ?? "off",
      negativePrompt: data.negativePrompt,
      webSearch: data.webSearch,
      cameraFixed: data.cameraFixed,
      seedText: data.seedText,
      referType: data.referType,
      keepOriginalSound: data.keepOriginalSound,
      characterOrientation: data.characterOrientation,
      elementId: undefined,
      elementReferenceId: undefined,
      callbackUrl: undefined,
      externalTaskId: undefined,
      watermarkEnabled: false,
      shotMode,
      shotModeExplicit: data.shotModeExplicit,
      shotsEnabled,
      shots: shotsEnabled ? shots : [],
      inputMode,
      sourceVideo: undefined,
      referenceAssets: [],
      keyframeAssets: [],
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

    // Keep the configuration node editable while submission and polling belong
    // exclusively to the newly-created result node.
    void (async () => {
      try {
        const resolveAssets = (assets: VideoReferenceAsset[]) => Promise.all(assets.map(async (asset) => ({
          ...asset,
          url: await ensurePublicVideoReferenceUrl(asset, data.model, data.characterOrientation),
        })));
        const [resolvedReferences, resolvedKeyframes] = data.model === "v3-omni"
          ? await Promise.all([resolveAssets(referenceAssets), resolveAssets(keyframeAssets)])
          : inputMode === "keyframes"
            ? await Promise.all([resolveAssets(upstreamImageAssets), resolveAssets(keyframeAssets)])
            : [await resolveAssets(referenceAssets), keyframeAssets];
        if (!videoResultIsRunning(resultNodeId, get)) return;
        const resolvedSource = data.sourceVideo
          ? resolvedReferences.find((asset) => asset.id === data.sourceVideo?.id)
          : undefined;
        const resolvedOwnReferences = resolvedReferences.filter((asset) => ownReferenceAssets.some((own) => own.id === asset.id));
        get().updateNode(nodeId, {
          sourceVideo: resolvedSource ?? data.sourceVideo,
          referenceAssets: data.model === "v3-omni" || inputMode === "references" ? resolvedOwnReferences : ownReferenceAssets,
          keyframeAssets: resolvedKeyframes,
        });
        const resolvedUpstreamImages = resolvedReferences.filter((asset) => upstreamImageAssets.some((upstream) => upstream.id === asset.id));
        const ownImageRefs = resolvedReferences
          .filter((asset) => asset.kind === "image" && !upstreamImageAssets.some((upstream) => upstream.id === asset.id))
          .map((asset) => asset.url);
        const connectedFirstFrame = resolvedUpstreamImages[0]?.url;
        const resolvedKeyframeSlots = resolveKeyframeSlots(
          resolvedKeyframes,
          inputMode === "keyframes" ? resolvedUpstreamImages : [],
        );
        const connectedKeyframeIdSet = new Set(resolvedKeyframeSlots.connectedFrameIds);
        const useConnectedAsFirstFrame = inputMode !== "keyframes" && Boolean(connectedFirstFrame)
          && shouldUseConnectedImageAsFirstFrame(
            data.model,
            inputMode,
            resolvedKeyframes.some((asset) => asset.role === "first_frame"),
          );
        const remainingConnectedRefs = resolvedUpstreamImages
          .filter((asset) => !connectedKeyframeIdSet.has(asset.id))
          .slice(useConnectedAsFirstFrame ? 1 : 0)
          .map((asset) => asset.url);
        const imageRefs = [...ownImageRefs, ...remainingConnectedRefs];
        const videoRefs = resolvedReferences.filter((asset) => asset.kind === "video").map((asset) => asset.url);
        const audioRefs = resolvedReferences.filter((asset) => asset.kind === "audio").map((asset) => asset.url);
        const firstFrameUrl = resolvedKeyframeSlots.firstFrame?.url
          ?? (useConnectedAsFirstFrame ? connectedFirstFrame : undefined);
        const lastFrameUrl = resolvedKeyframeSlots.lastFrame?.url;
        const res = await fetch("/api/video/jobs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: data.model,
            mode: data.mode,
            duration: data.duration,
            prompt,
            negativePrompt: data.negativePrompt ?? "",
            sound: data.sound,
            audioMode: data.audioMode ?? (data.keepOriginalSound ? "original" : data.sound ? "native" : "off"),
            webSearch: data.webSearch === true,
            cameraFixed: data.cameraFixed === true,
            seed: data.seedText?.trim() ? Number(data.seedText) : undefined,
            aspectRatio: data.aspectRatio,
            referType: data.referType ?? "feature",
            keepOriginalSound: data.keepOriginalSound === true,
            characterOrientation: data.characterOrientation ?? "video",
            elementId: undefined,
            elementReferenceId: undefined,
            callbackUrl: undefined,
            externalTaskId: undefined,
            watermarkEnabled: false,
            shotMode,
            shots: shotsEnabled ? shots : [],
            imageUrl: data.model === "v3-omni" || inputMode === "keyframes" ? firstFrameUrl : needsFrame ? firstFrameUrl ?? imageRefs[0] : undefined,
            tailUrl: data.model === "v3-omni" || inputMode === "keyframes" ? lastFrameUrl : undefined,
            refUrls: data.model === "v3-omni" || (!needsFrame && inputMode !== "keyframes") ? imageRefs : undefined,
            videoUrls: data.model === "v3-omni" || (!needsFrame && inputMode !== "keyframes") ? videoRefs : undefined,
            audioUrls: data.model === "v3-omni" || (!needsFrame && inputMode !== "keyframes") ? audioRefs : undefined,
          }),
        });
        const payload = (await res.json()) as { taskId?: string; error?: string };
        if (!res.ok || !payload.taskId) throw new Error(payload.error || "视频任务提交失败");
        if (!videoResultIsRunning(resultNodeId, get)) return;
        get().updateNode(resultNodeId, { taskId: payload.taskId });
        pollVideoNode(resultNodeId, payload.taskId, prompt, set, get);
      } catch (e) {
        if (!videoResultIsRunning(resultNodeId, get)) return;
        const message = e instanceof Error ? e.message : "视频任务提交失败";
        get().updateNode(resultNodeId, {
          status: "failed",
          error: message,
          progress: 0,
          taskId: undefined,
          startedAt: undefined,
        });
        settleGenerationEdge(resultNodeId, "failed", set, get);
        get().showToast(message, "error");
      }
    })();
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
      if (src?.type === "imageAsset" && (src.data as ImageNodeData).url) {
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
    clearNodeDeletionHistory();
    try {
      const res = await fetch("/api/boards");
      const file = (await res.json()) as WorkspaceFile | null;
      if (file && Array.isArray(file.boards) && file.boards.length) {
        const boardsData: Record<string, BoardSnapshot> = {};
        for (const b of file.boards) {
          const migrated = migrateLegacyBoard((b.nodes as AppNode[]) ?? [], (b.edges as Edge[]) ?? []);
          const rawNodes = migrated.nodes;
          const groupIds = new Set(rawNodes.filter((node) => node.type === "group").map((node) => node.id));
          const interruptedResultIds = new Set(
            rawNodes
              .filter((node) => {
                if (node.type !== "imageAsset") return false;
                const data = node.data as ImageNodeData;
                return data.isGeneratedResult && data.status === "running" && !data.jobIds?.length;
              })
              .map((node) => node.id),
          );
          const nodes = rawNodes.map((node) => {
            const layoutIndependentNode = node.parentId && groupIds.has(node.parentId)
              ? ({ ...node, extent: undefined, expandParent: undefined } as AppNode)
              : node;
            const normalizedNode = layoutIndependentNode.type === "imageGenerator"
              ? ({
                  ...layoutIndependentNode,
                  data: {
                    ...layoutIndependentNode.data,
                    width: Number(layoutIndependentNode.data.width) || 420,
                    height: Math.max(520, Number(layoutIndependentNode.data.height) || 520),
                  },
                } as AppNode)
              : layoutIndependentNode;
            if (!interruptedResultIds.has(node.id)) return normalizedNode;
            return {
              ...normalizedNode,
              data: {
                ...normalizedNode.data,
                status: "failed",
                progress: 0,
                error: "提交过程被中断，请从原节点重新生成。",
              },
            } as AppNode;
          });
          const edges = migrated.edges.map((edge) =>
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
            counters: {
              ...(b.counters ?? {}),
              imageAsset: Math.max(
                Number(b.counters?.imageAsset ?? 0),
                nodes.filter((node) => node.type === "imageAsset").length,
              ),
              imageGenerator: Math.max(
                Number(b.counters?.imageGenerator ?? 0),
                nodes.filter((node) => node.type === "imageGenerator").length,
              ),
              videoAsset: Math.max(
                Number(b.counters?.videoAsset ?? 0),
                nodes.filter((node) => node.type === "videoAsset").length,
              ),
              videoGenerator: Math.max(
                Number(b.counters?.videoGenerator ?? 0),
                nodes.filter((node) => node.type === "videoGenerator").length,
              ),
            },
          };
        }
        const activeId = file.boards.some((b) => b.id === file.activeId) ? file.activeId : file.boards[0].id;
        const active = boardsData[activeId];
        const activeBoardName = file.boards.find((board) => board.id === activeId)?.name || file.workspaceName || "画布 1";
        set({
          workspaceName: activeBoardName,
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
          if (n.type === "imageAsset") {
            const d = n.data as ImageNodeData;
            if (d.status === "running" && d.jobIds?.length) {
              pollImageNode(n.id, d.jobIds, set, get, d.submissionFailures ?? 0, d.jobLabels);
            }
          } else if (n.type === "videoAsset") {
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
      workspaceName: name,
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
    const targetName = s.boards.find((board) => board.id === id)?.name || s.workspaceName;
    set({ boardsData, activeBoardId: id, workspaceName: targetName, nodes: target.nodes, edges: target.edges, counters: target.counters });
    get().scheduleSave();
  },

  renameBoard: (id, name) => {
    const s = get();
    const current = s.boards.find((board) => board.id === id);
    if (!current) return;
    const nextName = name.trim() || current.name;
    set({
      boards: s.boards.map((board) => board.id === id ? { ...board, name: nextName } : board),
      ...(id === s.activeBoardId ? { workspaceName: nextName } : {}),
    });
    void get().saveWorkspaceNow();
  },

  deleteBoard: (id) => {
    const s = get();
    if (s.boards.length <= 1) {
      get().showToast("至少保留一个画布", "error");
      return;
    }
    const rest = s.boards.filter((b) => b.id !== id);
    clearNodeDeletionHistory(id);
    const boardsData = { ...s.boardsData };
    delete boardsData[id];
    if (id === s.activeBoardId) {
      const next = rest[0];
      const snap = boardsData[next.id] ?? { nodes: [], edges: [], counters: {} };
      set({ boards: rest, boardsData, activeBoardId: next.id, workspaceName: next.name, nodes: snap.nodes, edges: snap.edges, counters: snap.counters });
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
  return node?.type === "imageAsset" && (node.data as ImageNodeData).status === "running";
}

function videoResultIsRunning(nodeId: string, get: GetFn): boolean {
  const node = get().nodes.find((candidate) => candidate.id === nodeId);
  return node?.type === "videoAsset" && (node.data as VideoNodeData).status === "running";
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
          generationDurationMs: Math.max(0, Date.now() - startedAt),
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
        const msg = presentImageGenerationError(failed[0]?.error || "生成失败");
        patchNode(get, nodeId, {
          status: "failed",
          progress: 0,
          error: msg,
          generationDurationMs: Math.max(0, Date.now() - startedAt),
        });
        settleGenerationEdge(nodeId, "failed", set, get);
      }
      requestTokenBalanceRefresh();
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

function pollVideoNode(nodeId: string, taskId: string, prompt: string, set: SetFn, get: GetFn) {
  clearPoll(nodeId);
  const startedAt = ((get().nodes.find((n) => n.id === nodeId)?.data as VideoNodeData | undefined)?.startedAt) ?? Date.now();

  const tick = async () => {
    if (!nodeExists(get, nodeId)) return clearPoll(nodeId);
    let payload: {
      status: string;
      progress?: number;
      videoUrl?: string;
      error?: string;
      watermarkUrl?: string;
      outputDuration?: string;
      requestId?: string;
      billing?: VideoNodeData["billing"];
    };
    try {
      const currentNode = get().nodes.find((node) => node.id === nodeId);
      const currentModel = (currentNode?.data as VideoNodeData | undefined)?.model;
      const statusRes = await fetch(`/api/video/jobs/${encodeURIComponent(taskId)}?model=${encodeURIComponent(currentModel ?? "")}`);
      const statusPayload = (await statusRes.json().catch(() => ({}))) as {
        status?: string;
        progress?: number;
        videoUrl?: string;
        error?: string;
        watermarkUrl?: string;
        outputDuration?: string;
        requestId?: string;
        billing?: VideoNodeData["billing"];
      };
      if (!statusRes.ok) {
        if (statusRes.status === 429 || statusRes.status >= 500) {
          pollTimers.set(nodeId, setTimeout(tick, 6000));
          return;
        }
        payload = {
          status: "failed",
          progress: 0,
          error: statusPayload.error || `视频状态查询失败 HTTP ${statusRes.status}`,
        };
      } else {
        payload = {
          status: statusPayload.status || "running",
          progress: statusPayload.progress,
          videoUrl: statusPayload.videoUrl,
          error: statusPayload.error,
          watermarkUrl: statusPayload.watermarkUrl,
          outputDuration: statusPayload.outputDuration,
          requestId: statusPayload.requestId,
          billing: statusPayload.billing,
        };
      }
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
              model: d?.model ?? "seedance-2.0",
              mode: d?.mode ?? "720p",
              duration: d?.duration ?? 5,
              prompt,
              sound: d?.sound ?? false,
              audioMode: d?.audioMode,
              aspectRatio: d?.aspectRatio ?? "智能",
              requestId: payload.requestId,
              outputDuration: payload.outputDuration,
              billing: payload.billing,
              createdAt: Date.now(),
            },
          }),
        });
        const savePayload = (await saveRes.json()) as {
          localUrl?: string;
          error?: string;
          media?: { width?: number; height?: number; duration?: number; frameRate?: number };
        };
        const url = savePayload.localUrl ?? payload.videoUrl;
        patchNode(get, nodeId, {
          status: "success",
          progress: 100,
          url,
          remoteUrl: payload.videoUrl,
          watermarkUrl: payload.watermarkUrl,
          outputDuration: payload.outputDuration,
          requestId: payload.requestId,
          billing: payload.billing,
          mediaWidth: savePayload.media?.width,
          mediaHeight: savePayload.media?.height,
          mediaFrameRate: savePayload.media?.frameRate,
          startedAt: undefined,
        });
      } catch {
        patchNode(get, nodeId, {
          status: "success",
          progress: 100,
          url: payload.videoUrl,
          remoteUrl: payload.videoUrl,
          watermarkUrl: payload.watermarkUrl,
          outputDuration: payload.outputDuration,
          requestId: payload.requestId,
          billing: payload.billing,
          startedAt: undefined,
        });
      }
      settleGenerationEdge(nodeId, "success", set, get);
      get().showToast("视频生成完成", "success");
      requestTokenBalanceRefresh();
      return;
    }

    if (payload.status === "failed") {
      clearPoll(nodeId);
      const msg = payload.error || "视频生成失败";
      patchNode(get, nodeId, { status: "failed", progress: 0, error: msg, startedAt: undefined });
      settleGenerationEdge(nodeId, "failed", set, get);
      get().showToast(msg, "error");
      requestTokenBalanceRefresh();
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
