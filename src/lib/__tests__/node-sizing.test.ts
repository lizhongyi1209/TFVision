import assert from "node:assert/strict";
import test from "node:test";
import { createMediaNodeSizing, fitMediaNodeSize } from "../utils.ts";

test("媒体节点按原始比例拟合最长边", () => {
  assert.deepEqual(fitMediaNodeSize(720, 1280, 520), { width: 293, height: 520 });
  assert.deepEqual(fitMediaNodeSize(1920, 1080, 520), { width: 520, height: 293 });
});

test("图片和视频共享等比缩放约束", () => {
  const sizing = createMediaNodeSizing(720, 1280, 520);
  assert.ok(sizing);
  assert.deepEqual(sizing.initialSize, { width: 293, height: 520 });
  assert.deepEqual(sizing.resizePolicy, {
    mode: "preserve-aspect",
    aspectRatio: 720 / 1280,
    minWidth: 293,
    minHeight: 520,
    maxWidth: 1200,
    maxHeight: 1200,
  });
});
