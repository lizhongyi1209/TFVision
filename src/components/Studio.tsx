"use client";

// TFvision Studio — infinite canvas (React Flow) + node workflow.
// Interaction model follows libTV: dark dotted canvas, double-click to open
// the add-node menu, ⊕ ports on node flanks, bottom dock, top workspace bar.

import { useCallback, useEffect, useState } from "react";
import {
  Background,
  BackgroundVariant,
  NodeToolbar,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type EdgeMouseHandler,
  type OnConnectEnd,
} from "@xyflow/react";
import { useStudio, type AppNode } from "@/lib/store";
import { ImageNode } from "./nodes/ImageNode";
import { TextNode } from "./nodes/TextNode";
import { VideoNode } from "./nodes/VideoNode";
import { GroupNode } from "./nodes/GroupNode";
import { AddNodeMenu } from "./AddNodeMenu";
import { TopBar } from "./TopBar";
import { Dock } from "./Dock";
import { TemplateBar } from "./TemplateBar";
import { SettingsPanel } from "./SettingsPanel";
import { HistoryPanel } from "./HistoryPanel";
import { Toaster } from "./Toaster";
import { AgentPanel } from "./AgentPanel";
import { DiagnosticConsole } from "./DiagnosticConsole";
import { Icon } from "./icons";
import { fileToDataURL, fitMediaNodeSize } from "@/lib/utils";
import { rememberVideoReferenceBlob } from "@/lib/videoReferenceStorage";
import { inspectVideoFile } from "@/lib/mediaMetadata";
import type { VideoNodeData } from "@/lib/types";

const NODE_TYPES = {
  text: TextNode,
  imageAsset: ImageNode,
  imageGenerator: ImageNode,
  videoAsset: VideoNode,
  videoGenerator: VideoNode,
  // Legacy aliases only exist until loadWorkspace migrates persisted boards.
  image: ImageNode,
  video: VideoNode,
  group: GroupNode,
};

const isImageFile = (file: File) =>
  file.type.startsWith("image/") || /\.(?:png|jpe?g|webp|gif|avif)$/i.test(file.name);

const isVideoFile = (file: File) =>
  file.type.startsWith("video/") || /\.(?:mp4|mov|m4v|webm)$/i.test(file.name);

function GroupSelectionToolbar() {
  const nodes = useStudio((state) => state.nodes);
  const createGroup = useStudio((state) => state.createGroup);
  const selectedNodeIds = nodes
    .filter((node) => node.selected && node.type !== "group" && !node.parentId)
    .map((node) => node.id);

  if (selectedNodeIds.length < 2) return null;

  return (
    <NodeToolbar
      nodeId={selectedNodeIds}
      isVisible
      position={Position.Top}
      offset={18}
      className="nodrag flex h-10 items-center gap-2 rounded-control border border-line bg-panel/95 px-2.5 shadow-[0_14px_38px_rgba(0,0,0,0.42)] backdrop-blur-xl"
    >
      <span className="text-[11px] tabular-nums text-fg-mute">已选 {selectedNodeIds.length} 个节点</span>
      <span className="h-5 w-px bg-line" />
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          createGroup(selectedNodeIds);
        }}
        className="flex h-7 items-center gap-1.5 rounded-md bg-white/10 px-2.5 text-[12px] font-medium text-fg transition-colors hover:bg-white/15"
      >
        <Icon name="Stack" size={14} />
        建组
      </button>
    </NodeToolbar>
  );
}

