export type DiagnosticCategory = "image" | "video" | "upload" | "agent" | "vision" | "settings";

export type DiagnosticEntry = {
  id: string;
  category: DiagnosticCategory;
  label: string;
  method: string;
  endpoint: string;
  requestBody: string;
  responseStatus: number | null;
  responseStatusText: string;
  responseBody: string;
  startedAt: number;
  durationMs: number;
  ok: boolean;
  error?: string;
  requestTruncated?: boolean;
  responseTruncated?: boolean;
};

export type DiagnosticSnapshot = {
  entries: DiagnosticEntry[];
  maxEntries: number;
};
