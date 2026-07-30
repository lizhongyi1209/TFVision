export type DiagnosticCategory = "image" | "video" | "upload" | "agent" | "vision" | "settings";

export type DiagnosticEntry = {
  id: string;
  category: DiagnosticCategory;
  label: string;
  method: string;
  endpoint: string;
  requestHeaders: string;
  requestBody: string;
  responseStatus: number | null;
  responseStatusText: string;
  responseHeaders: string;
  responseBody: string;
  startedAt: number;
  durationMs: number;
  ok: boolean;
  error?: string;
  errorDetails?: string;
  requestHeadersTruncated?: boolean;
  requestTruncated?: boolean;
  responseHeadersTruncated?: boolean;
  responseTruncated?: boolean;
};

export type DiagnosticSnapshot = {
  entries: DiagnosticEntry[];
  maxEntries: number;
};

export function diagnosticStatusCode(entry: Pick<DiagnosticEntry, "responseStatus">): string {
  return entry.responseStatus === null ? "ERR" : String(entry.responseStatus);
}

export function diagnosticRawError(
  entry: Pick<DiagnosticEntry, "responseStatus" | "responseStatusText" | "responseBody" | "error" | "errorDetails">,
): string {
  const statusLine = entry.responseStatus === null
    ? "NETWORK_ERROR"
    : `HTTP ${entry.responseStatus}${entry.responseStatusText ? ` ${entry.responseStatusText}` : ""}`;
  const details = entry.errorDetails || entry.error || "";
  return [statusLine, details, entry.responseBody].filter(Boolean).join("\n\n");
}
