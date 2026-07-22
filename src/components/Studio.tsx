"use client";

// TFvision Studio — infinite canvas (React Flow) + node workflow.
// Interaction model follows libTV: dark dotted canvas, double-click to open
// the add-node menu, ⊕ ports on node flanks, bottom dock, top workspace bar.

import { useCallback, useEffect } from "react";
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type EdgeMouseHandler,
} from "@xyflow/react";
import { useStudio, type AppNode } from "@/lib/store";
import { ImageNode } from "./nodes/ImageNode";
import { TextNode } from "./nodes/TextNode";
import { VideoNode } from "./nodes/VideoNode";
import { AddNodeMenu } from "./AddNodeMenu";
import { TopBar } from "./TopBar";
import { Dock } from "./Dock";
import { TemplateBar } from "./TemplateBar";
import { SettingsPanel } from "./SettingsPanel";
import { HistoryPanel } from "./HistoryPanel";
import { Toaster } from "./Toaster";
import { fileToDataURL } from "@/lib/utils";

const NODE_TYPES = { text: TextNode, image: ImageNode, video: VideoNode };

function Canvas() {
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

  // Drop an image file anywhere on the canvas -> new image node there.
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      const file = e.dataTransfer?.files?.[0];
      if (!file || !file.type.startsWith("image/")) return;
      const target = e.target as HTMLElement;
      if (!target.classList.contains("react-flow__pane")) return; // node-level drops handled by the node
      e.preventDefault();
      const flowPosition = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      void fileToDataURL(file).then((url) => {
        addNode("image", flowPosition, { url, urls: [url] });
      });
    },
    [rf, addNode],
  );

  return (
    <div
      className={`h-screen w-screen ${tool === "hand" ? "tf-tool-hand" : "tf-tool-move"}`}
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
        panOnScroll
        selectionOnDrag={tool === "move"}
        panOnDrag={tool === "hand" ? true : [1, 2]}
        nodesDraggable={tool === "move"}
        deleteKeyCode={["Delete", "Backspace"]}
        defaultViewport={{ x: 0, y: 0, zoom: 0.87 }}
        nodeDragThreshold={2}
      >
        <Background variant={BackgroundVariant.Dots} gap={26} size={1.5} color="rgba(255,255,255,0.17)" />
      </ReactFlow>

      <TemplateBar />
      <TopBar />
      <Dock />
      <AddNodeMenu />
      <HistoryPanel />
      <SettingsPanel />
      <Toaster />
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
