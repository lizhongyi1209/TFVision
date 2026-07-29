import type { DiagnosticCategory, DiagnosticEntry } from "./diagnostics";

const MAX_ENTRIES = 100;
const MAX_TEXT_LENGTH = 512 * 1024;
const SECRET_KEYS = new Set(["authorization", "api_key", "apikey", "access_token", "token"]);

declare global {
  // eslint-disable-next-line no-var
  var __tfvisionDiagnostics: DiagnosticEntry[] | undefined;
}

function entries() {
  if (!globalThis.__tfvisionDiagnostics) globalThis.__tfvisionDiagnostics = [];
  return globalThis.__tfvisionDiagnostics;
}

function truncate(value: string) {
  if (value.length <= MAX_TEXT_LENGTH) return { value, truncated: false };
  return {
    value: `${value.slice(0, MAX_TEXT_LENGTH)}\n\n[诊断台已截断 ${value.length - MAX_TEXT_LENGTH} 个字符]`,
    truncated: true,
  };
}

function sanitizeValue(value: unknown, key = ""): unknown {
  if (SECRET_KEYS.has(key.toLowerCase())) return "[REDACTED]";
  if (typeof value === "string") {
    const dataUrl = value.match(/^data:([^;,]+)?;base64,(.+)$/s);
    if (dataUrl) {
      const approximateBytes = Math.floor(dataUrl[2].length * 0.75);
      return `[base64 ${dataUrl[1] || "application/octet-stream"}, ~${approximateBytes} bytes]`;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [
        childKey,
        sanitizeValue(childValue, childKey),
      ]),
    );
  }
  return value;
}

export function sanitizeDiagnosticBody(body: BodyInit | null | undefined) {
  if (body == null) return { value: "", truncated: false };
  if (typeof body === "string") {
    try {
      return truncate(JSON.stringify(sanitizeValue(JSON.parse(body))));
    } catch {
      return truncate(body);
    }
  }
  if (body instanceof URLSearchParams) return truncate(body.toString());
  if (body instanceof FormData) return { value: "[multipart/form-data]", truncated: false };
  if (body instanceof Blob) return { value: `[binary Blob, ${body.size} bytes]`, truncated: false };
  if (body instanceof ArrayBuffer) return { value: `[binary ArrayBuffer, ${body.byteLength} bytes]`, truncated: false };
  if (ArrayBuffer.isView(body)) return { value: `[binary ${body.constructor.name}, ${body.byteLength} bytes]`, truncated: false };
  return { value: `[${Object.prototype.toString.call(body)}]`, truncated: false };
}

function append(entry: DiagnosticEntry) {
  const store = entries();
  store.unshift(entry);
  if (store.length > MAX_ENTRIES) store.length = MAX_ENTRIES;
}

export function getDiagnostics(): DiagnosticEntry[] {
  return entries().map((entry) => ({ ...entry }));
}

export function clearDiagnostics() {
  entries().length = 0;
}

export function diagnosticsCapacity() {
  return MAX_ENTRIES;
}

export async function diagnosticFetch(
  input: string | URL | Request,
  init: RequestInit | undefined,
  meta: { category: DiagnosticCategory; label: string },
): Promise<Response> {
  const startedAt = Date.now();
  const endpoint = input instanceof Request ? input.url : String(input);
  const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const request = sanitizeDiagnosticBody(init?.body);

  try {
    const response = await fetch(input, init);
    let raw = "";
    try {
      raw = await response.clone().text();
    } catch (error) {
      raw = `[无法读取响应体：${error instanceof Error ? error.message : String(error)}]`;
    }
    const responseBody = truncate(raw);
    append({
      id: crypto.randomUUID(),
      category: meta.category,
      label: meta.label,
      method,
      endpoint,
      requestBody: request.value,
      responseStatus: response.status,
      responseStatusText: response.statusText,
      responseBody: responseBody.value,
      startedAt,
      durationMs: Date.now() - startedAt,
      ok: response.ok,
      requestTruncated: request.truncated || undefined,
      responseTruncated: responseBody.truncated || undefined,
    });
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    append({
      id: crypto.randomUUID(),
      category: meta.category,
      label: meta.label,
      method,
      endpoint,
      requestBody: request.value,
      responseStatus: null,
      responseStatusText: "",
      responseBody: "",
      startedAt,
      durationMs: Date.now() - startedAt,
      ok: false,
      error: message,
      requestTruncated: request.truncated || undefined,
    });
    throw error;
  }
}
