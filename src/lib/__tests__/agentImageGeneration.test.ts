import assert from "node:assert/strict";
import { test } from "node:test";
import { presentImageGenerationError } from "../agentImageGeneration.ts";

test("图片生成 503 和 system_cpu_overloaded 显示为 CPU 过载提示", () => {
  assert.equal(
    presentImageGenerationError("上游请求失败 HTTP 503"),
    "服务器CPU过载，请稍后重试！",
  );
  assert.equal(
    presentImageGenerationError('{"code":"system_cpu_overloaded","message":"busy"}'),
    "服务器CPU过载，请稍后重试！",
  );
});

test("图片生成的其他错误保留脱敏后的原始提示", () => {
  assert.equal(presentImageGenerationError("内容审核未通过"), "内容审核未通过");
});
