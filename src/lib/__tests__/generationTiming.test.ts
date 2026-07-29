import assert from "node:assert/strict";
import { test } from "node:test";
import { formatGenerationDuration } from "../generationTiming.ts";

test("生图耗时按分秒与小时格式展示", () => {
  assert.equal(formatGenerationDuration(0), "00:00");
  assert.equal(formatGenerationDuration(12_900), "00:12");
  assert.equal(formatGenerationDuration(65_000), "01:05");
  assert.equal(formatGenerationDuration(3_661_000), "1:01:01");
});

test("生图耗时会安全处理负数和非有限值", () => {
  assert.equal(formatGenerationDuration(-1_000), "00:00");
  assert.equal(formatGenerationDuration(Number.NaN), "00:00");
});
