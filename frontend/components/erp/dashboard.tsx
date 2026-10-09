"use client"

import * as React from "react"
import Link from "next/link"
import { toast } from "sonner"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Alert02Icon,
  ArrowRight01Icon,
  Calendar01Icon,
  Download04Icon,
  MoreHorizontalIcon,
  RefreshIcon,
  Search01Icon,
  SparklesIcon,
} from "@hugeicons/core-free-icons"

import {
  erp,
  type Board,
  type BoardCard,
  type Dashboard as DashboardData,
  type ErpContext,
  type Stage,
} from "@/lib/erp-api"
import { service } from "@/lib/service-api"
import { clock, inr, pct } from "@/lib/format"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Kpi, Panel, StagePill, usePoll } from "@/components/erp/kit"
import { COUNT_HINT, FocusStrip, FollowButton, Plate, STEPS, useJourney } from "@/components/erp/journey"

type Assists = Record<string, number>

function nextAction(card: BoardCard) {
  switch (card.stage) {
    case "expected":
      return { label: "Check in", href: `/reception?v=${card.vehicle_id}` }
    case "arrived":
      return { label: "Open job card", href: `/job-cards?visit=${card.visit_id}` }
    case "estimate":
      return { label: "Get approval", href: `/job-cards?jc=${card.job_card_id}` }
    case "approved":
      return { label: "Release", href: `/job-cards?jc=${card.job_card_id}` }
    case "in_progress":
    case "qc":
      return { label: card.stage === "qc" ? "Complete QC" : "View work", href: `/workshop?v=${card.vehicle_id}` }
    case "ready":
      return { label: "Deliver", href: `/billing?v=${card.vehicle_id}` }
    default:
      return { label: "Open record", href: `/vehicles/${card.vehicle_id}` }
  }
}

const allCards = (board: Board | null) => (board?.stages ?? []).flatMap((s) => s.cards)

