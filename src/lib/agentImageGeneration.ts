import type { AgentImagePlan, JobStatusResponse, ModelName } from "./types";

export type AgentImageJob = { id: string; index: number };

export type AgentImagePollResult = {
  images: string[];
  errors: string[];
};

const OVERLOAD_PATTERN =
  /(?:\b429\b|\b503\b|\b529\b|overload|overloaded|capacity|resource\s*exhausted|rate\s*limit|too\s*many\s*requests|temporarily\s*unavailable|模型.{0,4}(?:过载|繁忙)|服务.{0,4}(?:繁忙|拥堵)|请求过于频繁|请求受限)/i;
const HARD_STOP_PATTERN =
  /(?:unauthorized|forbidden|invalid\s*(?:api\s*)?key|insufficient|balance|quota|billing|payment|content\s*policy|safety|moderation|鉴权|令牌|密钥|余额|额度|配额|欠费|内容安全|违规|审核)/i;
const TRANSIENT_POLL_PATTERN = /(?:网络|连接|查询任务失败|timeout|timed out|fetch failed|socket|ECONNRESET)/i;
const SYSTEM_CPU_OVERLOAD_PATTERN = /(?:\b503\b|system_cpu_overloaded)/i;

export function sanitizeImageError(value: unknown) {
  const raw = value instanceof Error ? value.message : String(value || "图片生成失败");
  return raw
    .replace(/sk-[a-z0-9_-]+/gi, "<REDACTED>")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer <REDACTED>")
    .trim()
    .slice(0, 600);
}

export function presentImageGenerationError(value: unknown) {
  const sanitized = sanitizeImageError(value);
  return SYSTEM_CPU_OVERLOAD_PATTERN.test(sanitized)
    ? "服务器CPU过载，请稍后重试！"
    : sanitized;
}

export function isImageOverloadError(error: unknown) {
  return OVERLOAD_PATTERN.test(sanitizeImageError(error));
}

export function isHardImageError(error: unknown) {
  return HARD_STOP_PATTERN.test(sanitizeImageError(error));
}

export function overloadRetryDelay(attempt: number) {
  return [2_000, 5_000, 10_000][Math.max(0, Math.min(2, attempt - 1))];
}

export function waitForImageRetry(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = window.setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

export async function submitAgentImageJobs(
  plan: AgentImagePlan,
  model: ModelName,
  images: string[],
  signal?: AbortSignal,
) {
  const response = await fetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: plan.prompt,
      model,
      resolution: plan.resolution,
      aspectRatio: plan.aspectRatio,
      count: plan.count,
      images,
    }),
    signal,
  });
  const payload = (await response.json().catch(() => ({}))) as { jobs?: AgentImageJob[]; error?: string };
  if (!response.ok || !payload.jobs?.length) {
    throw new Error(payload.error || `图片任务提交失败（HTTP ${response.status}）`);
  }
  return payload.jobs;
}

export async function pollAgentImageJobs(
  jobs: AgentImageJob[],
  onProgress: (completed: number, total: number, progress: number | null) => void,
  signal?: AbortSignal,
): Promise<AgentImagePollResult> {
  const pending = new Map(jobs.map((job) => [job.id, job]));
  const imagesByIndex = new Map<number, string[]>();
  const errors: string[] = [];
  let transientPollErrors = 0;
  const deadline = Date.now() + 10 * 60_000;

  while (pending.size) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (Date.now() > deadline) throw new Error("图片生成等待超时，请稍后从历史资产中查看结果");

    let statuses: Array<{ job: AgentImageJob; status: JobStatusResponse }>;
    try {
      statuses = await Promise.all(
        [...pending.values()].map(async (job) => {
          const response = await fetch(`/api/jobs/${encodeURIComponent(job.id)}`, { signal });
          if (!response.ok) throw new Error(`查询图片任务失败（HTTP ${response.status}）`);
          return { job, status: (await response.json()) as JobStatusResponse };
        }),
      );
      transientPollErrors = 0;
    } catch (error) {
      if ((error as Error)?.name === "AbortError") throw error;
      transientPollErrors += 1;
      if (transientPollErrors > 6) throw error;
      await waitForImageRetry(Math.min(8_000, 1_500 * transientPollErrors), signal);
      continue;
    }

    const runningProgress: number[] = [];
    for (const { job, status } of statuses) {
      if (status.status === "success") {
        imagesByIndex.set(job.index, status.images);
        pending.delete(job.id);
      } else if (status.status === "failed") {
        const message = sanitizeImageError(status.error);
        if (TRANSIENT_POLL_PATTERN.test(message) && transientPollErrors < 6) {
          transientPollErrors += 1;
          continue;
        }
        errors.push(message);
        pending.delete(job.id);
      } else if (typeof status.progress === "number") {
        runningProgress.push(status.progress);
      }
    }

    const completed = jobs.length - pending.size;
    const progress = runningProgress.length
      ? runningProgress.reduce((total, value) => total + value, 0) / runningProgress.length
      : null;
    onProgress(completed, jobs.length, progress);
    if (pending.size) await waitForImageRetry(2_600, signal);
  }

  return {
    images: [...imagesByIndex.entries()]
      .sort(([left], [right]) => left - right)
      .flatMap(([, values]) => values),
    errors,
  };
}
