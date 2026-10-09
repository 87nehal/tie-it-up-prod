"use client"

// Step 6 · Workshop floor. The bays as the floor manager sees them (who is in which bay,
// with which technician, promised for when) and the flow in-bay -> quality check -> ready.
// Bay & technician allocation (use case 12) is shown as its outcome on every card.

import * as React from "react"
import Link from "next/link"
import { toast } from "sonner"

import { erp, type BoardCard, type Stage, type StaffView } from "@/lib/erp-api"
import { clock, inr } from "@/lib/format"
import { cn } from "@/lib/utils"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { clean, usePoll } from "@/components/erp/kit"
import { AssistChip, FollowButton, Plate, useJourney } from "@/components/erp/journey"

const FLOW: { key: Stage; label: string; hint: string; tone: string }[] = [
  { key: "in_progress", label: "In bay", hint: "Work under way", tone: "bg-foreground" },
  { key: "qc", label: "Quality check", hint: "Final inspection & road test", tone: "bg-info" },
  { key: "ready", label: "Ready for delivery", hint: "Hand over to billing", tone: "bg-success" },
]

function isOverdue(c: BoardCard, now: number) {
  return !!c.promised && c.stage !== "delivered" && c.stage !== "ready" && new Date(c.promised).getTime() < now
}

function promiseText(iso: string, now: number) {
  const mins = Math.round((new Date(iso).getTime() - now) / 60_000)
  if (mins < 0) {
    const late = -mins
    return late >= 60 ? `${Math.floor(late / 60)}h ${late % 60}m late` : `${late}m late`
  }
  return mins >= 60 ? `due in ${Math.floor(mins / 60)}h ${mins % 60}m` : `due in ${mins}m`
}

function useNow() {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(t)
  }, [])
  return now
}

function useDeepLinkVehicle() {
  const [v, setV] = React.useState<number | null>(null)
  React.useEffect(() => {
    const t = window.setTimeout(() => {
      setV(Number(new URLSearchParams(window.location.search).get("v")) || null)
    }, 0)
    return () => window.clearTimeout(t)
  }, [])
  return v
}

