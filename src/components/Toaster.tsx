"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect } from "react";
import { useStudio } from "@/lib/store";
import { Icon } from "./icons";
import { cn } from "@/lib/utils";

export function Toaster() {
  const toast = useStudio((s) => s.toast);
  const clear = useStudio((s) => s.clearToast);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(clear, toast.kind === "error" ? 5200 : 3000);
    return () => clearTimeout(t);
  }, [toast, clear]);

  const icon = toast?.kind === "error" ? "Warning" : toast?.kind === "success" ? "Check" : "Lightning";
  const tint = toast?.kind === "error" ? "text-danger" : toast?.kind === "success" ? "text-accent" : "text-fg";

  return (
    <div className="pointer-events-none fixed inset-x-0 top-5 z-[120] flex justify-center px-4">
      <AnimatePresence>
        {toast ? (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, y: -16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -12, scale: 0.96 }}
            transition={{ type: "spring", stiffness: 420, damping: 30 }}
            className="glass pointer-events-auto flex max-w-[92vw] items-center gap-2.5 rounded-full px-4 py-2.5"
          >
            <Icon name={icon} size={16} className={cn(tint, "shrink-0")} weight="bold" />
            <span className="text-sm text-fg">{toast.msg}</span>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
