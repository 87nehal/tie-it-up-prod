"use client"

import * as React from "react"
import Link from "next/link"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowRight01Icon,
  Search01Icon,
  PlayIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons"
import { toast } from "sonner"

import type { GateEntry } from "@/lib/api"
import { clock, humanize } from "@/lib/format"
import {
  service,
  type DriverRanking,
  type PickupBoard,
  type PickupStatus,
  type VehicleOption,
} from "@/lib/service-api"
import { cn } from "@/lib/utils"
import { subscribeDataChange } from "@/lib/demo-sync"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { GateCapture } from "@/components/common/gate-capture"
import { RouteMap, type MapPoint } from "@/components/common/route-map"
import {
  AssistChip,
  FollowButton,
  Plate,
  useJourney,
} from "@/components/erp/journey"
import { useAsync } from "@/components/service/shared"

// ------------------------------------------------------------------ vocabulary

type Filter = "all" | "road" | "risk" | "gate" | "scheduled"

const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "road", label: "On the road" },
  { key: "risk", label: "Delay risk" },
  { key: "gate", label: "At workshop" },
  { key: "scheduled", label: "Scheduled" },
]

const RISKY = ["at_risk", "late", "no_signal"]

/** "HR51NY9785" -> "HR 51 NY 9785" */
function spaced(reg: string) {
  const m = reg
    .replace(/\s+/g, "")
    .match(/^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{1,4})$/)
  return m ? [m[1], m[2], m[3], m[4]].filter(Boolean).join(" ") : reg
}

function matches(p: PickupStatus, f: Filter) {
  switch (f) {
    case "road":
      return ["en_route", "at_customer", "collected"].includes(p.status)
    case "risk":
      return RISKY.includes(p.risk)
    case "gate":
      return p.status === "at_gate"
    case "scheduled":
      return p.status === "booked"
    default:
      return true
  }
}

const RISK_TONE: Record<string, MapPoint["tone"]> = {
  on_time: "ok",
  at_risk: "warn",
  late: "bad",
  no_signal: "bad",
  not_started: "idle",
}

const STATUS_LABEL: Record<string, string> = {
  booked: "Scheduled",
  en_route: "Chauffeur on the way",
  at_customer: "At customer",
  collected: "Driving to workshop",
  at_gate: "At workshop gate",
}

const TRACK = [
  { key: "booked", label: "Assigned" },
  { key: "en_route", label: "To customer" },
  { key: "at_customer", label: "Handover" },
  { key: "collected", label: "To workshop" },
  { key: "at_gate", label: "At gate" },
]

function trackIndex(status: string) {
  const i = TRACK.findIndex((t) => t.key === status)
  return i < 0 ? TRACK.length - 1 : i
}

function RiskPill({ p }: { p: PickupStatus }) {
  if (p.risk === "not_started") return null
  const late = (p.buffer_min ?? 0) < 0
  const text =
    p.risk === "no_signal"
      ? "No GPS signal"
      : p.risk === "on_time"
        ? "On time"
        : late
          ? `${-(p.buffer_min ?? 0)} min late`
          : "At risk"
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
        p.risk === "on_time" && "bg-success/10 text-success",
        p.risk === "at_risk" && "bg-warning/15 text-warning",
        (p.risk === "late" || p.risk === "no_signal") &&
          "bg-destructive/10 text-destructive"
      )}
    >
      {text}
    </span>
  )
}

/** Plain-language ETA outcome (UC5): where the car is headed and when it gets there. */
function etaOutcome(p: PickupStatus) {
  if (!p.eta) return null
  const spare = p.buffer_min ?? 0
  const where = p.leg === "to_customer" ? "At customer" : "At workshop"
  const slack =
    spare < 0 ? `${-spare} min behind promise` : `${spare} min to spare`
  return `${where} ${clock(p.eta)} · ${slack}`
}

// ------------------------------------------------------------------ list row

