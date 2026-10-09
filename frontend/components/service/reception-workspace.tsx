"use client"

import * as React from "react"
import Link from "next/link"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowRight01Icon,
  CheckmarkCircle02Icon,
  QrCodeIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons"
import { toast } from "sonner"

import type { GateCheck, GateEntry, Trip } from "@/lib/api"
import { clock, humanize } from "@/lib/format"
import {
  service,
  type AdvisorRanking,
  type ExpectedArrival,
  type Visit,
} from "@/lib/service-api"
import { cn } from "@/lib/utils"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { CheckList } from "@/components/common/check-list"
import { GateCapture } from "@/components/common/gate-capture"
import { PhotoSlot, urlToFile } from "@/components/common/photo-slot"
import { ConditionPanel } from "@/components/service/condition-panel"
import {
  AssistChip,
  FollowButton,
  Plate,
  useJourney,
} from "@/components/erp/journey"
import { useAsync } from "@/components/service/shared"

const WALKAROUND = ["Front", "Rear", "Left", "Right"] as const

const LANG: Record<string, string> = {
  en: "English",
  hi: "Hindi",
  ur: "Urdu",
  pa: "Punjabi",
  bn: "Bengali",
  gu: "Gujarati",
  mr: "Marathi",
  ta: "Tamil",
  te: "Telugu",
  kn: "Kannada",
  ml: "Malayalam",
}
const lang = (c: string) => LANG[c.toLowerCase()] ?? c

/** "HR51NY9785" -> "HR 51 NY 9785" */
function spaced(reg: string) {
  const m = reg.replace(/\s+/g, "").match(/^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{1,4})$/)
  return m ? [m[1], m[2], m[3], m[4]].filter(Boolean).join(" ") : reg
}

// ------------------------------------------------------------------ queue model

type Filter = "all" | "walkin" | "pickup" | "arrived"

type QueueItem = {
  key: string
  vehicleId: number
  reg: string
  model: string
  customer: string
  time: string
  pickup: boolean
  arrived: boolean
  note: string
  expected?: ExpectedArrival
  visit?: Visit
}

function queueFrom(expected: ExpectedArrival[], visits: Visit[]): QueueItem[] {
  const e: QueueItem[] = expected.map((x) => ({
    key: `e${x.id}`,
    vehicleId: x.vehicle_id,
    reg: x.reg_display,
    model: x.model,
    customer: x.customer_name,
    time: x.slot_start,
    pickup: x.mode === "pickup",
    arrived: false,
    note: x.trip_id
      ? "Chauffeur bringing it in"
      : x.mode === "pickup"
        ? `Pickup · ${humanize(x.status)}`
        : "Walk-in booking",
    expected: x,
  }))
  const v: QueueItem[] = visits.map((x) => ({
    key: `v${x.id}`,
    vehicleId: x.vehicle_id,
    reg: spaced(x.reg_no),
    model: x.model,
    customer: x.customer_name,
    time: x.arrived_at,
    pickup: Boolean(x.trip_id),
    arrived: true,
    note: x.advisor_name ? `With ${x.advisor_name}` : "Waiting for advisor",
    visit: x,
  }))
  return [...e, ...v]
}

function matches(i: QueueItem, f: Filter) {
  if (f === "arrived") return i.arrived
  if (f === "walkin") return !i.arrived && !i.pickup
  if (f === "pickup") return !i.arrived && i.pickup
  return true
}

/** What we know about a vehicle once it is through the gate. */
type Arrival = {
  visit: Visit
  checks: GateCheck[]
  advisors: AdvisorRanking | null
  trip: Trip | null
  walkIn: boolean
  labels: string[]
}

// ------------------------------------------------------------------ small pieces

function StepHead({
  n,
  title,
  state,
  aside,
}: {
  n: number
  title: string
  state: "done" | "current" | "todo"
  aside?: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold",
          state === "done" && "bg-success/15 text-success",
          state === "current" && "bg-primary text-primary-foreground",
          state === "todo" && "bg-muted text-muted-foreground"
        )}
      >
        {state === "done" ? (
          <HugeiconsIcon icon={CheckmarkCircle02Icon} strokeWidth={2.4} className="size-3.5" />
        ) : (
          n
        )}
      </span>
      <h3
        className={cn(
          "text-sm font-semibold",
          state === "todo" && "text-muted-foreground"
        )}
      >
        {title}
      </h3>
      {aside ? <div className="ml-auto">{aside}</div> : null}
    </div>
  )
}

