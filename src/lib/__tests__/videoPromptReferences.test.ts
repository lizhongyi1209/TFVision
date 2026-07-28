import assert from "node:assert/strict";
import test from "node:test";
import { activeVideoPromptMention, assignVideoPromptReferences } from "../videoPromptReferences.ts";

test("多模态素材按类型生成稳定且互不冲突的 @ 标识", () => {
  const references = assignVideoPromptReferences([
    { key: "first", kind: "image", name: "首帧", role: "first_frame" },
    { key: "style", kind: "image", name: "风格图", role: "reference" },
    { key: "motion", kind: "video", name: "运镜视频", role: "reference" },
    { key: "voice", kind: "audio", name: "参考音频", role: "reference" },
  ]);
  assert.deepEqual(references.map(({ promptId, token }) => ({ promptId, token })), [
    { promptId: "image_1", token: "@image_1" },
    { promptId: "image_2", token: "@image_2" },
    { promptId: "video_1", token: "@video_1" },
    { promptId: "audio_1", token: "@audio_1" },
  ]);
});

test("识别光标前正在输入的 @ 素材查询", () => {
  assert.deepEqual(activeVideoPromptMention("让 @image", 8), { start: 2, end: 8, query: "image" });
  assert.deepEqual(activeVideoPromptMention("参考（@运镜", 6), { start: 3, end: 6, query: "运镜" });
  assert.equal(activeVideoPromptMention("邮箱 a@b.com", 9), null);
});