export function WorkshopBoard() {
  const { data, refresh } = usePoll(() => erp.board(), 3_000)
  const { data: staff } = usePoll<StaffView>(() => erp.staff(), 30_000)
  const { focusId, setFocus, refresh: refreshJourney } = useJourney()
  const deepLink = useDeepLinkVehicle()
  const now = useNow()
  const [q, setQ] = React.useState("")
  const [filter, setFilter] = React.useState<"all" | "overdue" | "mine">("all")
  const [passed, setPassed] = React.useState<Record<number, true>>({})
  const [busy, setBusy] = React.useState<number | null>(null)
  const [dragOver, setDragOver] = React.useState<number | null>(null)
  const [sim, setSim] = React.useState<{ reg: string; step: number; total: number } | null>(null)
  const simStop = React.useRef(false)

  const selected = deepLink ?? focusId
  const byStage = React.useMemo(() => {
    const m: Partial<Record<Stage, BoardCard[]>> = {}
    for (const s of data?.stages ?? []) m[s.key] = s.cards
    return m
  }, [data])
  const floor = FLOW.flatMap((f) => byStage[f.key] ?? [])
  const overdue = floor.filter((c) => isOverdue(c, now))
  const waitingRelease = byStage.approved?.length ?? 0

  const match = (c: BoardCard) => {
    if (filter === "overdue" && !isOverdue(c, now)) return false
    if (filter === "mine" && c.vehicle_id !== focusId) return false
    if (!q.trim()) return true
    return `${c.reg_no} ${c.reg_display} ${c.customer_name} ${c.model} ${c.technician ?? ""} ${c.bay ?? ""} JC-${c.job_card_id}`
      .toLowerCase()
      .includes(q.toLowerCase().trim())
  }

  // bays: who is physically in each bay (in-progress work)
  const bays = (staff?.bays ?? []).filter((b) => b.active)
  const inBay = byStage.in_progress ?? []
  const occupants = (name: string) => inBay.filter((c) => c.bay === name)
  const occupied = bays.filter((b) => occupants(b.name).length > 0).length
  const util = bays.length ? Math.round((occupied / bays.length) * 100) : 0
  const techsBusy = new Set(inBay.map((c) => c.technician).filter(Boolean)).size
  const techsOnDuty = staff?.technicians.filter((t) => t.on_duty).length ?? 0

  // scroll a deep-linked vehicle into view once
  const scrolled = React.useRef(false)
  React.useEffect(() => {
    if (!selected || !data || scrolled.current) return
    const el = document.getElementById(`wcard-${selected}`)
    if (el) {
      scrolled.current = true
      el.scrollIntoView({ block: "center", behavior: "smooth" })
    }
  }, [selected, data])

  async function moveTo(jcId: number, bayId: number) {
    const c = floor.find((x) => x.job_card_id === jcId)
    const target = bays.find((b) => b.id === bayId)
    if (!c || !target || c.bay === target.name) return
    setBusy(jcId)
    try {
      await erp.moveBay(jcId, bayId)
      toast.success(`${c.reg_display} moved to ${target.name}`)
      await refresh()
      refreshJourney()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  // Demo: take one car and pull it bay to bay so the floor visibly updates.
  async function simulate() {
    if (sim) {
      simStop.current = true
      return
    }
    const car = inBay.find((c) => c.vehicle_id === selected && c.job_card_id) ?? inBay.find((c) => c.job_card_id)
    if (!car?.job_card_id) {
      toast.error("No car in a bay to simulate with")
      return
    }
    const total = 5
    simStop.current = false
    setFocus(car.vehicle_id)
    try {
      for (let step = 1; step <= total && !simStop.current; step++) {
        setSim({ reg: car.reg_display, step, total })
        await new Promise((res) => window.setTimeout(res, 2000))
        if (simStop.current) break
        const wo = await erp.moveBay(car.job_card_id)
        const bay = (wo as { job_card?: { allocation?: { bay?: { name?: string } } } }).job_card?.allocation?.bay?.name
        toast(`${car.reg_display} → ${bay ?? "next bay"}`)
        await refresh()
        document.getElementById(`bay-car-${car.vehicle_id}`)?.scrollIntoView({ block: "center", behavior: "smooth" })
      }
      if (!simStop.current) toast.success(`Simulation done · ${car.reg_display} moved across ${total} bays`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setSim(null)
      refreshJourney()
    }
  }

  async function advance(c: BoardCard) {
    if (!c.job_card_id) return
    setBusy(c.job_card_id)
    setFocus(c.vehicle_id)
    try {
      await erp.advance(c.job_card_id)
      if (c.stage === "qc") {
        setPassed((p) => ({ ...p, [c.vehicle_id]: true }))
        toast.success(`${c.reg_display} passed QC · ready for delivery`)
      } else {
        toast.success(`${c.reg_display} sent to quality check`)
      }
      await refresh()
      refreshJourney()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      {/* summary + tools */}
      <div className="flex flex-wrap items-center gap-2">
        <Stat label="Bays occupied" value={`${occupied}/${bays.length || "–"}`} sub={`${util}% utilisation`} />
        <Stat label="Technicians working" value={`${techsBusy}/${techsOnDuty || "–"}`} sub="on duty today" />
        <Stat label="In quality check" value={byStage.qc?.length ?? "–"} />
        <Stat label="Ready to hand over" value={byStage.ready?.length ?? "–"} href="/billing" />
        <Stat label="Past promised time" value={overdue.length} tone={overdue.length ? "bad" : undefined} onClick={() => setFilter(filter === "overdue" ? "all" : "overdue")} active={filter === "overdue"} />
        {waitingRelease > 0 && (
          <Link href="/job-cards" className="rounded-xl border border-dashed px-3 py-2 text-xs text-muted-foreground hover:border-primary/40 hover:text-foreground">
            <span className="font-semibold text-foreground tabular-nums">{waitingRelease}</span> approved, waiting for release →
          </Link>
        )}
        <div className="ml-auto flex items-center gap-2">
          {focusId && (
            <button
              type="button"
              onClick={() => setFilter(filter === "mine" ? "all" : "mine")}
              className={cn("h-9 rounded-lg border px-3 text-xs font-medium", filter === "mine" ? "border-brand-red bg-brand-red text-white" : "hover:bg-muted")}
            >
              Followed vehicle only
            </button>
          )}
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search reg no, customer, technician, bay" className="w-72" />
        </div>
      </div>

      {/* bay view */}
      <section className="tray">
        <div className="tray-inner p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h3 className="caption">Bays right now</h3>
            <p className="text-xs text-muted-foreground">Each vehicle is placed in a bay with a technician whose skills fit the job card · drag a car or card onto a bay to move it</p>
          </div>
          <div className="flex items-center gap-3">
            {sim && (
              <span className="text-xs text-muted-foreground tabular-nums">
                Moving {sim.reg} · step {sim.step}/{sim.total}
              </span>
            )}
            <Button size="xs" variant={sim ? "destructive" : "outline"} onClick={() => void simulate()} disabled={!data || !staff}>
              {sim ? "Stop simulation" : "▶ Simulate"}
            </Button>
            <div className="h-2 w-40 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-foreground transition-all" style={{ width: `${util}%` }} />
            </div>
            <span className="num text-xs font-medium">{util}%</span>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {bays.map((b) => {
            const occ = occupants(b.name)
            const c = occ[0]
            const late = c && isOverdue(c, now)
            const sel = c && c.vehicle_id === selected
            return (
              <div
                key={b.id}
                id={c ? `bay-car-${c.vehicle_id}` : undefined}
                role="button"
                tabIndex={c ? 0 : -1}
                draggable={!!c?.job_card_id}
                onDragStart={(e) => c?.job_card_id && e.dataTransfer.setData("text/jc", String(c.job_card_id))}
                onDragOver={(e) => { e.preventDefault(); setDragOver(b.id) }}
                onDragLeave={() => setDragOver((d) => (d === b.id ? null : d))}
                onDrop={(e) => {
                  e.preventDefault()
                  setDragOver(null)
                  const jc = Number(e.dataTransfer.getData("text/jc"))
                  if (jc) void moveTo(jc, b.id)
                }}
                onClick={() => c && setFocus(c.vehicle_id)}
                className={cn(
                  c && "cursor-grab active:cursor-grabbing",
                  dragOver === b.id && "ring-2 ring-primary bg-primary/5",
                  sel && sim && "animate-pulse ring-2 ring-brand-red",
                  "relative flex min-h-[92px] flex-col rounded-xl border p-2.5 text-left transition-all",
                  c ? "card-lift bg-card" : "border-dashed bg-muted/30",
                  late && "border-brand-red/50 bg-brand-red/[.03]",
                  sel && "ring-2 ring-primary ring-offset-1"
                )}
              >
                <div className="flex items-center justify-between gap-1">
                  <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                    {b.name}
                    <span className="font-normal normal-case"> · {b.type}</span>
                  </span>
                  {c ? (
                    <span className={cn("size-2 rounded-full", late ? "bg-brand-red" : "bg-primary")} />
                  ) : (
                    <span className="text-[10px] font-medium text-success">Free</span>
                  )}
                </div>
                {c ? (
                  <>
                    <Plate reg={c.reg_display} size="sm" className="mt-1.5 self-start" />
                    <p className="mt-1 truncate text-xs font-medium">{c.technician ?? "Unassigned"}</p>
                    <p className={cn("text-[11px] tabular-nums", late ? "font-semibold text-brand-red" : "text-muted-foreground")}>
                      {c.promised ? `${clock(c.promised)} · ${promiseText(c.promised, now)}` : c.model}
                    </p>
                    {occ.length > 1 && (
                      <span className="absolute right-2 bottom-2 rounded bg-muted px-1 text-[10px] text-muted-foreground">+{occ.length - 1} next</span>
                    )}
                  </>
                ) : (
                  <p className="mt-auto text-[11px] text-muted-foreground">Available for the next release</p>
                )}
              </div>
            )
          })}
          {!staff && Array.from({ length: 12 }).map((_, i) => <div key={i} className="h-[92px] animate-pulse rounded-xl bg-muted" />)}
        </div>
        </div>
      </section>

      {/* flow */}
      <div className="grid gap-3 lg:grid-cols-3">
        {FLOW.map((f) => {
          const all = byStage[f.key] ?? []
          const cards = all.filter(match).sort((a, b) => {
            // overdue first, then by promise
            const la = isOverdue(a, now) ? 0 : 1
            const lb = isOverdue(b, now) ? 0 : 1
            if (la !== lb) return la - lb
            return (a.promised ?? "9").localeCompare(b.promised ?? "9")
          })
          return (
            <section key={f.key} className="tray flex flex-col">
              <div className="flex items-center justify-between gap-2 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className={cn("size-2 rounded-full", f.tone)} />
                  <h3 className="caption">{f.label}</h3>
                  <span className="num rounded-full border bg-card px-1.5 text-[11px]">{cards.length}{cards.length !== all.length && `/${all.length}`}</span>
                </div>
                <span className="text-[11px] text-muted-foreground">{f.hint}</span>
              </div>
              <div className="flex max-h-[34rem] flex-col gap-1.5 overflow-y-auto p-0.5">
                {cards.map((c) => (
                  <FloorCard
                    key={c.key}
                    card={c}
                    now={now}
                    selected={c.vehicle_id === selected}
                    passed={!!passed[c.vehicle_id]}
                    busy={busy === c.job_card_id}
                    onAdvance={() => advance(c)}
                    onSelect={() => setFocus(c.vehicle_id)}
                  />
                ))}
                {cards.length === 0 && <p className="px-2 py-8 text-center text-xs text-muted-foreground">{data ? "Nothing here for this view." : "Loading…"}</p>}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  sub,
  tone,
  href,
  onClick,
  active,
}: {
  label: string
  value: React.ReactNode
  sub?: string
  tone?: "bad"
  href?: string
  onClick?: () => void
  active?: boolean
}) {
  const body = (
    <>
      <span className={cn("num text-lg leading-none font-medium", tone === "bad" && "text-brand-red")}>{value}</span>
      <span className="text-[11px] leading-tight text-muted-foreground">
        {label}
        {sub && <span className="block">{sub}</span>}
      </span>
    </>
  )
  const cls = cn(
    "flex items-center gap-2.5 rounded-xl border bg-card px-3 py-2 text-left shadow-[0_1px_2px_rgba(0,0,0,.03)]",
    (href || onClick) && "hover:border-primary/40",
    active && "border-brand-red ring-1 ring-brand-red"
  )
  if (href) return <Link href={href} className={cls}>{body}</Link>
  if (onClick) return <button type="button" onClick={onClick} className={cls}>{body}</button>
  return <div className={cls}>{body}</div>
}

function FloorCard({
  card: c,
  now,
  selected,
  passed,
  busy,
  onAdvance,
  onSelect,
}: {
  card: BoardCard
  now: number
  selected: boolean
  passed: boolean
  busy: boolean
  onAdvance: () => void
  onSelect: () => void
}) {
  const late = isOverdue(c, now)
  return (
    <div
      id={`wcard-${c.vehicle_id}`}
      onClick={onSelect}
      draggable={c.stage === "in_progress" && !!c.job_card_id}
      onDragStart={(e) => c.job_card_id && e.dataTransfer.setData("text/jc", String(c.job_card_id))}
      className={cn(
        "cursor-pointer rounded-xl border bg-card p-3 transition-shadow hover:shadow-md",
        late && "border-l-4 border-l-brand-red",
        selected && "ring-2 ring-primary"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link href={`/vehicles/${c.vehicle_id}`} onClick={(e) => e.stopPropagation()} className="inline-block hover:opacity-80">
            <Plate reg={c.reg_display} size="sm" />
          </Link>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {c.model} · {c.customer_name}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {c.job_card_id && <span className="text-[11px] text-muted-foreground tabular-nums">JC-{c.job_card_id}</span>}
          <FollowButton vehicleId={c.vehicle_id} />
        </div>
      </div>

      {(c.technician || c.bay) && (
        <AssistChip uc={12} className="mt-2">
          Allocated: {[c.technician, c.bay, c.promised && `promised ${clock(c.promised)}`].filter(Boolean).join(" · ")}
        </AssistChip>
      )}

      <div className="mt-2 flex items-center justify-between gap-2">
        <span className={cn("text-[11px] tabular-nums", late ? "font-semibold text-brand-red" : "text-muted-foreground")}>
          {c.stage === "ready"
            ? `Ready · ${inr(c.amount ?? 0)} to bill`
            : c.promised
              ? `${late ? "Overdue" : "Promised"} ${clock(c.promised)} · ${promiseText(c.promised, now)}`
              : clean(c.detail)}
        </span>
        <span onClick={(e) => e.stopPropagation()}>
          {c.stage === "in_progress" && (
            <Button size="xs" variant="outline" disabled={busy} onClick={onAdvance}>
              {busy ? "Sending…" : "Send to QC"}
            </Button>
          )}
          {c.stage === "qc" && (
            <Button size="xs" disabled={busy} onClick={onAdvance}>
              {busy ? "Saving…" : "QC passed"}
            </Button>
          )}
          {c.stage === "ready" && !passed && (
            <Link href={`/billing?v=${c.vehicle_id}`} className={buttonVariants({ size: "xs", variant: "outline" })}>
              Bill & deliver
            </Link>
          )}
        </span>
      </div>

      {c.stage === "ready" && passed && (
        <Link
          href={`/billing?v=${c.vehicle_id}`}
          onClick={(e) => e.stopPropagation()}
          className="mt-2 flex items-center justify-between rounded-lg bg-success/10 px-3 py-2 text-xs font-semibold text-success hover:bg-success/15"
        >
          QC passed · Continue: Billing & delivery
          <span aria-hidden>→</span>
        </Link>
      )}
    </div>
  )
}