function PickupRow({
  p,
  selected,
  onSelect,
}: {
  p: PickupStatus
  selected: boolean
  onSelect: () => void
}) {
  const eta = p.eta ? clock(p.eta) : null
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "grid w-full grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
        selected
          ? "border-primary/40 bg-accent/60 ring-1 ring-primary/20"
          : "border-transparent hover:bg-muted/60"
      )}
    >
      <span className="text-sm font-semibold whitespace-nowrap tabular-nums">
        <span className="block text-[11px] font-normal text-muted-foreground">{new Date(p.promised_pickup).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</span>
        {clock(p.promised_pickup)}
      </span>
      <span className="min-w-0 space-y-1">
        <span className="flex items-center gap-2">
          <Plate reg={spaced(p.reg_no)} size="sm" />
          <span className="truncate text-sm font-medium">
            {p.customer_name}
          </span>
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {p.driver_name ? `${p.driver_name} · ` : "Unassigned · "}
          {STATUS_LABEL[p.status] ?? humanize(p.status)}
        </span>
      </span>
      <span className="flex flex-col items-end gap-1">
        <RiskPill p={p} />
        {eta ? (
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {p.leg === "to_customer" ? "Customer" : "Workshop"} {eta}
          </span>
        ) : null}
      </span>
    </button>
  )
}

// ------------------------------------------------------------------ detail