function Canvas() {
  const [agentOpen, setAgentOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const nodes = useStudio((s) => s.nodes);
  const edges = useStudio((s) => s.edges);
  const onNodesChange = useStudio((s) => s.onNodesChange);
  const onEdgesChange = useStudio((s) => s.onEdgesChange);
  const onConnect = useStudio((s) => s.onConnect);
  const openMenu = useStudio((s) => s.openMenu);
  const closeMenu = useStudio((s) => s.closeMenu);
  const removeEdge = useStudio((s) => s.removeEdge);
  const addNode = useStudio((s) => s.addNode);
  const copySelectedNodes = useStudio((s) => s.copySelectedNodes);
  const pasteCopiedNodes = useStudio((s) => s.pasteCopiedNodes);
  const undoDelete = useStudio((s) => s.undoDelete);
  const loadWorkspace = useStudio((s) => s.loadWorkspace);
  const fetchSettings = useStudio((s) => s.fetchSettings);
  const saveWorkspaceNow = useStudio((s) => s.saveWorkspaceNow);
  const tool = useStudio((s) => s.tool);
  const setTool = useStudio((s) => s.setTool);
  const rf = useReactFlow();

  useEffect(() => {
    void fetchSettings();
    void loadWorkspace();
  }, [fetchSettings, loadWorkspace]);

  // V = 移动工具，H = 抓手；Ctrl/Cmd+C、Ctrl/Cmd+V 复制粘贴，Ctrl/Cmd+Z 撤销删除。
  // 输入框聚焦时保留原生文本编辑快捷键。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return;
      const key = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && !e.altKey && key === "c") {
        if (!useStudio.getState().nodes.some((node) => node.selected)) return;
        e.preventDefault();
        copySelectedNodes();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && key === "v") {
        e.preventDefault();
        void pasteCopiedNodes();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && key === "z") {
        e.preventDefault();
        undoDelete();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "v" || e.key === "V") setTool("move");
      if (e.key === "h" || e.key === "H") setTool("hand");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [copySelectedNodes, pasteCopiedNodes, setTool, undoDelete]);

  // Flush pending save when leaving.
  useEffect(() => {
    const onUnload = () => void saveWorkspaceNow();
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [saveWorkspaceNow]);

  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      // Only trigger on the pane itself, not inside nodes.
      const target = e.target as HTMLElement;
      if (!target.classList.contains("react-flow__pane")) return;
      // Prevent the browser's native double-click selection from carrying over
      // to the menu that is mounted under the pointer after this event.
      e.preventDefault();
      window.getSelection()?.removeAllRanges();
      const flowPosition = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      openMenu({ flowPosition, screen: { x: e.clientX, y: e.clientY } });
      requestAnimationFrame(() => window.getSelection()?.removeAllRanges());
    },
    [rf, openMenu],
  );

  const onEdgeDoubleClick: EdgeMouseHandler = useCallback(
    (e, edge) => {
      e.stopPropagation();
      removeEdge(edge.id);
    },
    [removeEdge],
  );

  const onConnectEnd: OnConnectEnd = useCallback(
    (event, connectionState) => {
      // A handle was reached (valid or invalid): let React Flow own that
      // interaction and only open the menu for a genuine empty-canvas drop.
      if (!connectionState.fromNode || !connectionState.fromHandle || connectionState.toNode) return;

      const point = "changedTouches" in event ? event.changedTouches[0] : event;
      if (!point) return;
      const dropTarget = document.elementFromPoint(point.clientX, point.clientY) as HTMLElement | null;
      if (!dropTarget?.closest(".react-flow") || dropTarget.closest(".react-flow__node")) return;

      const screen = { x: point.clientX, y: point.clientY };
      const flowPosition = rf.screenToFlowPosition(screen);
      const nodeId = connectionState.fromNode.id;
      openMenu({
        flowPosition,
        screen,
        sourceNodeId: connectionState.fromHandle.type === "source" ? nodeId : undefined,
        targetNodeId: connectionState.fromHandle.type === "target" ? nodeId : undefined,
      });
    },
    [rf, openMenu],
  );

  // Drop an image/video file on the empty canvas -> a playable media node.
  // Drops over an existing video node remain multimodal reference inputs.
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      const file = Array.from(e.dataTransfer?.files ?? []).find((candidate) => isImageFile(candidate) || isVideoFile(candidate));
      if (!file) return;
      const target = e.target as HTMLElement;
      // Node-level drops remain multimodal reference inputs. Any other point
      // inside React Flow is treated as empty canvas (pane/background/viewport).
      if (target.closest(".react-flow__node") || !target.closest(".react-flow")) return;
      e.preventDefault();
      const flowPosition = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      if (isImageFile(file)) {
        void fileToDataURL(file).then((url) => {
          addNode("imageAsset", flowPosition, { url, urls: [url] });
        });
        return;
      }
      const assetId = `canvas-video-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const localUrl = URL.createObjectURL(file);
      void rememberVideoReferenceBlob(assetId, file).catch(() => {
        useStudio.getState().showToast(`${file.name} 本地保存失败，刷新页面后需要重新拖入`, "error");
      });
      const nodeId = addNode("videoAsset", flowPosition, {
        label: file.name.replace(/\.[^.]+$/, "") || "导入视频",
        model: "v3-omni",
        aspectRatio: "智能",
        inputMode: "references",
        referType: "feature",
        shotMode: "auto",
        shotsEnabled: false,
        audioMode: "off",
        sound: false,
        keepOriginalSound: false,
        sourceVideo: {
          id: assetId,
          kind: "video",
          name: file.name,
          localKey: assetId,
          localUrl,
          mimeType: file.type,
          sizeBytes: file.size,
        },
      });
      void inspectVideoFile(file).then((metadata) => {
        const current = useStudio.getState().nodes.find((node) => node.id === nodeId)?.data as VideoNodeData | undefined;
        if (!current) return;
        useStudio.getState().updateNode(nodeId, {
          mediaWidth: metadata.width,
          mediaHeight: metadata.height,
          mediaFrameRate: metadata.frameRate,
          ...(metadata.width && metadata.height
            ? { ...fitMediaNodeSize(metadata.width, metadata.height, 520), mediaLayoutFitted: true }
            : {}),
          sourceVideo: {
            ...current.sourceVideo,
            width: metadata.width,
            height: metadata.height,
            duration: metadata.duration,
            frameRate: metadata.frameRate,
          },
        });
      }).catch(() => undefined);
      useStudio.getState().showToast(`已导入并作为 Omni 参考视频：${file.name}`, "success");
    },
    [rf, addNode],
  );

  return (
    <div className="relative flex h-screen w-screen overflow-hidden bg-ink">
      <main
        className={`relative min-w-0 flex-1 ${tool === "hand" ? "tf-tool-hand" : "tf-tool-move"}`}
        onDrop={onDrop}
        onDragOver={(e) => e.preventDefault()}
      >
        <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        onDoubleClick={onDoubleClick}
        onEdgeDoubleClick={onEdgeDoubleClick}
        onPaneClick={closeMenu}
        onMoveStart={closeMenu}
        proOptions={{ hideAttribution: true }}
        minZoom={0.15}
        maxZoom={2.5}
        fitView={false}
        zoomOnDoubleClick={false}
        zoomOnScroll
        panOnScroll={false}
        selectionKeyCode={["Shift", "Control", "Meta"]}
        multiSelectionKeyCode={["Control", "Meta"]}
        selectionOnDrag={tool === "move"}
        panOnDrag={tool === "hand" ? true : [1, 2]}
        deleteKeyCode={["Delete", "Backspace"]}
        defaultViewport={{ x: 0, y: 0, zoom: 0.87 }}
      >
        <Background variant={BackgroundVariant.Dots} gap={26} size={1.5} color="rgba(255,255,255,0.28)" />
        <GroupSelectionToolbar />
        </ReactFlow>

        <TemplateBar />
        <TopBar
          agentOpen={agentOpen}
          onAgentToggle={() => setAgentOpen((current) => !current)}
          onDiagnosticsOpen={() => setDiagnosticsOpen(true)}
        />
        <Dock />
        <AddNodeMenu />
        <HistoryPanel />
        <SettingsPanel />
        <Toaster />
      </main>
      <AgentPanel open={agentOpen} onClose={() => setAgentOpen(false)} />
      <DiagnosticConsole open={diagnosticsOpen} onClose={() => setDiagnosticsOpen(false)} />
    </div>
  );
}

export default function Studio() {
  return (
    <ReactFlowProvider>
      <Canvas />
    </ReactFlowProvider>
  );
}