/** Live floor as CSV, for the outlet's end-of-day sheet. */
function exportCsv(cards: BoardCard[]) {
  const cols = ["reg_no", "model", "customer_name", "stage", "advisor_name", "time", "promised", "detail"] as const
  const esc = (v: unknown) => `"${String(v ?? "").replaceAll('"', '""')}"`
  const csv = [cols.join(","), ...cards.map((c) => cols.map((k) => esc(c[k])).join(","))].join("\n")
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }))
  const a = document.createElement("a")
  a.href = url
  a.download = `live-floor-${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// ------------------------------------------------------------------ header

function Welcome({
  ctx,
  cards,
  onReset,
  resetting,
}: {
  ctx: ErpContext | null
  cards: BoardCard[]
  onReset: () => void
  resetting: boolean
}) {
  const date = ctx
    ? new Date(ctx.business_date).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
    : "—"
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-[26px] font-medium tracking-[-.03em]">
          Welcome back, {ctx?.user.name.split(" ")[0] ?? "…"}
        </h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {ctx ? `${ctx.outlet.name} · ${ctx.outlet.channel} ${ctx.outlet.kind}` : "Loading outlet…"}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex h-9 items-center overflow-hidden rounded-lg border bg-card text-sm shadow-[0_1px_2px_rgba(0,0,0,.04)]">
          <span className="flex h-full items-center border-r px-3 text-muted-foreground">Daily</span>
          <span className="flex h-full items-center gap-2 px-3">
            <HugeiconsIcon icon={Calendar01Icon} strokeWidth={1.8} className="size-4 text-muted-foreground" />
            {date}
          </span>
        </div>
        <Button variant="outline" onClick={onReset} disabled={resetting}>
          <HugeiconsIcon
            icon={RefreshIcon}
            strokeWidth={2}
            data-icon="inline-start"
            className={cn(resetting && "animate-spin")}
          />
          {resetting ? "Resetting…" : "Reset demo day"}
        </Button>
        <Button onClick={() => exportCsv(cards)} disabled={!cards.length}>
          <HugeiconsIcon icon={Download04Icon} strokeWidth={2} data-icon="inline-start" />
          Export CSV
        </Button>
      </div>
    </div>
  )
}

function KpiRow({ d }: { d: DashboardData | null }) {
  const k = d?.kpis
  return (
    <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Kpi
        label="Visits today"
        value={k?.appointments_today ?? "—"}
        unit="Vehicles"
        hint={k ? `${k.expected} still to arrive · ${d?.tomorrow ?? 0} booked tomorrow` : "…"}
        href="/appointments"
        seed={3}
      />
      <Kpi
        label="In the workshop"
        value={k?.in_workshop ?? "—"}
        unit="In bays"
        hint={k ? `${k.ready} ready for delivery` : "…"}
        href="/workshop"
        seed={5}
      />
      <Kpi
        label="Revenue today"
        value={k ? inr(k.revenue_today) : "—"}
        hint={k ? `${k.delivered} delivered · ${inr(k.open_pipeline_value)} open` : "…"}
        href="/billing"
        seed={8}
      />
      <Kpi
        label="Bay utilisation"
        value={k ? pct(k.bay_utilisation) : "—"}
        tone={k && k.bay_utilisation > 0.85 ? "bad" : undefined}
        hint={k ? `${Math.round(k.technician_hours_booked)} / ${k.technician_hours_available} technician hours` : "…"}
        href="/workshop"
        seed={11}
      />
    </div>
  )
}

// ------------------------------------------------------------------ floor activity (dot-grid)

type Mode = "all" | "walkin" | "pickup"

const SLOT_STEPS = [15, 30, 60, 120] // minutes
const MAX_ROWS = 14

/** Time buckets spanning the day's actual cards, at the finest step that fits ~28 columns. */
function timeSlots(cards: BoardCard[]) {
  const ts = cards.map((c) => new Date(c.time).getTime()).filter((t) => !Number.isNaN(t))
  if (!ts.length) return { start: 0, step: 60, count: 12 }
  const lo = Math.min(...ts)
  const hi = Math.max(...ts)
  const step = SLOT_STEPS.find((m) => (hi - lo) / (m * 60_000) < 28) ?? 120
  const start = Math.floor(lo / (step * 60_000)) * step * 60_000
  const count = Math.max(12, Math.floor((hi - start) / (step * 60_000)) + 1)
  return { start, step, count }
}

function timeLabel(ms: number, short = false) {
  const d = new Date(ms)
  const h = d.getHours() % 12 || 12
  const ap = d.getHours() >= 12 ? (short ? "p" : " PM") : short ? "a" : " AM"
  const m = d.getMinutes()
  return short && m === 0 ? `${h}${ap}` : `${h}:${String(m).padStart(2, "0")}${ap}`
}

function FloorActivity({ cards }: { cards: BoardCard[] | null }) {
  const [mode, setMode] = React.useState<Mode>("all")
  const [hover, setHover] = React.useState<number | null>(null)
  const shown = (cards ?? []).filter((c) => mode === "all" || (c.mode ?? "walkin") === mode)
  const { start, step, count } = timeSlots(cards ?? [])
  const slotMs = step * 60_000
  const cols = Array.from({ length: count }, () => ({ arrived: 0, expected: 0 }))
  for (const c of shown) {
    const t = new Date(c.time).getTime()
    if (Number.isNaN(t)) continue
    const s = Math.min(count - 1, Math.max(0, Math.floor((t - start) / slotMs)))
    if (c.stage === "expected") cols[s].expected++
    else cols[s].arrived++
  }
  const peak = Math.max(...cols.map((c) => c.arrived + c.expected), 1)
  // one square stands for `unit` vehicles, so a busy slot never shrinks the grid to slivers
  const unit = Math.max(1, Math.ceil(peak / MAX_ROWS))
  const rows = Math.max(8, Math.ceil(peak / unit))
  const ticks = [rows, (rows * 3) / 4, rows / 2, rows / 4, 0].map((t) => Math.round(t * unit))
  const labelEvery = Math.max(1, Math.round(count / 7))

  return (
    <Panel
      title="Floor activity"
      action={<MoreButton />}
      bodyClassName="p-4 pb-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex items-baseline gap-2.5">
          <span className="text-xs text-muted-foreground">Vehicles today :</span>
          <span className="num text-[24px] leading-none font-medium">{cards ? shown.length : "—"}</span>
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <span className="caption flex items-center gap-1.5 text-[10.5px]">
            <span className="size-2 rounded-[2px] bg-chart-2" /> Expected
          </span>
          <span className="caption flex items-center gap-1.5 text-[10.5px]">
            <span className="size-2 rounded-[2px] bg-chart-1" /> Arrived
          </span>
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              { value: "all", label: "All" },
              { value: "walkin", label: "Walk-in" },
              { value: "pickup", label: "Pickup" },
            ]}
          />
        </div>
      </div>

      {!cards ? (
        <Skeleton className="mt-4 h-64" />
      ) : (
        <div className="mt-4 flex gap-2">
          {/* y-axis */}
          <div className="flex w-6 shrink-0 flex-col justify-between pb-6 text-right">
            {ticks.map((t, i) => (
              <span key={i} className="num text-[10px] leading-none text-muted-foreground">
                {t}
              </span>
            ))}
          </div>
          <div className="relative min-w-0 flex-1" onMouseLeave={() => setHover(null)}>
            <div className="flex h-64 gap-[3px]">
              {cols.map((c, i) => {
                const dark = Math.ceil(c.arrived / unit)
                const filled = Math.ceil((c.arrived + c.expected) / unit)
                return (
                  <div
                    key={i}
                    onMouseEnter={() => setHover(i)}
                    className="relative flex flex-1 cursor-default flex-col-reverse gap-[3px]"
                  >
                    {Array.from({ length: rows }, (_, r) => (
                      <span
                        key={r}
                        className={cn(
                          "min-h-0 flex-1 rounded-[2px] transition-colors",
                          r < dark
                            ? "bg-chart-1"
                            : r < filled
                              ? "bg-chart-2"
                              : hover === i
                                ? "bg-foreground/[.07]"
                                : "bg-foreground/[.035]"
                        )}
                      />
                    ))}
                    {hover === i && (
                      <span className="pointer-events-none absolute inset-y-0 left-1/2 border-l border-dashed border-foreground/40" />
                    )}
                  </div>
                )
              })}
            </div>
            {/* x-axis */}
            <div className="mt-2 flex h-4 gap-[3px]">
              {cols.map((_, i) => (
                <span
                  key={i}
                  className={cn(
                    "num flex flex-1 justify-center overflow-visible text-[10px] whitespace-nowrap text-muted-foreground",
                    hover === i && "font-medium text-foreground"
                  )}
                >
                  {i % labelEvery === 0 || hover === i ? timeLabel(start + i * slotMs, true) : "·"}
                </span>
              ))}
            </div>
            {hover !== null && (
              <div
                className="pointer-events-none absolute top-6 z-10 w-40 rounded-lg border bg-popover text-sm shadow-[0_12px_32px_-12px_rgba(0,0,0,.25)]"
                style={{
                  left: `calc(${((hover + 0.5) / count) * 100}% ${hover > count * 0.65 ? "- 10.5rem" : "+ 0.5rem"})`,
                }}
              >
                <p className="border-b bg-muted/60 px-3 py-1.5 text-xs text-muted-foreground">{timeLabel(start + hover * slotMs)} – {timeLabel(start + (hover + 1) * slotMs)}</p>
                <div className="space-y-1 px-3 py-2">
                  <p className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <span className="size-1.5 rounded-full bg-chart-1" /> Arrived
                    </span>
                    <span className="num font-medium">{cols[hover].arrived}</span>
                  </p>
                  <p className="flex items-center justify-between text-xs">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <span className="size-1.5 rounded-full border border-foreground/30 bg-chart-2" /> Expected
                    </span>
                    <span className="num font-medium">{cols[hover].expected}</span>
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </Panel>
  )
}

// ------------------------------------------------------------------ stage funnel (bars)

const FUNNEL: { key: Stage; short: string; label: string }[] = [
  { key: "expected", short: "EXP", label: "Expected" },
  { key: "arrived", short: "ARR", label: "Arrived" },
  { key: "estimate", short: "EST", label: "Estimate" },
  { key: "approved", short: "APR", label: "Approved" },
  { key: "in_progress", short: "BAY", label: "In bay" },
  { key: "qc", short: "QC", label: "Quality check" },
  { key: "ready", short: "RDY", label: "Ready" },
  { key: "delivered", short: "DLV", label: "Delivered" },
]

function StageFunnel({ d, cards }: { d: DashboardData | null; cards: BoardCard[] | null }) {
  const { setGuideOpen } = useJourney()
  const [hover, setHover] = React.useState<number | null>(null)
  const at = FUNNEL.map((f) => (cards ?? []).filter((c) => c.stage === f.key).length)
  const reached = at.map((_, i) => at.slice(i).reduce((a, b) => a + b, 0))
  const max = Math.max(...reached, 1)
  const assists = Object.values(d?.assists ?? {}).reduce((a, b) => a + b, 0)

  return (
    <Panel title="Stage breakdown" action={<MoreButton />} bodyClassName="flex flex-col p-4 pb-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs text-muted-foreground">Open work value</p>
          <p className="num mt-1 text-[24px] leading-none font-medium">
            {d ? inr(d.kpis.open_pipeline_value) : "—"}
          </p>
        </div>
        <span className="flex h-8 items-center gap-1.5 rounded-lg border bg-card px-2.5 text-xs shadow-[0_1px_2px_rgba(0,0,0,.04)]">
          <HugeiconsIcon icon={Calendar01Icon} strokeWidth={1.8} className="size-3.5 text-muted-foreground" />
          Today
        </span>
      </div>

      <button
        type="button"
        onClick={() => setGuideOpen(true)}
        className="mt-3 flex items-center gap-2.5 rounded-lg border bg-muted/60 px-2.5 py-2 text-left text-[13px] transition-colors hover:bg-muted"
      >
        <span className="flex size-6 items-center justify-center rounded-md border bg-card">
          <HugeiconsIcon icon={SparklesIcon} strokeWidth={1.8} className="size-3.5" />
        </span>
        <span className="flex-1 truncate">
          <span className="num font-medium">{d ? assists : "—"}</span> AI assists ran today
        </span>
        <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} className="size-4 text-muted-foreground" />
      </button>

      {!cards ? (
        <Skeleton className="mt-4 h-52" />
      ) : (
        <div className="relative mt-4 flex-1" onMouseLeave={() => setHover(null)}>
          <div className="relative flex h-52 items-end justify-around gap-1 px-1">
            {/* dotted grid */}
            <div className="pointer-events-none absolute inset-0 flex flex-col justify-between">
              {Array.from({ length: 7 }, (_, i) => (
                <span key={i} className="border-t border-dotted border-foreground/15" />
              ))}
            </div>
            {FUNNEL.map((f, i) => (
              <div
                key={f.key}
                onMouseEnter={() => setHover(i)}
                className="relative z-[1] flex h-full flex-1 cursor-default items-end justify-center"
              >
                <div
                  className={cn("relative w-[6px] rounded-t-[4px] bg-chart-2 transition-opacity", hover !== null && hover !== i && "opacity-50")}
                  style={{ height: `${(reached[i] / max) * 100}%` }}
                >
                  <div
                    className="absolute inset-x-0 bottom-0 rounded-t-[4px] bg-chart-1"
                    style={{ height: reached[i] ? `${(at[i] / reached[i]) * 100}%` : 0 }}
                  />
                </div>
                {hover === i && (
                  <div
                    className={cn(
                      "pointer-events-none absolute bottom-full z-10 mb-1 w-36 rounded-lg border bg-popover text-xs shadow-[0_12px_32px_-12px_rgba(0,0,0,.25)]",
                      i > 4 ? "right-0" : "left-0"
                    )}
                  >
                    <p className="border-b bg-muted/60 px-3 py-1.5 text-muted-foreground">{f.label}</p>
                    <div className="space-y-1 px-3 py-2">
                      <p className="flex justify-between">
                        <span className="text-muted-foreground">At stage</span>
                        <span className="num font-medium">{at[i]}</span>
                      </p>
                      <p className="flex justify-between">
                        <span className="text-muted-foreground">Reached</span>
                        <span className="num font-medium">{reached[i]}</span>
                      </p>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="mt-2 flex justify-around px-1">
            {FUNNEL.map((f, i) => (
              <span key={f.key} className={cn("num flex-1 text-center text-[10px] text-muted-foreground", hover === i && "text-foreground")}>
                {f.short}
              </span>
            ))}
          </div>
          <div className="mt-2 flex items-center justify-between border-t border-dotted pt-2">
            <span className="caption flex items-center gap-1.5 text-[10px]">
              <span className="size-2 rounded-[2px] bg-chart-1" /> At stage
            </span>
            <span className="caption flex items-center gap-1.5 text-[10px]">
              <span className="size-2 rounded-[2px] bg-chart-2" /> Reached
            </span>
          </div>
        </div>
      )}
    </Panel>
  )
}

// ------------------------------------------------------------------ small controls

function MoreButton() {
  return (
    <span className="flex size-6 items-center justify-center rounded-full border bg-card text-muted-foreground">
      <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} className="size-3.5" />
    </span>
  )
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
}) {
  return (
    <div className="flex rounded-full border bg-muted p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-full px-3 py-1 text-xs transition-colors",
            value === o.value
              ? "bg-card font-medium text-foreground shadow-[0_1px_2px_rgba(0,0,0,.08),0_0_0_1px_var(--border)]"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------ journey strip

function JourneyStrip({ d }: { d: DashboardData | null }) {
  const { counts } = useJourney()
  const p = Object.fromEntries((d?.pipeline ?? []).map((s) => [s.key, s.count])) as Record<Stage, number>
  const bottleneck = (p.estimate ?? 0) >= 10 ? "job_card" : null
  return (
    <Panel title="Today's service journey" className="mb-4" bodyClassName="p-0">
      <div className="grid grid-cols-2 divide-x divide-y sm:grid-cols-4 sm:divide-y-0 xl:grid-cols-7">
        {STEPS.map((s) => (
          <Link
            key={s.key}
            href={s.href}
            title={COUNT_HINT[s.key]}
            className={cn(
              "group flex flex-col gap-1 px-3.5 py-3 transition-colors hover:bg-muted/50",
              bottleneck === s.key && "bg-warning/[.06]"
            )}
          >
            <span className="flex items-center justify-between">
              <span className="num text-[10px] text-muted-foreground">{String(s.n).padStart(2, "0")}</span>
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                strokeWidth={2}
                className="size-3.5 text-muted-foreground/40 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
              />
            </span>
            <span className="num text-[22px] leading-none font-medium">{counts ? counts[s.key] : "—"}</span>
            <span className="truncate text-xs text-muted-foreground">{s.label}</span>
          </Link>
        ))}
      </div>
    </Panel>
  )
}

// ------------------------------------------------------------------ live floor

const FILTERS: { key: "active" | Stage; label: string }[] = [
  { key: "active", label: "All active" },
  { key: "expected", label: "Expected" },
  { key: "arrived", label: "Arrived" },
  { key: "estimate", label: "Estimate" },
  { key: "approved", label: "Approved" },
  { key: "in_progress", label: "In bay" },
  { key: "qc", label: "QC" },
  { key: "ready", label: "Ready" },
  { key: "delivered", label: "Delivered" },
]

const PAGE = 10

function LiveFloor({ cards }: { cards: BoardCard[] | null }) {
  const [filter, setFilter] = React.useState<"active" | Stage>("active")
  const [q, setQ] = React.useState("")
  const [page, setPage] = React.useState(0)
  const all = cards ?? []
  const countOf = (k: "active" | Stage) =>
    k === "active" ? all.filter((c) => c.stage !== "delivered").length : all.filter((c) => c.stage === k).length
  const rows = all
    .filter((c) => (filter === "active" ? c.stage !== "delivered" : c.stage === filter))
    .filter(
      (c) =>
        !q.trim() ||
        `${c.reg_no} ${c.reg_display} ${c.customer_name} ${c.model} ${c.advisor_name ?? ""}`.toLowerCase().includes(q.toLowerCase())
    )
  const pages = Math.max(1, Math.ceil(rows.length / PAGE))
  const shown = rows.slice(page * PAGE, page * PAGE + PAGE)

  return (
    <Panel
      title="Live floor"
      className="mb-4"
      bodyClassName="p-0"
      action={
        <div className="flex items-center gap-2">
          <div className="relative">
            <HugeiconsIcon
              icon={Search01Icon}
              strokeWidth={2}
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              value={q}
              onChange={(e) => {
                setQ(e.target.value)
                setPage(0)
              }}
              placeholder="Search vehicles…"
              className="h-7 w-48 pl-8 text-xs md:text-xs"
            />
          </div>
          <Button size="xs" variant="outline" className="h-7" nativeButton={false} render={<Link href="/appointments" />}>
            + New appointment
          </Button>
          <MoreButton />
        </div>
      }
    >
      <div className="flex gap-1 overflow-x-auto border-b px-3 py-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => {
              setFilter(f.key)
              setPage(0)
            }}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs transition-colors",
              filter === f.key
                ? "border-border bg-card font-medium text-foreground shadow-[0_1px_2px_rgba(0,0,0,.06)]"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {f.label}
            <span className="num text-[10.5px] text-muted-foreground">{cards ? countOf(f.key) : ""}</span>
          </button>
        ))}
      </div>
      {!cards ? (
        <div className="space-y-2 p-4">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-[11px] uppercase">
              <tr>
                <th className="px-4 py-2.5">Vehicle</th>
                <th className="px-3 py-2.5">Customer</th>
                <th className="hidden px-3 py-2.5 xl:table-cell">Model</th>
                <th className="px-3 py-2.5">Status</th>
                <th className="hidden px-3 py-2.5 lg:table-cell">Detail</th>
                <th className="hidden px-3 py-2.5 md:table-cell">Time</th>
                <th className="px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => {
                const a = nextAction(c)
                return (
                  <tr key={c.key} className={cn("border-t", c.stage === "delivered" && "opacity-55")}>
                    <td className="px-4 py-2.5">
                      <Link href={`/vehicles/${c.vehicle_id}`} className="hover:opacity-80">
                        <Plate reg={c.reg_display} size="sm" />
                      </Link>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className="block truncate font-medium">{c.customer_name}</span>
                      {c.advisor_name && (
                        <span className="block text-[11px] text-muted-foreground">SA {c.advisor_name}</span>
                      )}
                    </td>
                    <td className="hidden px-3 py-2.5 text-muted-foreground xl:table-cell">{c.model}</td>
                    <td className="px-3 py-2.5">
                      <StagePill stage={c.stage} />
                    </td>
                    <td className="hidden max-w-60 truncate px-3 py-2.5 text-xs text-muted-foreground lg:table-cell">
                      {c.detail}
                    </td>
                    <td className="num hidden px-3 py-2.5 text-xs whitespace-nowrap md:table-cell">
                      {c.promised ? `Due ${clock(c.promised)}` : clock(c.time)}
                    </td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      <FollowButton vehicleId={c.vehicle_id} className="mr-1.5" />
                      <Button size="xs" variant="outline" nativeButton={false} render={<Link href={a.href} />}>
                        {a.label}
                        <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} data-icon="inline-end" />
                      </Button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {cards && rows.length === 0 && <p className="p-8 text-center text-sm text-muted-foreground">No vehicles match.</p>}
      {cards && rows.length > PAGE && (
        <div className="flex items-center justify-between border-t px-4 py-2.5 text-xs text-muted-foreground">
          <span className="num">
            {page * PAGE + 1}–{Math.min(rows.length, (page + 1) * PAGE)} of {rows.length}
          </span>
          <span className="flex gap-1">
            <Button size="xs" variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>
              Previous
            </Button>
            <Button size="xs" variant="outline" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>
              Next
            </Button>
          </span>
        </div>
      )}
    </Panel>
  )
}

// ------------------------------------------------------------------ side panels

function Attention({ d }: { d: DashboardData | null }) {
  return (
    <Panel
      title="Needs attention"
      action={<span className="num rounded-full border bg-card px-2 text-[11px]">{d?.alerts.length ?? 0}</span>}
      bodyClassName="p-2"
    >
      <div className="space-y-0.5">
        {(d?.alerts ?? []).map((a, i) => (
          <Link
            key={i}
            href={`/vehicles/${a.vehicle_id}`}
            className="flex items-start gap-2.5 rounded-lg px-2 py-1.5 text-[13px] hover:bg-muted"
          >
            <HugeiconsIcon
              icon={Alert02Icon}
              strokeWidth={2}
              className={cn(
                "mt-0.5 size-3.5 shrink-0",
                a.level === "error" ? "text-destructive" : a.level === "warning" ? "text-warning" : "text-info"
              )}
            />
            {a.text}
          </Link>
        ))}
        {d && d.alerts.length === 0 && <p className="p-2 text-sm text-muted-foreground">Nothing pending.</p>}
      </div>
    </Panel>
  )
}

function Capacity({ d }: { d: DashboardData | null }) {
  const k = d?.kpis
  const util = k?.bay_utilisation ?? 0
  const hours = k ? k.technician_hours_booked / Math.max(1, k.technician_hours_available) : 0
  const bar = (v: number, cls: string) => (
    <div className="mt-2 flex h-2 gap-[2px]">
      {Array.from({ length: 30 }, (_, i) => (
        <span key={i} className={cn("flex-1 rounded-[1px]", i < Math.round(v * 30) ? cls : "bg-foreground/[.07]")} />
      ))}
    </div>
  )
  return (
    <Panel title="Workshop capacity">
      <div className="space-y-4 text-sm">
        <div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Bays in use</span>
            <span className="num font-medium">{pct(util)}</span>
          </div>
          {bar(util, util > 0.85 ? "bg-destructive" : util > 0.6 ? "bg-warning" : "bg-foreground")}
        </div>
        <div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Technician hours</span>
            <span className="num font-medium">
              {k ? `${Math.round(k.technician_hours_booked)} / ${k.technician_hours_available} h` : "—"}
            </span>
          </div>
          {bar(hours, "bg-foreground")}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Link href="/pickups" className="rounded-lg border bg-muted/50 p-3 hover:bg-accent">
            <p className="caption text-[10px]">Pickup queue</p>
            <p className="num mt-1 text-lg font-medium">{k ? k.pickups_live + k.pickups_scheduled : "—"}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">{k ? `${k.pickups_scheduled} scheduled · ${k.pickups_live} active` : "Loading…"}</p>
          </Link>
          <div className="rounded-lg border bg-muted/50 p-3">
            <p className="caption text-[10px]">Follow-ups due</p>
            <p className="num mt-1 text-lg font-medium">{k?.follow_ups_due ?? "—"}</p>
          </div>
        </div>
      </div>
    </Panel>
  )
}

/** What the intelligent assists did for the outlet today, as operating numbers. */
function AssistsToday({ a }: { a: Assists | undefined }) {
  const { presenter } = useJourney()
  const rows: { uc: string; label: string; value: number | undefined; sub?: string }[] = [
    { uc: "1-2", label: "Customers scored for service due", value: a?.scored_for_service, sub: `${a?.outreach_sent ?? 0} reminders sent` },
    { uc: "3-4", label: "Bookings slotted by workshop load", value: a?.slots_booked, sub: `${a?.chauffeurs_matched ?? 0} chauffeurs matched` },
    { uc: "6, 8", label: "Gate-ins checked against records", value: a?.gate_ins, sub: `${a?.advisors_matched ?? 0} advisors matched` },
    { uc: "9-11", label: "Job cards drafted automatically", value: a?.estimates_built, sub: `${a?.concerns_for_review ?? 0} sent to advisor review` },
    { uc: "12", label: "Technician & bay allocations", value: a?.allocations, sub: "skill and load matched" },
  ]
  return (
    <Panel title="Done for you today" bodyClassName="p-0">
      <div className="divide-y">
        {rows.map((r) => (
          <div key={r.uc} className="flex items-center gap-3 px-4 py-2.5">
            <span className="num w-10 text-lg font-medium">{r.value ?? "—"}</span>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-[13px]">{r.label}</span>
              <span className="block truncate text-[11px] text-muted-foreground">{r.sub}</span>
            </span>
            {presenter && <span className="num rounded-full border px-1.5 text-[10px]">UC{r.uc}</span>}
          </div>
        ))}
      </div>
    </Panel>
  )
}

// ------------------------------------------------------------------ page

export function Dashboard() {
  const { data, refresh } = usePoll(() => erp.dashboard(), 20_000)
  const { data: board, refresh: refreshBoard } = usePoll(() => erp.board(), 15_000)
  const [ctx, setCtx] = React.useState<ErpContext | null>(null)
  const [resetting, setResetting] = React.useState(false)
  const { refresh: refreshJourney, setFocus } = useJourney()
  const cards = board ? allCards(board) : null

  React.useEffect(() => {
    erp.context().then(setCtx).catch(() => undefined)
  }, [])

  async function reset() {
    setResetting(true)
    try {
      await service.resetDemo()
      setFocus(null)
      await Promise.all([refresh(), refreshBoard()])
      refreshJourney()
      toast.success("Demo day reset: a fresh working day for the outlet")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not reset demo day")
    } finally {
      setResetting(false)
    }
  }

  return (
    <div>
      <Welcome ctx={ctx} cards={cards ?? []} onReset={reset} resetting={resetting} />
      <KpiRow d={data} />
      <FocusStrip />
      <div className="mb-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
        <FloorActivity cards={cards} />
        <StageFunnel d={data} cards={cards} />
      </div>
      <JourneyStrip d={data} />
      <LiveFloor cards={cards} />
      <div className="grid gap-4 lg:grid-cols-3">
        <Attention d={data} />
        <Capacity d={data} />
        <AssistsToday a={data?.assists} />
      </div>
    </div>
  )
}
