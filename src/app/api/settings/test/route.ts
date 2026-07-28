import { NextResponse } from "next/server";
import { readSettings } from "@/lib/settings";
import { resolveBaseUrl, TASK_ENDPOINT } from "@/lib/o1key";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Cheap connectivity + auth probe: query a nonexistent task id.
// 401/403 => token rejected. Anything else => reachable and accepted.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const s = await readSettings();

  const apiKey = (typeof body.apiKey === "string" && body.apiKey.trim()) || s.apiKey;
  const baseUrl = resolveBaseUrl(s.route);

  if (!apiKey) {
    return NextResponse.json({ ok: false, reachable: false, message: "未设置 API 令牌", baseUrl });
  }

  const url = `${baseUrl}${TASK_ENDPOINT}connectivity-probe-000`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (res.status === 401 || res.status === 403) {
      return NextResponse.json({
        ok: false,
        reachable: true,
        message: `令牌被拒绝 (HTTP ${res.status})，请检查 o1key 令牌是否正确`,
        baseUrl,
      });
    }
    return NextResponse.json({
      ok: true,
      reachable: true,
      message: "测试成功",
      baseUrl,
    });
  } catch (e) {
    return NextResponse.json({
      ok: false,
      reachable: false,
      message: `无法连接 ${baseUrl}：${(e as Error)?.message || e}。请检查网络。`,
      baseUrl,
    });
  }
}
