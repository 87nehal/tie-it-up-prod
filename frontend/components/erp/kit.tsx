"use client"

import * as React from "react"
import Link from "next/link"

import type { Stage } from "@/lib/erp-api"
import { cn } from "@/lib/utils"
import { subscribeDataChange } from "@/lib/demo-sync"

/** Page heading row: title, optional subtitle and actions on the right. */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string
  subtitle?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-[22px] font-medium tracking-[-.025em]">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

/** Tiny decorative bar strip beside a stat; the tallest bar is drawn in ink. */
export function MiniBars({ seed = 1, className }: { seed?: number; className?: string }) {
  // whole percents, so server and client render identical markup
  const bars = Array.from({ length: 9 }, (_, i) => Math.round(35 + 65 * Math.abs(Math.sin(seed * 7.3 + i * 1.9))))
  const peak = bars.indexOf(Math.max(...bars))
  return (
    <span aria-hidden className={cn("flex h-8 items-end gap-[3px]", className)}>
      {bars.map((h, i) => (
        <span
          key={i}
          className={cn("w-[2px] rounded-full", i === peak ? "bg-foreground" : "bg-foreground/15")}
          style={{ height: `${h}%` }}
        />
      ))}
    </span>
  )
}

/** Stat tile in the tray style: mono caption, big mono number, footnote strip underneath. */
export function Kpi({
  label,
  value,
  hint,
  unit,
  href,
  tone,
  seed,
}: {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
  unit?: React.ReactNode
  href?: string
  tone?: "warn" | "bad" | "good"
  seed?: number
}) {
  const body = (
    <>
      <div className="tray-inner flex items-end justify-between gap-3 px-3.5 pt-3 pb-3.5">
        <div className="min-w-0">
          <p className="caption truncate">{label}</p>
          <p className="mt-2 flex items-baseline gap-2">
            <span
              className={cn(
                "num text-[26px] leading-none font-medium",
                tone === "warn" && "text-warning",
                tone === "bad" && "text-destructive",
                tone === "good" && "text-success"
              )}
            >
              {value}
            </span>
            {unit && <span className="truncate text-xs text-muted-foreground">{unit}</span>}
          </p>
        </div>
        <MiniBars seed={seed ?? label.length} className="shrink-0" />
      </div>
      {hint && (
        <p className="flex items-center gap-1.5 truncate px-2.5 pt-2 pb-1.5 text-[11.5px] text-muted-foreground">
          <span className="size-1.5 shrink-0 rounded-full bg-foreground/25" />
          {hint}
        </p>
      )}
    </>
  )
  return href ? (
    <Link href={href} className="tray card-lift block">
      {body}
    </Link>
  ) : (
    <div className="tray">{body}</div>
  )
}

/** Tray panel: mono caption on the grey frame, content on a white inner card. */
export function Panel({
  title,
  action,
  children,
  className,
  bodyClassName,
}: {
  title: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section className={cn("tray flex flex-col", className)}>
      <div className="flex min-h-10 items-center justify-between gap-2 px-3 py-1.5">
        <h3 className="caption">{title}</h3>
        {action}
      </div>
      <div className={cn("tray-inner flex-1 overflow-hidden p-4", bodyClassName)}>{children}</div>
    </section>
  )
}

/** Status for each stage: a muted outline pill whose dot carries the state colour. */
export const STAGE_TONE: Record<string, string> = {
  expected: "text-muted-foreground",
  arrived: "text-info",
  estimate: "text-warning",
  draft: "text-warning",
  approved: "text-info",
  in_progress: "text-foreground",
  released: "text-foreground",
  qc: "text-info",
  ready: "text-success",
  delivered: "text-muted-foreground/60",
}

const LABEL: Record<string, string> = {
  expected: "Expected",
  arrived: "Arrived",
  estimate: "Estimate",
  draft: "Estimate",
  approved: "Approved",
  released: "In bay",
  in_progress: "In bay",
  qc: "Quality check",
  ready: "Ready",
  delivered: "Delivered",
}

export function StatusPill({
  tone,
  children,
  className,
}: {
  tone?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-full border bg-card px-2.5 text-xs font-medium whitespace-nowrap text-foreground shadow-[0_1px_1px_rgba(0,0,0,.03)]",
        className
      )}
    >
      <span className={cn("relative flex size-2.5 items-center justify-center", tone)}>
        <span className="absolute inset-0 rounded-full bg-current opacity-20" />
        <span className="size-1.5 rounded-full bg-current" />
      </span>
      {children}
    </span>
  )
}

export function StagePill({ stage }: { stage: Stage | string }) {
  return (
    <StatusPill
      tone={STAGE_TONE[stage] ?? STAGE_TONE.expected}
      className={stage === "delivered" ? "text-muted-foreground" : undefined}
    >
      {LABEL[stage] ?? stage}
    </StatusPill>
  )
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="caption text-[10.5px]">{label}</dt>
      <dd className="text-sm font-medium">{children || "—"}</dd>
    </div>
  )
}

export function usePoll<T>(load: () => Promise<T>, ms = 15_000) {
  const [data, setData] = React.useState<T | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const ref = React.useRef(load)
  React.useEffect(() => {
    ref.current = load
  })
  const refresh = React.useCallback(async () => {
    try {
      setData(await ref.current())
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])
  React.useEffect(() => {
    void refresh()
    const t = window.setInterval(refresh, ms)
    const unsubscribe = subscribeDataChange(() => { void refresh() })
    return () => { window.clearInterval(t); unsubscribe() }
  }, [refresh, ms])
  return { data, error, refresh }
}

/** Seed text sometimes carries a mis-encoded middle dot (UTF-8 read as Latin-1). */
export function clean(s?: string | null) {
  return (s ?? "").replaceAll("Â·", "·").replaceAll("Â", "")
}
