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
import { Icon } from "./icons";
import { fileToDataURL } from "@/lib/utils";
import { rememberVideoReferenceBlob } from "@/lib/videoReferenceStorage";

const NODE_TYPES = { text: TextNode, image: ImageNode, video: VideoNode, group: GroupNode };

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
  const nodes = useStudio((s) => s.nodes);
  const edges = useStudio((s) => s.edges);
  const onNodesChange = useStudio((s) => s.onNodesChange);
  const onEdgesChange = useStudio((s) => s.onEdgesChange);
  const onConnect = useStudio((s) => s.onConnect);
  const openMenu = useStudio((s) => s.openMenu);
  const closeMenu = useStudio((s) => s.closeMenu);
  const removeEdge = useStudio((s) => s.removeEdge);
  const addNode = useStudio((s) => s.addNode);
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

  // V = 移动工具，H = 抓手（对齐 libTV）。输入框聚焦时不抢按键。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable) return;
      if (e.key === "v" || e.key === "V") setTool("move");
      if (e.key === "h" || e.key === "H") setTool("hand");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setTool]);

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
      const flowPosition = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      openMenu({ flowPosition, screen: { x: e.clientX, y: e.clientY } });
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

  // Drop an image/video file on the empty canvas -> a playable media node.
  // Drops over an existing video node remain multimodal reference inputs.
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      const file = e.dataTransfer?.files?.[0];
      if (!file || (!file.type.startsWith("image/") && !file.type.startsWith("video/"))) return;
      const target = e.target as HTMLElement;
      if (!target.classList.contains("react-flow__pane")) return; // node-level drops handled by the node
      e.preventDefault();
      const flowPosition = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      if (file.type.startsWith("image/")) {
        void fileToDataURL(file).then((url) => {
          addNode("image", flowPosition, { url, urls: [url] });
        });
        return;
      }
      const assetId = `canvas-video-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const localUrl = URL.createObjectURL(file);
      void rememberVideoReferenceBlob(assetId, file);
      addNode("video", flowPosition, {
        label: file.name.replace(/\.[^.]+$/, "") || "导入视频",
        sourceVideo: {
          id: assetId,
          kind: "video",
          name: file.name,
          localKey: assetId,
          localUrl,
        },
      });
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
        <TopBar agentOpen={agentOpen} onAgentToggle={() => setAgentOpen((current) => !current)} />
        <Dock />
        <AddNodeMenu />
        <HistoryPanel />
        <SettingsPanel />
        <Toaster />
      </main>
      <AgentPanel open={agentOpen} onClose={() => setAgentOpen(false)} />
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
