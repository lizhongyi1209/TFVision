import test from "node:test";
import assert from "node:assert/strict";
import { captureNodeDeletion, restoreNodeDeletion } from "../nodeDeletionUndo.ts";

type TestNode = {
  id: string;
  type: string;
  parentId?: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
};

type TestEdge = {
  id: string;
  source: string;
  target: string;
  animated?: boolean;
};

test("恢复被删节点时保留完整参数、状态和关联连线", () => {
  const nodes: TestNode[] = [
    { id: "source", type: "imageAsset", data: { url: "data:image/png;base64,abc" }, position: { x: 10, y: 20 } },
    {
      id: "result",
      type: "videoAsset",
      data: { model: "v3-omni", status: "running", progress: 47, taskId: "task_public", prompt: "原提示词" },
      position: { x: 300, y: 40 },
    },
  ];
  const edges: TestEdge[] = [{ id: "edge-1", source: "source", target: "result", animated: true }];
  const snapshot = captureNodeDeletion(nodes, edges, ["result"]);
  assert.ok(snapshot);

  const laterSource = { ...nodes[0], data: { url: "later-edit" } };
  const restored = restoreNodeDeletion([laterSource], [], snapshot);

  assert.deepEqual(restored.nodes.find((node) => node.id === "result"), nodes[1]);
  assert.deepEqual(restored.nodes.find((node) => node.id === "source"), laterSource);
  assert.deepEqual(restored.edges, edges);
});

test("恢复分组时同时恢复子节点的父级和相对位置", () => {
  const nodes: TestNode[] = [
    { id: "group", type: "group", position: { x: 100, y: 100 }, data: { label: "分组 1" } },
    { id: "child", type: "text", parentId: "group", position: { x: 20, y: 30 }, data: { text: "保留内容" } },
    { id: "other", type: "text", position: { x: 500, y: 500 }, data: { text: "不受影响" } },
  ];
  const snapshot = captureNodeDeletion(nodes, [], ["group"]);
  assert.ok(snapshot);

  const ungroupedChild = { ...nodes[1], parentId: undefined, position: { x: 120, y: 130 } };
  const restored = restoreNodeDeletion([ungroupedChild, nodes[2]], [], snapshot);

  assert.deepEqual(restored.nodes, nodes);
});
