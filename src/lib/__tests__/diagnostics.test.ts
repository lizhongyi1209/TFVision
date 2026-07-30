import assert from "node:assert/strict";
import { test } from "node:test";
import { diagnosticRawError, diagnosticStatusCode, type DiagnosticEntry } from "../diagnostics.ts";
import { sanitizeDiagnosticBody, sanitizeDiagnosticHeaders } from "../diagnostics.server.ts";

function diagnosticEntry(patch: Partial<DiagnosticEntry> = {}): DiagnosticEntry {
  return {
    id: "entry-1",
    category: "upload",
    label: "上传素材",
    method: "POST",
    endpoint: "https://example.com/upload",
    requestHeaders: "",
    requestBody: "",
    responseStatus: 200,
    responseStatusText: "OK",
    responseHeaders: "",
    responseBody: "",
    startedAt: 0,
    durationMs: 1,
    ok: true,
    ...patch,
  };
}

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

test("诊断 HTTP 头隐藏鉴权信息并保留排障字段", () => {
  const sanitized = sanitizeDiagnosticHeaders({
    Authorization: "Bearer sk-secret",
    Cookie: "session=secret",
    "Content-Type": "application/json",
    "X-Request-Id": "request-123",
    "X-RateLimit-Remaining-Tokens": "42",
  });
  const parsed = JSON.parse(sanitized.value) as Record<string, string>;

  assert.equal(parsed.authorization, "[REDACTED]");
  assert.equal(parsed.cookie, "[REDACTED]");
  assert.equal(parsed["content-type"], "application/json");
  assert.equal(parsed["x-request-id"], "request-123");
  assert.equal(parsed["x-ratelimit-remaining-tokens"], "42");
  assert.equal(sanitized.truncated, false);
});

test("列表状态只显示紧凑错误码", () => {
  assert.equal(diagnosticStatusCode(diagnosticEntry({ responseStatus: 522, responseStatusText: "Connection Timeout with Origin Server", ok: false })), "522");
  assert.equal(diagnosticStatusCode(diagnosticEntry({ responseStatus: null, ok: false })), "ERR");
});

test("右侧原始错误完整组合状态、底层异常和响应正文", () => {
  const value = diagnosticRawError(diagnosticEntry({
    responseStatus: 502,
    responseStatusText: "Bad Gateway",
    responseBody: "upstream response",
    error: "fetch failed",
    errorDetails: "TypeError: fetch failed\nCause: ETIMEDOUT",
    ok: false,
  }));

  assert.equal(value, "HTTP 502 Bad Gateway\n\nTypeError: fetch failed\nCause: ETIMEDOUT\n\nupstream response");
});