function Step({
  children,
  last,
}: {
  children: React.ReactNode
  last?: boolean
}) {
  return (
    <div className={cn("space-y-3", !last && "border-b pb-5")}>{children}</div>
  )
}

function VehicleHeader({
  reg,
  model,
  customer,
  meta,
  vehicleId,
}: {
  reg: string
  model: string
  customer: string
  meta: React.ReactNode
  vehicleId?: number
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-4">
      <div className="space-y-1.5">
        <div className="flex items-center gap-3">
          <Plate reg={reg} size="lg" />
          <span className="text-base font-semibold">{model}</span>
        </div>
        <p className="text-sm text-muted-foreground">
          {customer} · {meta}
        </p>
      </div>
      {vehicleId ? <FollowButton vehicleId={vehicleId} /> : null}
    </div>
  )
}

// ------------------------------------------------------------------ advisor (UC8)

function AdvisorStep({
  arrival,
  busy,
  onAssign,
}: {
  arrival: Arrival
  busy: boolean
  onAssign: (id: number) => void
}) {
  const [why, setWhy] = React.useState(false)
  const [changing, setChanging] = React.useState(false)
  const r = arrival.advisors
  const v = arrival.visit
  const current = r?.advisors.find((a) => a.advisor_id === v.advisor_id)
  const custLang = r?.customer_language ?? v.language
  const traits = current
    ? [
        current.languages.some((l) => l.toLowerCase() === custLang.toLowerCase())
          ? `speaks ${current.languages.map(lang).slice(0, 2).join("/")}`
          : null,
        ...current.skills
          .filter((s) => r?.needs.includes(s) && s !== "general")
          .map((s) => `${humanize(s)} skill`),
        `${current.load_today} cars today`,
      ].filter(Boolean)
    : []
  const reasons = current
    ? Object.entries(current.breakdown)
        .filter(([, w]) => w > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([k]) => k)
    : []

  if (!v.advisor_id) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="size-3.5 animate-spin rounded-full border-2 border-primary/25 border-t-primary" />
        Matching an advisor…
      </p>
    )
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <AssistChip uc={8} className="text-xs">
          Advisor auto-assigned: {current?.name ?? v.advisor_name}
          {traits.length ? ` — ${traits.join(", ")}` : ""}
        </AssistChip>
        {r ? (
          <>
            <button
              type="button"
              onClick={() => setWhy((o) => !o)}
              className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {why ? "Hide" : "Why?"}
            </button>
            <button
              type="button"
              onClick={() => setChanging((o) => !o)}
              className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              {changing ? "Done" : "Change"}
            </button>
          </>
        ) : null}
      </div>
      {why && r ? (
        <div className="rounded-xl bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
          {current ? (
            <p>
              <span className="text-foreground">{current.name}</span>{" "}
              {reasons.length ? reasons.join(", ") : "was the best available fit"}
              . Customer prefers {lang(custLang)}; job needs{" "}
              {r.needs.map(humanize).join(", ")}.
            </p>
          ) : (
            <p>Assigned by reception.</p>
          )}
        </div>
      ) : null}
      {changing && r ? (
        <ul className="divide-y rounded-xl border text-sm">
          {r.advisors.slice(0, 6).map((a) => {
            const chosen = a.advisor_id === v.advisor_id
            return (
              <li
                key={a.advisor_id}
                className={cn(
                  "flex items-center gap-3 px-3 py-2",
                  chosen && "bg-accent/50"
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{a.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {a.languages.map(lang).join(", ")} ·{" "}
                    {a.skills.map(humanize).join(", ")}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {a.load_today}/{a.max_load} today
                </span>
                <Button
                  size="xs"
                  variant={chosen ? "secondary" : "outline"}
                  disabled={!a.available || busy || chosen}
                  onClick={() => {
                    onAssign(a.advisor_id)
                    setChanging(false)
                  }}
                >
                  {chosen ? "Assigned" : a.available ? "Assign" : "Full"}
                </Button>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}

// ------------------------------------------------------------------ arrived view

function ArrivedPanel({
  arrival,
  busy,
  onAssign,
}: {
  arrival: Arrival
  busy: boolean
  onAssign: (id: number) => void
}) {
  const v = arrival.visit
  const problems = arrival.checks.filter((c) => c.level !== "ok")
  const okCount = arrival.checks.length - problems.length
  const cond = v.condition
  const marks =
    cond?.status === "done"
      ? cond.images.reduce((n, im) => n + im.detections.length, 0)
      : 0
  const jobHref = v.job_card
    ? `/job-cards?jc=${v.job_card.id}`
    : `/job-cards?visit=${v.id}`

  return (
    <div className="space-y-5">
      <VehicleHeader
        reg={spaced(v.reg_no)}
        model={v.model}
        customer={v.customer_name}
        vehicleId={v.vehicle_id}
        meta={
          <>
            checked in{" "}
            <span className="tabular-nums">{clock(v.arrived_at)}</span>
            {arrival.trip
              ? ` · pickup trip closed, ${arrival.trip.distance_km} km`
              : arrival.walkIn
                ? " · walk-in, no booking"
                : ""}
          </>
        }
      />

      <Step>
        <StepHead n={1} title="Identify vehicle" state="done" />
        <div className="space-y-2 pl-8">
          {arrival.checks.length ? (
            <>
              <AssistChip uc={6} className="text-xs">
                {problems.length
                  ? `${okCount} of ${arrival.checks.length} checks passed against vehicle master`
                  : `Plate, VIN and odometer verified against vehicle master`}
              </AssistChip>
              <CheckList checks={arrival.checks} />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Gated in at {clock(v.arrived_at)}
              {v.odometer != null
                ? ` · odometer ${v.odometer.toLocaleString("en-IN")} km`
                : ""}
              .
            </p>
          )}
        </div>
      </Step>

      <Step>
        <StepHead
          n={2}
          title="Walk-around"
          state={cond?.status === "pending" ? "current" : "done"}
          aside={
            cond?.status === "done" && cond.available !== false ? (
              <AssistChip uc={7} className="text-xs">
                {marks
                  ? `${marks} damage mark${marks === 1 ? "" : "s"} recorded`
                  : "No damage found"}
              </AssistChip>
            ) : null
          }
        />
        <div className="pl-8">
          <ConditionPanel condition={cond} labels={arrival.labels} />
        </div>
      </Step>

      <Step last>
        <StepHead
          n={3}
          title="Service advisor"
          state={v.advisor_id ? "done" : "current"}
        />
        <div className="pl-8">
          <AdvisorStep arrival={arrival} busy={busy} onAssign={onAssign} />
        </div>
      </Step>

      {v.advisor_id ? (
        <Link
          href={jobHref}
          className={cn(buttonVariants({ size: "lg" }), "w-full")}
        >
          {v.job_card
            ? `Continue: Job card JC-${v.job_card.id}`
            : "Continue: Open job card"}
          <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} data-icon="inline-end" />
        </Link>
      ) : null}
    </div>
  )
}

// ------------------------------------------------------------------ check-in flow

function CheckInFlow({
  item,
  onCommit,
}: {
  item: QueueItem | null
  onCommit: (entry: GateEntry, files: File[], labels: string[]) => Promise<void>
}) {
  const [walk, setWalk] = React.useState<(File | null)[]>([null, null, null, null])
  const e = item?.expected

  async function demoWalkaround() {
    try {
      const [front, rear] = await Promise.all([
        urlToFile("/api/damage/file/sample/clean", "front.jpg"),
        urlToFile("/api/damage/file/sample/taillight_dent", "rear.jpg"),
      ])
      setWalk([front, rear, null, null])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Demo photos unavailable")
    }
  }

  const walkCount = walk.filter(Boolean).length

  return (
    <div className="space-y-5">
      {item ? (
        <VehicleHeader
          reg={item.reg}
          model={item.model}
          customer={item.customer}
          vehicleId={item.vehicleId}
          meta={
            e?.trip_id ? (
              "chauffeur pickup · odometer checked against the trip"
            ) : (
              <>
                booked <span className="tabular-nums">{clock(item.time)}</span>
                {item.pickup ? " · pickup" : " · walk-in"}
              </>
            )
          }
        />
      ) : (
        <div className="border-b pb-4">
          <p className="text-base font-semibold">Walk-in without booking</p>
          <p className="text-sm text-muted-foreground">
            Read the plate and the vehicle is looked up in the vehicle master.
          </p>
        </div>
      )}

      <Step>
        <StepHead n={1} title="Identify vehicle" state="current" />
        <GateCapture
          direction="checkin"
          walkIn
          variant="inline"
          assistUc={6}
          demoLabel="Use demo photos"
          checksTitle="Checked against vehicle master"
          confirmLabel="Check in vehicle"
          demoVehicleId={item?.vehicleId}
          onCommit={async (entry) => {
            const labels = WALKAROUND.filter((_, i) => walk[i])
            await onCommit(
              entry,
              walk.filter((f): f is File => Boolean(f)),
              [...labels]
            )
          }}
          beforeConfirm={
            <div className="space-y-3 border-t pt-5">
              <StepHead
                n={2}
                title="Walk-around"
                state={walkCount ? "done" : "current"}
                aside={
                  <Button size="xs" variant="outline" onClick={demoWalkaround}>
                    Use demo photos
                  </Button>
                }
              />
              <div className="grid max-w-2xl grid-cols-4 gap-2">
                {WALKAROUND.map((side, i) => (
                  <PhotoSlot
                    key={side}
                    label={side}
                    hint={`${side} of vehicle`}
                    file={walk[i]}
                    onChange={(f) =>
                      setWalk((w) => w.map((x, j) => (j === i ? f : x)))
                    }
                  />
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Damage is marked automatically after check-in, in the
                background.
              </p>
            </div>
          }
        />
      </Step>

      <Step last>
        <StepHead n={3} title="Service advisor" state="todo" />
        <p className="pl-8 text-sm text-muted-foreground">
          Matched automatically on check-in: language, skills and today&apos;s
          queue.
        </p>
      </Step>
    </div>
  )
}

// ------------------------------------------------------------------ workspace

export function ReceptionWorkspace() {
  const { setFocus, refresh, focusId } = useJourney()
  const [expected, setExpected] = React.useState<ExpectedArrival[]>([])
  const [visits, setVisits] = React.useState<Visit[]>([])
  const [loaded, setLoaded] = React.useState(false)
  const [selKey, setSelKey] = React.useState<string | null>(null)
  const [arrival, setArrival] = React.useState<Arrival | null>(null)
  const [filter, setFilter] = React.useState<Filter>("all")
  const [q, setQ] = React.useState("")
  const [qr, setQr] = React.useState("")
  const { busy, run } = useAsync()
  const picked = React.useRef(false)

  const load = React.useCallback(async () => {
    try {
      const [e, v] = await Promise.all([service.expected(), service.visits()])
      setExpected(e)
      setVisits(v)
      setLoaded(true)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load")
    }
  }, [])

  React.useEffect(() => {
    const t = window.setTimeout(load, 0)
    const id = window.setInterval(load, 30_000)
    return () => {
      window.clearTimeout(t)
      window.clearInterval(id)
    }
  }, [load])

  const queue = React.useMemo(() => {
    const all = queueFrom(expected, visits)
    return all.sort((a, b) =>
      a.arrived !== b.arrived
        ? a.arrived
          ? 1
          : -1
        : a.arrived
          ? b.time.localeCompare(a.time)
          : a.time.localeCompare(b.time)
    )
  }, [expected, visits])

  const openVisit = React.useCallback(async (visitId: number) => {
    try {
      const [v, adv] = await Promise.all([
        service.visit(visitId),
        service.advisors(visitId).catch(() => null),
      ])
      setArrival({
        visit: v,
        checks: v.gate_checks ?? [],
        advisors: adv,
        trip: null,
        walkIn: !v.appointment_id,
        labels: [],
      })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not open visit")
    }
  }, [])

  const select = React.useCallback(
    (i: QueueItem | null, follow = true) => {
      setSelKey(i?.key ?? "new")
      setArrival(null)
      if (i && follow) setFocus(i.vehicleId)
      if (i?.visit) void openVisit(i.visit.id)
    },
    [openVisit, setFocus]
  )

  // Deep link (?v=) / followed vehicle preselects; otherwise the next expected car.
  React.useEffect(() => {
    if (!loaded || picked.current) return

    const v = Number(new URLSearchParams(window.location.search).get("v")) || focusId
    const hit = v ? queue.find((i) => i.vehicleId === v) : undefined
    const first = hit ?? queue.find((i) => !i.arrived) ?? null
    const t = window.setTimeout(() => {
      picked.current = true
      if (first) select(first, false)
      else setSelKey("new")
    }, 0)
    return () => window.clearTimeout(t)
  }, [loaded, queue, focusId, select])

  // Condition assessment lands in the background; poll the visit until it does.
  const visitId = arrival?.visit.id
  const pending = arrival?.visit.condition?.status === "pending"
  React.useEffect(() => {
    if (!pending || !visitId) return
    const id = window.setInterval(async () => {
      try {
        const v = await service.visit(visitId)
        if (v.condition?.status !== "pending") {
          setArrival((a) =>
            a && a.visit.id === visitId
              ? { ...a, visit: { ...a.visit, condition: v.condition } }
              : a
          )
          refresh()
        }
      } catch {
        // keep polling
      }
    }, 4000)
    return () => window.clearInterval(id)
  }, [pending, visitId, refresh])

  async function scanPass() {
    try {
      const v = await service.lookupQr(qr)
      const hit = queue.find((i) => i.expected?.id === v.appointment.id)
      if (!hit) throw new Error(`${v.reg_display} is not expected today`)
      select(hit)
      setQr("")
      toast.success(`Service pass: ${hit.customer} · ${hit.reg}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Unknown pass")
    }
  }

  async function commit(entry: GateEntry, files: File[], labels: string[]) {
    const r = await run("checkin", () => service.checkIn(entry, files))
    let next: Arrival = {
      visit: r.visit,
      checks: r.validation.checks,
      advisors: r.advisors,
      trip: r.trip,
      walkIn: r.walk_in,
      labels,
    }
    setArrival(next)
    setSelKey(`v${r.visit.id}`)
    setFocus(r.visit.vehicle_id)
    toast.success(
      r.trip
        ? `${spaced(r.visit.reg_no)} checked in. Pickup trip closed (${r.trip.distance_km} km).`
        : `${spaced(r.visit.reg_no)} checked in`
    )
    // Advisor matching: the best available advisor is assigned straight away.
    if (!r.visit.advisor_id) {
      const best = r.advisors.advisors.find((a) => a.available)
      if (best) {
        try {
          const v = await service.assign(r.visit.id, best.advisor_id)
          next = {
            ...next,
            visit: { ...next.visit, advisor_id: v.advisor_id, advisor_name: v.advisor_name },
          }
          setArrival((a) => (a && a.visit.id === r.visit.id ? next : a))
        } catch {
          // reception can assign by hand
        }
      }
    }
    refresh()
    void load()
  }

  async function assign(advisorId: number) {
    if (!arrival) return
    try {
      const v = await run("assign", () =>
        service.assign(arrival.visit.id, advisorId)
      )
      setArrival((a) =>
        a
          ? { ...a, visit: { ...a.visit, advisor_id: v.advisor_id, advisor_name: v.advisor_name } }
          : a
      )
      toast.success(`Assigned to ${v.advisor_name}`)
      refresh()
      void load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed")
    }
  }

  const counts = {
    all: queue.length,
    walkin: queue.filter((i) => matches(i, "walkin")).length,
    pickup: queue.filter((i) => matches(i, "pickup")).length,
    arrived: queue.filter((i) => i.arrived).length,
  }
  const needle = q.trim().toLowerCase().replace(/\s+/g, "")
  const visible = queue.filter(
    (i) =>
      matches(i, filter) &&
      (!needle ||
        `${i.reg}${i.customer}${i.model}`
          .toLowerCase()
          .replace(/\s+/g, "")
          .includes(needle))
  )
  const selected = queue.find((i) => i.key === selKey) ?? null
  const chips: { key: Filter; label: string }[] = [
    { key: "all", label: "All" },
    { key: "walkin", label: "Walk-in" },
    { key: "pickup", label: "Pickup" },
    { key: "arrived", label: "Arrived" },
  ]

  return (
    <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
      <section className="flex flex-col rounded-xl border bg-card p-3 shadow-[0_1px_2px_rgba(0,0,0,.03)] lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)]">
        <div className="mb-2 flex items-baseline justify-between px-1">
          <h2 className="text-sm font-semibold">Arrivals today</h2>
          <span className="text-xs text-muted-foreground tabular-nums">
            {expected.length} still expected
          </span>
        </div>
        <div className="relative mb-2">
          <HugeiconsIcon
            icon={Search01Icon}
            strokeWidth={2}
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            aria-label="Find a vehicle"
            placeholder="Registration, customer or model"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="h-8 pl-8"
          />
        </div>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setFilter(c.key)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
                filter === c.key
                  ? "border-primary bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {c.label}
              <span className="tabular-nums opacity-80">{counts[c.key]}</span>
            </button>
          ))}
        </div>
        <div className="-mx-1 min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1">
          {visible.map((i) => (
            <button
              key={i.key}
              type="button"
              onClick={() => select(i)}
              className={cn(
                "grid w-full grid-cols-[3.25rem_minmax(0,1fr)] items-center gap-2 rounded-xl border px-2.5 py-2 text-left transition-colors",
                selKey === i.key
                  ? "border-primary/40 bg-accent/60 ring-1 ring-primary/20"
                  : "border-transparent hover:bg-muted/60",
                i.arrived && selKey !== i.key && "opacity-70"
              )}
            >
              <span className="text-xs font-semibold tabular-nums">
                {clock(i.time)}
              </span>
              <span className="min-w-0 space-y-0.5">
                <span className="flex items-center gap-2">
                  <Plate reg={i.reg} size="sm" />
                  {i.arrived ? (
                    <HugeiconsIcon
                      icon={CheckmarkCircle02Icon}
                      strokeWidth={2}
                      className="size-3.5 text-success"
                    />
                  ) : i.pickup ? (
                    <span className="rounded-full bg-accent px-1.5 text-[10px] font-medium text-primary">
                      Pickup
                    </span>
                  ) : null}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {i.customer} · {i.model} · {i.note}
                </span>
              </span>
            </button>
          ))}
          {!visible.length ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              {loaded ? "No vehicles match." : "Loading…"}
            </p>
          ) : null}
        </div>
        <div className="mt-2 space-y-2 border-t pt-3">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <HugeiconsIcon
                icon={QrCodeIcon}
                strokeWidth={2}
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                placeholder="Scan service pass (DSP-…)"
                value={qr}
                onChange={(e) => setQr(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === "Enter" && qr && scanPass()}
                className="h-8 pl-8"
              />
            </div>
            <Button size="sm" variant="outline" disabled={!qr} onClick={scanPass}>
              Scan
            </Button>
          </div>
          <Button
            size="sm"
            variant={selKey === "new" ? "secondary" : "ghost"}
            className="w-full"
            onClick={() => select(null)}
          >
            Walk-in without booking
          </Button>
        </div>
      </section>

      <section className="rounded-xl border bg-card p-5 shadow-[0_1px_2px_rgba(0,0,0,.03)]">
        {arrival ? (
          <ArrivedPanel arrival={arrival} busy={busy !== null} onAssign={assign} />
        ) : selected?.arrived ? (
          <p className="py-16 text-center text-sm text-muted-foreground">Loading visit…</p>
        ) : selKey ? (
          <CheckInFlow key={selKey} item={selected} onCommit={commit} />
        ) : (
          <p className="py-16 text-center text-sm text-muted-foreground">
            Select an arriving vehicle to check it in.
          </p>
        )}
      </section>
    </div>
  )
}
