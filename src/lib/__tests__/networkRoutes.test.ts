import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_ROUTE,
  isRouteName,
  normalizeRouteName,
  resolveBaseUrl,
} from "../networkRoutes.ts";

test("网络线路使用中文名称映射真实地址", () => {
  assert.equal(DEFAULT_ROUTE, "国内加速");
  assert.equal(resolveBaseUrl("国内加速"), "https://api.o1key.cn");
  assert.equal(resolveBaseUrl("国外加速"), "https://cf-api.o1key.com");
});

test("旧线路和值异常时自动迁移为国内加速", () => {
  assert.equal(isRouteName("国内加速"), true);
  assert.equal(isRouteName("国外加速"), true);
  assert.equal(isRouteName("全球加速"), false);
  assert.equal(normalizeRouteName("全球加速"), "国内加速");
  assert.equal(normalizeRouteName(undefined), "国内加速");
});
