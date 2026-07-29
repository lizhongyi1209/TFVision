import { NextResponse } from "next/server";
import { readSettings } from "@/lib/settings";
import { isRouteName, resolveBaseUrl } from "@/lib/networkRoutes";
import { TASK_ENDPOINT } from "@/lib/o1key";
import { diagnosticFetch } from "@/lib/diagnostics.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Cheap connectivity + auth probe: query a nonexistent task id.
// 401/403 => token rejected. Anything else => reachable and accepted.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const s = await readSettings();

  const apiKey = (typeof body.apiKey === "string" && body.apiKey.trim()) || s.apiKey;
  const route = isRouteName(body.route) ? body.route : s.route;
  const baseUrl = resolveBaseUrl(route);

  if (!apiKey) {
    return NextResponse.json({ ok: false, reachable: false, message: "未设置 API 令牌" });
  }

  const url = `${baseUrl}${TASK_ENDPOINT}connectivity-probe-000`;
  try {
    const res = await diagnosticFetch(
      url,
      { headers: { Authorization: `Bearer ${apiKey}` } },
      { category: "settings", label: "测试网关连接" },
    );
    if (res.status === 401 || res.status === 403) {
      return NextResponse.json({
        ok: false,
        reachable: true,
        message: `令牌被拒绝 (HTTP ${res.status})，请检查 o1key 令牌是否正确`,
      });
    }
    return NextResponse.json({
      ok: true,
      reachable: true,
      message: "测试成功",
    });
  } catch (e) {
    return NextResponse.json({
      ok: false,
      reachable: false,
      message: `无法连接所选线路：${(e as Error)?.message || e}。请检查网络。`,
    });
  }
}