function ChauffeurOutcome({
  p,
  vehicle,
  now,
}: {
  p: PickupStatus
  vehicle: VehicleOption | undefined
  now: string
}) {
  const [open, setOpen] = React.useState(false)
  const [rank, setRank] = React.useState<DriverRanking | null>(null)
  const [failed, setFailed] = React.useState(false)

  // Fetched quietly: the outcome uses rating and first-leg ETA; the ranking
  // itself only appears behind "Why?".
  React.useEffect(() => {
    if (rank || !vehicle || !p.driver_id) return
    let live = true
    service
      .rankDrivers(vehicle.id, p.promised_pickup)
      .then((r) => live && setRank(r))
      .catch(() => live && setFailed(true))
    return () => {
      live = false
    }
  }, [rank, vehicle, p.driver_id, p.promised_pickup])

  if (!p.driver_name) {
    return (
      <p className="text-sm text-muted-foreground">
        No chauffeur free for this slot yet. One is auto-assigned as soon as
        one frees up.
      </p>
    )
  }
  const me = rank?.drivers.find((d) => d.driver_id === p.driver_id)
  const etaMin =
    p.leg === "to_customer" && p.eta
      ? Math.max(
          0,
          Math.round((new Date(p.eta).getTime() - new Date(now).getTime()) / 60_000)
        )
      : me?.eta_to_customer_min
  const bits = [
    `Auto-assigned ${p.driver_name}`,
    me ? `${me.rating.toFixed(1)}★` : null,
    p.status === "booked" || p.status === "en_route"
      ? etaMin != null
        ? `ETA to customer ${etaMin} min`
        : null
      : null,
  ].filter(Boolean)
  const others = (rank?.drivers ?? [])
    .filter((d) => d.eligible && d.driver_id !== p.driver_id)
    .slice(0, 2)
  const eligible = rank?.drivers.filter((d) => d.eligible).length ?? 0

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <AssistChip uc={4} className="text-xs">
          {bits.join(" · ")}
        </AssistChip>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {open ? "Hide" : "Why?"}
        </button>
      </div>
      {open ? (
        <div className="rounded-xl bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
          {failed ? (
            <p>Reasoning is unavailable right now.</p>
          ) : !rank ? (
            <p>Loading…</p>
          ) : (
            <div className="space-y-1.5">
              <p>
                {eligible > 1
                  ? `Chosen from ${eligible} free chauffeurs`
                  : "Chosen"}{" "}
                on distance to the customer, trips already done today, how
                often they accept, and customer rating.
              </p>
              {me ? (
                <p className="text-foreground">
                  {p.driver_name}: {me.distance_km} km away · {me.trips_today}{" "}
                  trips today · accepts {Math.round(me.acceptance_rate * 100)}%
                </p>
              ) : null}
              {others.length ? (
                <p>
                  Next best:{" "}
                  {others
                    .map(
                      (d) =>
                        `${d.name} (${d.distance_km} km, ${d.rating.toFixed(1)}★)`
                    )
                    .join(", ")}
                </p>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

function TripTracker({ status }: { status: string }) {
  const at = trackIndex(status)
  return (
    <ol className="grid grid-cols-5 gap-1">
      {TRACK.map((t, i) => (
        <li key={t.key} className="space-y-1.5">
          <span
            className={cn(
              "block h-1.5 rounded-full",
              i < at ? "bg-primary" : i === at ? "bg-brand-red" : "bg-muted"
            )}
          />
          <span
            className={cn(
              "block text-[11px] leading-tight",
              i === at ? "font-semibold text-foreground" : "text-muted-foreground"
            )}
          >
            {t.label}
          </span>
        </li>
      ))}
    </ol>
  )
}

function TripDetail({
  p,
  vehicle,
  busy,
  now,
  onDispatch,
  onHandover,
}: {
  p: PickupStatus
  vehicle: VehicleOption | undefined
  busy: boolean
  now: string
  onDispatch: () => void
  onHandover: () => void
}) {
  const eta = etaOutcome(p)
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Plate reg={spaced(p.reg_no)} size="md" />
            {vehicle ? (
              <span className="text-sm font-semibold">{vehicle.model}</span>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">
            {p.customer_name}
            {vehicle?.locality ? ` · ${vehicle.locality}` : ""} · pickup{" "}
            <span className="tabular-nums">{clock(p.promised_pickup)}</span>
          </p>
        </div>
        {vehicle ? <FollowButton vehicleId={vehicle.id} /> : null}
      </div>

      <TripTracker status={p.status} />

      <section className="space-y-1.5">
        <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          Chauffeur
        </h3>
        <ChauffeurOutcome key={p.appointment_id} p={p} vehicle={vehicle} now={now} />
      </section>

      <section className="space-y-1.5">
        <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          Live ETA
        </h3>
        {eta ? (
          <div className="flex flex-wrap items-center gap-2">
            <AssistChip uc={5} className="text-xs">
              {eta}
            </AssistChip>
            <RiskPill p={p} />
            {p.remaining_km != null ? (
              <span className="text-xs text-muted-foreground tabular-nums">
                {p.remaining_km} km to go
              </span>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {p.status === "booked"
              ? "Tracking starts when the chauffeur is dispatched."
              : p.status === "at_gate"
                ? "Trip complete. The car is at the workshop gate."
                : "Waiting for the next position."}
          </p>
        )}
        {p.interventions.length ? (
          <ul className="mt-2 space-y-1 rounded-xl border border-warning/30 bg-warning/5 px-3 py-2 text-xs">
            {p.interventions.map((t) => (
              <li key={t} className="flex gap-2">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-warning" />
                {t}
              </li>
            ))}
          </ul>
        ) : null}
        {p.last_ping ? (
          <p className="text-[11px] text-muted-foreground">
            Last GPS ping {clock(p.last_ping)}
          </p>
        ) : null}
      </section>

      <div className="space-y-2 border-t pt-4">
        {p.status === "booked" ? (
          <Button
            className="w-full"
            disabled={busy || !p.driver_id}
            onClick={onDispatch}
          >
            Dispatch {p.driver_name?.split(" ")[0] ?? "chauffeur"}
          </Button>
        ) : null}
        {p.status === "en_route" || p.status === "at_customer" ? (
          <Button className="w-full" disabled={busy} onClick={onHandover}>
            Capture handover at customer
          </Button>
        ) : null}
        {p.status === "at_gate" || p.status === "collected" ? (
          vehicle ? (
            <Link
              href={`/reception?v=${vehicle.id}`}
              className={cn(
                buttonVariants({
                  variant: p.status === "at_gate" ? "default" : "outline",
                }),
                "w-full"
              )}
            >
              {p.status === "at_gate"
                ? "Vehicle reached workshop → Check in"
                : "Check in when it reaches the gate"}
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                strokeWidth={2}
                data-icon="inline-end"
              />
            </Link>
          ) : null
        ) : null}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ workspace

export function PickupsWorkspace() {
  const { setFocus, refresh, focusId } = useJourney()
  const [board, setBoard] = React.useState<PickupBoard | null>(null)
  const [vehicles, setVehicles] = React.useState<Record<string, VehicleOption>>(
    {}
  )
  const [selectedId, setSelectedId] = React.useState<number | null>(null)
  const [filter, setFilter] = React.useState<Filter>("all")
  const [q, setQ] = React.useState("")
  const [handover, setHandover] = React.useState<PickupStatus | null>(null)
  const { busy, run } = useAsync()
  const [linkedVehicle, setLinkedVehicle] = React.useState<number | null>(null)

  const load = React.useCallback(async () => {
    try {
      setBoard(await service.pickups())
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load")
    }
  }, [])

  React.useEffect(() => {
    const first = window.setTimeout(load, 0)
    const id = window.setInterval(load, 15_000)
    const unsubscribe = subscribeDataChange(() => { void load() })
    return () => {
      unsubscribe()
      window.clearTimeout(first)
      window.clearInterval(id)
    }
  }, [load])

  // Resolve each booked registration to its vehicle (model, home location, id).
  const items = React.useMemo(
    () =>
      [...(board?.pickups ?? [])].sort((a, b) =>
        a.promised_pickup.localeCompare(b.promised_pickup)
      ),
    [board]
  )
  React.useEffect(() => {
    const missing = items
      .map((p) => p.reg_no)
      .filter((r) => !(r in vehicles))
    if (!missing.length) return
    let live = true
    Promise.all(
      missing.map((r) =>
        service
          .vehicles(r)
          .then((vs) => [r, vs.find((v) => v.reg_no === r) ?? vs[0]] as const)
          .catch(() => [r, undefined] as const)
      )
    ).then((pairs) => {
      if (!live) return
      setVehicles((cur) => {
        const next = { ...cur }
        for (const [r, v] of pairs) if (v) next[r] = v
        return next
      })
    })
    return () => {
      live = false
    }
  }, [items, vehicles])

  // Deep link (?v=) is read once on mount (client only).
  React.useEffect(() => {
    const t = window.setTimeout(() => {
      const v = Number(new URLSearchParams(window.location.search).get("v"))
      if (v) setLinkedVehicle(v)
    }, 0)
    return () => window.clearTimeout(t)
  }, [])

  // Selection: the user's pick, else the deep-linked / followed vehicle's trip,
  // else the most urgent one.
  const byVehicle = (id: number | null) =>
    id ? items.find((p) => p.vehicle_id === id) : undefined
  const effectiveId =
    (selectedId != null && items.some((p) => p.appointment_id === selectedId)
      ? selectedId
      : null) ??
    (byVehicle(linkedVehicle) ?? byVehicle(focusId))?.appointment_id ??
    (
      items.find((p) => RISKY.includes(p.risk)) ??
      items.find((p) => p.status === "at_gate") ??
      items[0]
    )?.appointment_id ??
    null

  function select(p: PickupStatus) {
    setSelectedId(p.appointment_id)
    const v = vehicles[p.reg_no]
    if (v) setFocus(v.id)
  }

  async function dispatch(p: PickupStatus) {
    try {
      setBoard(await run("dispatch", () => service.dispatch(p.appointment_id)))
      const v = vehicles[p.reg_no]
      if (v) setFocus(v.id)
      refresh()
      toast.success(`${p.driver_name ?? "Chauffeur"} dispatched to ${p.customer_name}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed")
    }
  }

  async function commitHandover(entry: GateEntry) {
    if (!handover) return
    const r = await service.handover(handover.appointment_id, entry)
    setBoard(r.board)
    const v = vehicles[handover.reg_no]
    if (v) setFocus(v.id)
    refresh()
    setHandover(null)
    toast.success(
      `${r.trip.plate_display} collected at ${r.trip.checkout_odo.toLocaleString()} km. Heading to the workshop.`
    )
  }

  async function simulate(minutes: number) {
    try {
      setBoard(await run("sim", () => service.simulate(minutes)))
      refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed")
    }
  }

  const counts = Object.fromEntries(
    FILTERS.map((f) => [f.key, items.filter((p) => matches(p, f.key)).length])
  ) as Record<Filter, number>
  const needle = q.trim().toLowerCase().replace(/\s+/g, "")
  const visible = items.filter(
    (p) =>
      matches(p, filter) &&
      (!needle ||
        `${p.reg_no}${p.customer_name}${p.driver_name ?? ""}`
          .toLowerCase()
          .replace(/\s+/g, "")
          .includes(needle))
  )
  const selected = items.find((p) => p.appointment_id === effectiveId) ?? null

  const live = items.filter((p) => p.position)
  const points: MapPoint[] = []
  const legs: [string, string][] = []
  if (board) {
    points.push({
      id: "workshop",
      kind: "anchor",
      label: "Workshop",
      lat: board.dealership.lat,
      lng: board.dealership.lng,
    })
    for (const p of live) {
      const id = String(p.appointment_id)
      points.push({
        id,
        lat: p.position!.lat,
        lng: p.position!.lng,
        label: `${p.driver_name?.split(" ")[0] ?? ""} · ${p.reg_no.slice(-4)}`,
        tone: RISK_TONE[p.risk],
      })
      const v = vehicles[p.reg_no]
      if (p.leg === "to_customer" && v) {
        points.push({
          id: `c${id}`,
          kind: "customer",
          lat: v.lat,
          lng: v.lng,
          label: p.customer_name.split(" ")[0],
        })
        legs.push([id, `c${id}`])
      } else {
        legs.push([id, "workshop"])
      }
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                filter === f.key
                  ? "border-primary bg-primary text-primary-foreground"
                  : "bg-card text-muted-foreground hover:text-foreground",
                f.key === "risk" &&
                  counts.risk > 0 &&
                  filter !== f.key &&
                  "border-destructive/30 text-destructive"
              )}
            >
              {f.label}
              <span className="tabular-nums opacity-80">{counts[f.key]}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {board ? `Updated ${clock(board.generated_at)}` : "Loading…"}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={load}
            disabled={busy !== null}
            title="Refresh"
          >
            <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
            <span className="sr-only">Refresh</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => simulate(5)}
            disabled={busy !== null}
            title="Demo: move the clock forward"
          >
            <HugeiconsIcon
              icon={PlayIcon}
              strokeWidth={2}
              data-icon="inline-start"
            />
            +5 min
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => simulate(15)}
            disabled={busy !== null}
            title="Demo: move the clock forward"
          >
            +15 min
          </Button>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <section className="rounded-xl border bg-card p-3 shadow-[0_1px_2px_rgba(0,0,0,.03)]">
          <div className="mb-2 flex items-center gap-2 px-1">
            <div className="relative flex-1">
              <HugeiconsIcon
                icon={Search01Icon}
                strokeWidth={2}
                className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                type="search"
                aria-label="Find a pickup"
                placeholder="Registration, customer or chauffeur"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="h-8 pl-8"
              />
            </div>
            <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
              {visible.length} of {items.length}
            </span>
          </div>
          <div className="max-h-[calc(100vh-18rem)] space-y-1 overflow-y-auto">
            {visible.map((p) => (
              <PickupRow
                key={p.appointment_id}
                p={p}
                selected={p.appointment_id === effectiveId}
                onSelect={() => select(p)}
              />
            ))}
            {!visible.length ? (
              <p className="px-3 py-10 text-center text-sm text-muted-foreground">
                {items.length
                  ? "No pickups match this filter."
                  : "No scheduled or active chauffeur pickups."}
              </p>
            ) : null}
          </div>
        </section>

        <div className="grid content-start gap-4 lg:grid-cols-2 xl:grid-cols-1">
          <section className="rounded-xl border bg-card p-4 shadow-[0_1px_2px_rgba(0,0,0,.03)]">
            {selected ? (
              <TripDetail
                p={selected}
                vehicle={vehicles[selected.reg_no]}
                busy={busy !== null}
                now={board?.generated_at ?? selected.promised_pickup}
                onDispatch={() => dispatch(selected)}
                onHandover={() => setHandover(selected)}
              />
            ) : (
              <p className="py-10 text-center text-sm text-muted-foreground">
                Select a pickup to see its chauffeur and live ETA.
              </p>
            )}
          </section>
          <section className="rounded-xl border bg-card p-4 shadow-[0_1px_2px_rgba(0,0,0,.03)]">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Live positions</h3>
              <span className="flex items-center gap-3 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <span className="size-2 rounded-full bg-emerald-500" /> On time
                </span>
                <span className="flex items-center gap-1">
                  <span className="size-2 rounded-full bg-amber-500" /> At risk
                </span>
                <span className="flex items-center gap-1">
                  <span className="size-2 rounded-full bg-destructive" /> Late
                </span>
              </span>
            </div>
            {points.length > 1 ? (
              <RouteMap
                className="aspect-[16/10]"
                points={points}
                legs={legs}
                selectedId={selected?.position ? String(selected.appointment_id) : null}
                onSelect={(id) => {
                  const p = items.find((x) => String(x.appointment_id) === id)
                  if (p) select(p)
                }}
              />
            ) : (
              <p className="py-10 text-center text-sm text-muted-foreground">
                No chauffeurs on the road right now.
              </p>
            )}
          </section>
        </div>
      </div>

      <Sheet
        open={handover !== null}
        onOpenChange={(open) => !open && setHandover(null)}
      >
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              Handover
              {handover ? <Plate reg={spaced(handover.reg_no)} size="sm" /> : null}
            </SheetTitle>
            <p className="text-xs text-muted-foreground">
              {handover?.customer_name} hands over the car. Photos of plate,
              VIN and odometer open the trip log.
            </p>
          </SheetHeader>
          <div className="px-4 pb-6">
            {handover ? (
              <GateCapture
                key={handover.appointment_id}
                direction="checkout"
                variant="inline"
                confirmLabel="Confirm handover"
                demoLabel="Use demo photos"
                demoVehicleId={vehicles[handover.reg_no]?.id ?? null}
                onCommit={commitHandover}
              />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}
