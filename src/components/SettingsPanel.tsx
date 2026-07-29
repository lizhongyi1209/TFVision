"use client";

// 设置面板 — New API 令牌 + 连接测试（生成与 Agent 共用）。

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useStudio } from "@/lib/store";
import { Icon } from "./icons";
import { Button, Field, Spinner } from "./ui";
import { cn } from "@/lib/utils";
import type { RouteName } from "@/lib/types";

const NETWORK_ROUTES: RouteName[] = ["国内加速", "国外加速"];

export function SettingsPanel() {
  const open = useStudio((s) => s.settingsOpen);
  const setOpen = useStudio((s) => s.setSettingsOpen);
  const settings = useStudio((s) => s.settings);
  const saveSettings = useStudio((s) => s.saveSettings);
  const showToast = useStudio((s) => s.showToast);

  const [key, setKey] = useState("");
  const [route, setRoute] = useState<RouteName>("国内加速");
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; msg: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setKey("");
      setRoute(settings?.route ?? "国内加速");
      setTestMsg(null);
    }
  }, [open, settings?.route]);

  const test = async () => {
    setTesting(true);
    setTestMsg(null);
    try {
      const res = await fetch("/api/settings/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          route,
          ...(key.trim() ? { apiKey: key.trim() } : {}),
        }),
      });
      const payload = (await res.json()) as { ok: boolean; message: string };
      setTestMsg({ ok: payload.ok, msg: payload.ok ? "测试成功" : payload.message });
    } catch {
      setTestMsg({ ok: false, msg: "测试请求失败，请检查本地服务" });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setSaving(true);
    const ok = await saveSettings({
      route,
      ...(key.trim() ? { apiKey: key.trim() } : {}),
    });
    setSaving(false);
    if (ok) {
      showToast("设置已保存", "success");
      setOpen(false);
    }
  };

  return (
    <AnimatePresence>
      {open ? (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-ink/60 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 10 }}
            transition={{ type: "spring", stiffness: 380, damping: 30 }}
            className="glass fixed left-1/2 top-1/2 z-[101] w-[440px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 rounded-panel p-6"
          >
            <div className="mb-5 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-[15px] font-semibold text-fg">
                <Icon name="Gear" size={17} /> 设置
              </h2>
              <button type="button" onClick={() => setOpen(false)} className="rounded-full p-1.5 text-fg-mute hover:bg-white/5 hover:text-fg">
                <Icon name="X" size={15} />
              </button>
            </div>

            <div className="flex flex-col gap-4">
              <Field
                label="API令牌"
                hint={
                  settings?.hasApiKey
                    ? `当前已保存：${settings.apiKeyMasked} · 留空则保持不变`
                    : "在 o1key / New API 后台创建的令牌。生成与 Agent 服务共用，仅保存在本机。"
                }
              >
                <input
                  type="password"
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder={settings?.hasApiKey ? "••••••••（已保存）" : "sk-..."}
                  className="h-10 w-full rounded-control border border-line bg-panel-2 px-3 text-sm text-fg outline-none transition-colors placeholder:text-fg-mute focus:border-accent"
                  spellCheck={false}
                />
              </Field>

              <div className="flex flex-col gap-1.5">
                <span id="network-route-label" className="text-[11px] font-medium tracking-wide text-fg-mute">网络线路</span>
                <div
                  role="radiogroup"
                  aria-labelledby="network-route-label"
                  className="grid grid-cols-2 gap-1 rounded-[11px] border border-line bg-panel-2 p-1"
                >
                  {NETWORK_ROUTES.map((option) => {
                    const selected = route === option;
                    return (
                      <button
                        key={option}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => {
                          setRoute(option);
                          setTestMsg(null);
                        }}
                        className={cn(
                          "relative h-9 rounded-[8px] text-[12px] font-medium transition-[background-color,color,box-shadow] active:scale-[0.99]",
                          selected
                            ? "bg-white/[0.1] text-fg shadow-[0_5px_16px_rgba(0,0,0,0.22)]"
                            : "text-fg-mute hover:bg-white/[0.045] hover:text-fg-dim",
                        )}
                      >
                        {option}
                      </button>
                    );
                  })}
                </div>
              </div>

              {testMsg ? (
                <div
                  className={cn(
                    "flex items-start gap-2 rounded-control border px-3 py-2.5 text-[12px] leading-relaxed",
                    testMsg.ok ? "border-accent/40 bg-accent/10 text-accent" : "border-danger/40 bg-danger/10 text-danger",
                  )}
                >
                  <Icon name={testMsg.ok ? "Check" : "Warning"} size={14} className="mt-0.5 shrink-0" />
                  {testMsg.msg}
                </div>
              ) : null}

              <div className="mt-1 flex items-center justify-between">
                <Button variant="ghost" onClick={() => void test()} disabled={testing}>
                  {testing ? <Spinner size={14} /> : <Icon name="Lightning" size={14} />}
                  测试连接
                </Button>
                <Button variant="primary" onClick={() => void save()} disabled={saving}>
                  {saving ? <Spinner size={14} /> : <Icon name="Check" size={14} />}
                  保存
                </Button>
              </div>
            </div>
          </motion.div>
        </>
      ) : null}
    </AnimatePresence>
  );
}
