import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { diagnosticFetch } from "@/lib/diagnostics.server";
import { resolveBaseUrl } from "@/lib/o1key";
import { readSettings } from "@/lib/settings";
import { formatTokenBalance, parseTokenBalance } from "@/lib/tokenBalance";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FRESH_MS = 60_000;
const STALE_MS = 10 * 60_000;
const CACHE_PATH = path.join(process.cwd(), "data", "token-balance-cache.json");
type BalancePayload = ReturnType<typeof balancePayload>;
const balanceCache = new Map<string, { payload: BalancePayload; fetchedAt: number }>();
const balanceRequests = new Map<string, Promise<BalancePayload>>();

function tokenFingerprint(apiKey: string) {
  return createHash("sha256").update(apiKey).digest("hex");
}

async function readPersistentCache(apiKey: string) {
  try {
    const parsed = JSON.parse(await fs.readFile(CACHE_PATH, "utf8")) as {
      fingerprint?: string;
      payload?: BalancePayload;
      fetchedAt?: number;
    };
    if (
      parsed.fingerprint !== tokenFingerprint(apiKey)
      || !parsed.payload?.ok
      || typeof parsed.fetchedAt !== "number"
    ) return null;
    return { payload: parsed.payload, fetchedAt: parsed.fetchedAt };
  } catch {
    return null;
  }
}

async function writePersistentCache(apiKey: string, cached: { payload: BalancePayload; fetchedAt: number }) {
  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fs.writeFile(CACHE_PATH, JSON.stringify({
    fingerprint: tokenFingerprint(apiKey),
    ...cached,
  }), "utf8");
}

function balancePayload(info: NonNullable<ReturnType<typeof parseTokenBalance>>) {
  return {
    ok: true as const,
    ...info,
    display: info.unlimited ? "无限额度" : formatTokenBalance(info.balance ?? 0),
  };
}

async function queryBalance(url: string, apiKey: string): Promise<BalancePayload> {
  const response = await diagnosticFetch(
    url,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    },
    { category: "settings", label: "查询令牌余额" },
  );
  const text = await response.text().catch(() => "");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  let upstreamPayload: unknown;
  try {
    upstreamPayload = JSON.parse(text);
  } catch {
    throw new Error("接口返回了非 JSON 内容");
  }
  const info = parseTokenBalance(upstreamPayload);
  if (!info) throw new Error("接口未返回可识别的额度字段");
  return balancePayload(info);
}

export async function GET(req: Request) {
  const settings = await readSettings();
  if (!settings.apiKey) {
    return NextResponse.json({ ok: false, error: "未设置 API 令牌" }, { status: 400 });
  }

  const url = `${resolveBaseUrl(settings.route)}/api/usage/token/`;
  let cached = balanceCache.get(settings.apiKey);
  if (!cached) {
    cached = await readPersistentCache(settings.apiKey) ?? undefined;
    if (cached) balanceCache.set(settings.apiKey, cached);
  }
  const force = new URL(req.url).searchParams.get("force") === "1";
  if (!force && cached && Date.now() - cached.fetchedAt < FRESH_MS) {
    return NextResponse.json({ ...cached.payload, cached: true });
  }

  try {
    let pending = balanceRequests.get(settings.apiKey);
    if (!pending) {
      pending = queryBalance(url, settings.apiKey);
      balanceRequests.set(settings.apiKey, pending);
    }
    const payload = await pending;
    const nextCached = { payload, fetchedAt: Date.now() };
    balanceCache.set(settings.apiKey, nextCached);
    await writePersistentCache(settings.apiKey, nextCached).catch(() => undefined);
    return NextResponse.json(payload);
  } catch (error) {
    if (cached && Date.now() - cached.fetchedAt < STALE_MS) {
      return NextResponse.json({ ...cached.payload, cached: true, stale: true });
    }
    return NextResponse.json(
      { ok: false, error: `余额查询失败：${error instanceof Error ? error.message : "网络异常"}` },
      { status: 502 },
    );
  } finally {
    balanceRequests.delete(settings.apiKey);
  }
}
