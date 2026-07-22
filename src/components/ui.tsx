"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Icon, type IconProps } from "./icons";

export function Button({
  children,
  onClick,
  variant = "ghost",
  disabled,
  className,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "ghost" | "subtle" | "danger";
  disabled?: boolean;
  className?: string;
  type?: "button" | "submit";
}) {
  const variants: Record<string, string> = {
    primary: "bg-accent text-ink hover:bg-accent-2 shadow-[0_10px_34px_-8px_rgba(255,255,255,0.35)]",
    ghost: "border border-line text-fg hover:bg-white/5 hover:border-line-2",
    subtle: "text-fg-dim hover:text-fg hover:bg-white/5",
    danger: "border border-line text-danger hover:bg-danger/10 hover:border-danger/40",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex h-9 select-none items-center justify-center gap-2 rounded-full px-4 text-sm font-medium transition-all duration-200",
        "active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40",
        variants[variant],
        className,
      )}
    >
      {children}
    </button>
  );
}

export function IconButton({
  name,
  onClick,
  label,
  active,
  className,
  size = 18,
  weight = "regular",
}: {
  name: string;
  onClick?: (e: React.MouseEvent) => void;
  label: string;
  active?: boolean;
  className?: string;
  size?: number;
  weight?: IconProps["weight"];
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "inline-flex h-9 w-9 items-center justify-center rounded-full transition-all duration-200 active:scale-95",
        active ? "bg-white/10 text-fg" : "text-fg-dim hover:bg-white/5 hover:text-fg",
        className,
      )}
    >
      <Icon name={name} size={size} weight={weight} />
    </button>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium tracking-wide text-fg-mute">{label}</span>
      {children}
      {hint ? <span className="text-[11px] leading-snug text-fg-mute">{hint}</span> : null}
    </label>
  );
}

export function Select({
  value,
  onChange,
  options,
  className,
  compact,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string; disabled?: boolean }[];
  className?: string;
  compact?: boolean;
}) {
  return (
    <div className={cn("relative", className)}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "w-full cursor-pointer appearance-none rounded-control border border-line bg-panel-2 text-fg transition-colors hover:border-line-2 focus:border-accent focus:outline-none",
          compact ? "h-7 pl-2 pr-6 text-[11px]" : "h-10 pl-3 pr-9 text-sm",
        )}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled} className="bg-panel text-fg">
            {o.label}
          </option>
        ))}
      </select>
      <Icon
        name="CaretDown"
        size={compact ? 10 : 14}
        className={cn("pointer-events-none absolute top-1/2 -translate-y-1/2 text-fg-mute", compact ? "right-1.5" : "right-3")}
      />
    </div>
  );
}

export function Chip({
  children,
  active,
  onClick,
  className,
  title,
}: {
  children: ReactNode;
  active?: boolean;
  onClick?: () => void;
  className?: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 shrink-0 select-none items-center gap-1 rounded-full border px-2.5 text-[11px] transition-all",
        active
          ? "border-accent/60 bg-accent/15 text-accent"
          : "border-line bg-white/[0.03] text-fg-dim hover:border-line-2 hover:text-fg",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return <Icon name="CircleNotch" size={size} className={cn("spin", className)} />;
}
