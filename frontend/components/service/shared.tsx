"use client"

import * as React from "react"
import Link from "next/link"

import { humanize } from "@/lib/format"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Kpi, StatusPill } from "@/components/erp/kit"

/** Horizontal meter for a 0..1 value. */
export function Meter({
  value,
  tone = "primary",
  className,
}: {
  value: number
  tone?: "primary" | "warn" | "bad"
  className?: string
}) {
  return (
    <div
      className={cn(
        "h-1.5 w-full overflow-hidden rounded-full bg-muted",
        className
      )}
    >
      <div
        className={cn(
          "h-full rounded-full",
          tone === "primary" && "bg-primary",
          tone === "warn" && "bg-warning",
          tone === "bad" && "bg-destructive"
        )}
        style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }}
      />
    </div>
  )
}

/** Factor contributions, so every ranking shows why it ranked. */
export function Breakdown({ parts }: { parts: Record<string, number> }) {
  return (
    <dl className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-1 text-xs">
      {Object.entries(parts).map(([k, v]) => (
        <React.Fragment key={k}>
          <dt className="text-muted-foreground capitalize">{humanize(k)}</dt>
          <dd>
            <Meter value={Math.abs(v) / 0.4} tone={v < 0 ? "bad" : "primary"} />
          </dd>
          <dd className="text-right font-mono tabular-nums">{v.toFixed(2)}</dd>
        </React.Fragment>
      ))}
    </dl>
  )
}

const TONES: Record<string, string> = {
  on_time: "text-success",
  available: "text-success",
  auto: "text-success",
  approved: "text-success",
  arrived: "text-info",
  with_advisor: "text-info",
  released: "text-foreground",
  in_workshop: "text-foreground",
  at_risk: "text-warning",
  alternative: "text-warning",
  transfer: "text-warning",
  draft: "text-warning",
  at_customer: "text-muted-foreground",
  at_gate: "text-info",
  manual_review: "text-destructive",
  late: "text-destructive",
  no_signal: "text-destructive",
  order: "text-destructive",
  unavailable: "text-destructive",
}

export function StatusBadge({ value }: { value: string }) {
  return (
    <StatusPill tone={TONES[value] ?? "text-muted-foreground"} className="capitalize">
      {humanize(value)}
    </StatusPill>
  )
}

export function Stat({
  label,
  value,
  hint,
  href,
}: {
  label: string
  value: React.ReactNode
  hint?: string
  href?: string
}) {
  return <Kpi label={label} value={value} hint={hint} href={href} />
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed bg-card/50 px-4 py-8 text-center text-sm text-muted-foreground">
      {children}
    </p>
  )
}

/** Which DBP use cases a screen covers, matching the solution brief's numbering. */
export function UseCaseTags({ ids }: { ids: number[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {ids.map((id) => (
        <Badge key={id} variant="outline" className="font-mono">
          UC{id}
        </Badge>
      ))}
    </div>
  )
}

export function useAsync() {
  const [busy, setBusy] = React.useState<string | null>(null)
  const run = React.useCallback(
    async <T,>(key: string, fn: () => Promise<T>) => {
      setBusy(key)
      try {
        return await fn()
      } finally {
        setBusy(null)
      }
    },
    []
  )
  return { busy, run }
}

/** Small "Why?" toggle revealing a one-line plain-English explanation. */
export function Why({ children }: { children: React.ReactNode }) {
  return (
    <details className="group/why max-w-full">
      <summary className="w-fit cursor-pointer list-none rounded-sm py-1 text-xs text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
        <span className="group-open/why:hidden">Why?</span>
        <span className="hidden group-open/why:inline">Hide explanation</span>
      </summary>
      <div className="mt-1 rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">
        {children}
      </div>
    </details>
  )
}

/** Registration number, linked to the vehicle record when the id is known. */
export function RegLink({
  reg,
  vehicleId,
  className,
}: {
  reg: string
  vehicleId?: number | null
  className?: string
}) {
  const cls = cn("font-mono text-xs", className)
  return vehicleId ? (
    <Link
      href={`/vehicles/${vehicleId}`}
      className={cn(cls, "underline-offset-2 hover:underline")}
    >
      {reg}
    </Link>
  ) : (
    <span className={cls}>{reg}</span>
  )
}

/** Section heading row: title on the left, actions on the right. */
export function SectionHeader({
  title,
  meta,
  actions,
}: {
  title: React.ReactNode
  meta?: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-2">
      <div className="flex items-baseline gap-2">
        <h2 className="caption">{title}</h2>
        {meta ? (
          <span className="text-xs text-muted-foreground">{meta}</span>
        ) : null}
      </div>
      {actions ? (
        <div className="flex items-center gap-2">{actions}</div>
      ) : null}
    </div>
  )
}
