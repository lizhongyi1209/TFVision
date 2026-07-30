import assert from "node:assert/strict";
import { test } from "node:test";
import { formatGenerationDuration, formatGenerationElapsedSeconds } from "../generationTiming.ts";

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

test("生成中的秒数使用无前缀递增数字", () => {
  assert.equal(formatGenerationElapsedSeconds(0), "0");
  assert.equal(formatGenerationElapsedSeconds(1_999), "1");
  assert.equal(formatGenerationElapsedSeconds(65_000), "65");
  assert.equal(formatGenerationElapsedSeconds(-1_000), "0");
  assert.equal(formatGenerationElapsedSeconds(Number.NaN), "0");
});
