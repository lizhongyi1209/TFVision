import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeDiagnosticBody } from "../diagnostics.server.ts";

test("诊断请求体隐藏密钥与大段 base64，但保留真实业务字段", () => {
  const sanitized = sanitizeDiagnosticBody(JSON.stringify({
    apiKey: "sk-secret",
    prompt: "让 @image_1 跟随 @video_1 运动",
    images: ["data:image/png;base64,QUJDRA=="],
  }));
  const parsed = JSON.parse(sanitized.value) as Record<string, unknown>;

  assert.equal(parsed.apiKey, "[REDACTED]");
  assert.equal(parsed.prompt, "让 @image_1 跟随 @video_1 运动");
  assert.match(String((parsed.images as string[])[0]), /^\[base64 image\/png, ~/);
  assert.equal(sanitized.truncated, false);
});

test("诊断请求体标记二进制内容而不复制媒体数据", () => {
  const bytes = new Uint8Array(256);
  assert.deepEqual(sanitizeDiagnosticBody(bytes), {
    value: "[binary Uint8Array, 256 bytes]",
    truncated: false,
  });
});
