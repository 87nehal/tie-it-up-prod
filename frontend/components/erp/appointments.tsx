"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"

import { ai, erp, type AiDecision, type BookingResult, type CustomerRow, type Journey, type SlotOption } from "@/lib/erp-api"
import { service, type Appointment } from "@/lib/service-api"
import { clock, todayIso } from "@/lib/format"
import { cn } from "@/lib/utils"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { usePoll } from "@/components/erp/kit"
import { AssistChip, Plate, useJourney } from "@/components/erp/journey"

type Slot = SlotOption & { expected_load?: number; utilisation?: number; off_peak?: boolean }
type SlotDay = { date: string; capacity_per_hour?: number; preferred_time?: string | null; slots: Slot[] }

const HOURS = Array.from({ length: 11 }, (_, i) => i + 8) // 8:00 .. 18:00
const DEFAULT_CAP = 14

const STATUS: Record<string, { label: string; cls: string }> = {
  booked: { label: "Booked", cls: "bg-muted text-muted-foreground" },
  en_route: { label: "Driver on the way", cls: "bg-accent text-primary" },
  collected: { label: "Car inbound", cls: "bg-accent text-primary" },
  at_gate: { label: "At gate", cls: "bg-warning/10 text-warning" },
  arrived: { label: "Arrived", cls: "bg-success/10 text-success" },
  cancelled: { label: "Cancelled", cls: "bg-muted text-muted-foreground line-through" },
}

export function regDisplay(reg: string) {
  const m = reg.replace(/\s+/g, "").toUpperCase().match(/^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{1,4})$/)
  return m ? [m[1], m[2], m[3], m[4]].filter(Boolean).join(" ") : reg
}

function hourLabel(h: number) {
  return `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? "am" : "pm"}`
}

function dayLabel(iso: string) {
  if (iso === todayIso()) return "Today"
  if (iso === todayIso(1)) return "Tomorrow"
  return new Date(iso + "T00:00:00").toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })
}

function loadTone(ratio: number) {
  if (ratio > 1) return "bg-brand-red/80"
  if (ratio >= 0.8) return "bg-warning"
  return "bg-primary"
}

const card = "rounded-xl border bg-card shadow-[0_1px_2px_rgba(0,0,0,.03)]"

// ------------------------------------------------------------------ diary

function LoadStrip({ counts, cap, onPick, picked }: { counts: Record<number, number>; cap: number; onPick?: (h: number) => void; picked?: number | null }) {
  return (
    <div className="flex items-end gap-1.5">
      {HOURS.map((h) => {
        const n = counts[h] ?? 0
        const ratio = n / cap
        return (
          <button
            key={h}
            type="button"
            onClick={() => onPick?.(h)}
            title={`${hourLabel(h)}: ${n} booked of ${cap}`}
            className={cn("group flex flex-1 flex-col items-center gap-1 rounded-lg p-1 transition-colors hover:bg-muted", picked === h && "bg-muted")}
          >
            <span className="text-[10px] font-medium text-muted-foreground tabular-nums">{n}</span>
            <span className="relative h-14 w-full overflow-hidden rounded-md bg-muted">
              <span className={cn("absolute inset-x-0 bottom-0 rounded-md", loadTone(ratio))} style={{ height: `${Math.min(ratio, 1) * 100}%` }} />
            </span>
            <span className="text-[10px] text-muted-foreground">{hourLabel(h)}</span>
          </button>
        )
      })}
    </div>
  )
}

type Filter = "all" | "pickup" | "walkin" | "waiting" | "arrived"

export function AppointmentsDiary() {
  const params = useSearchParams()
  const router = useRouter()
  const { setFocus, refresh, focusId } = useJourney()
  const urlBook = Number(params.get("book")) || null
  const urlV = Number(params.get("v") || params.get("vehicle")) || null

  const [day, setDay] = React.useState(todayIso(urlBook ? 1 : 0))
  const appts = usePoll(() => service.appointments(day), 20_000)
  const decisions = usePoll(() => ai.decisions("advisor"), 30_000)
  React.useEffect(() => { void appts.refresh() }, [day]) // eslint-disable-line react-hooks/exhaustive-deps

  const [q, setQ] = React.useState("")
  const [filter, setFilter] = React.useState<Filter>("all")
  const [hour, setHour] = React.useState<number | null>(null)
  const [booking, setBooking] = React.useState<number | null>(urlBook)
  const [picker, setPicker] = React.useState(false)
  const selected = urlV ?? focusId

  React.useEffect(() => {
    if (urlBook) {
      const t = window.setTimeout(() => setBooking(urlBook), 0)
      return () => window.clearTimeout(t)
    }
  }, [urlBook])

  const advisorBy = React.useMemo(() => {
    const m = new Map<number, string>()
    for (const d of decisions.data ?? []) if (d.appointment_id && d.chosen_name && !m.has(d.appointment_id)) m.set(d.appointment_id, d.chosen_name)
    return m
  }, [decisions.data])

  const rows = React.useMemo(
    () => [...(appts.data ?? [])].filter((a) => a.status !== "cancelled").sort((a, b) => a.slot_start.localeCompare(b.slot_start)),
    [appts.data]
  )
  const hourCounts = React.useMemo(() => {
    const c: Record<number, number> = {}
    for (const a of rows) {
      const h = new Date(a.slot_start).getHours()
      c[h] = (c[h] ?? 0) + 1
    }
    return c
  }, [rows])

  const tests: Record<Filter, (a: Appointment) => boolean> = {
    all: () => true,
    pickup: (a) => a.mode === "pickup",
    walkin: (a) => a.mode === "walkin",
    waiting: (a) => a.status !== "arrived",
    arrived: (a) => a.status === "arrived",
  }
  const needle = q.trim().toLowerCase().replace(/\s+/g, "")
  const visible = rows.filter(
    (a) =>
      tests[filter](a) &&
      (hour === null || new Date(a.slot_start).getHours() === hour) &&
      (!needle || `${a.reg_no}${a.customer_name}${a.model}`.toLowerCase().replace(/\s+/g, "").includes(needle))
  )

  const selRef = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    selRef.current?.scrollIntoView({ block: "nearest" })
  }, [selected, appts.data])

  function openBooking(id: number) {
    setPicker(false)
    setBooking(id)
    setFocus(id)
  }
  function closeBooking() {
    setBooking(null)
    if (urlBook) router.replace("/appointments")
  }

  const pickups = rows.filter((a) => a.mode === "pickup").length
  const arrived = rows.filter((a) => a.status === "arrived").length
  const peak = Math.max(0, ...Object.values(hourCounts))

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Confirmed visits by hour. New bookings are slotted where the workshop has room.</p>
        <div className="flex items-center gap-2">
          <div className="flex rounded-xl bg-muted p-1">
            {[todayIso(), todayIso(1)].map((d) => (
              <button key={d} type="button" onClick={() => { setDay(d); setHour(null) }} className={cn("rounded-lg px-3 py-1.5 text-xs font-medium", day === d ? "bg-card shadow-sm" : "text-muted-foreground")}>
                {dayLabel(d)}
              </button>
            ))}
          </div>
          <Input type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} className="h-9 w-40" aria-label="Pick a day" />
          <Button onClick={() => { setBooking(null); setPicker(true) }}>New booking</Button>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_440px]">
        <div className="space-y-5">
          <section className={cn(card, "p-5")}>
            <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold">{dayLabel(day)} · workshop load</h2>
                <p className="text-xs text-muted-foreground">Booked visits per hour against a capacity of {DEFAULT_CAP}. Tap an hour to filter.</p>
              </div>
              <div className="flex gap-5 text-right">
                {[["Booked", rows.length], ["Pickups", pickups], ["Arrived", arrived], ["Peak hour", peak]].map(([l, v]) => (
                  <div key={l as string}>
                    <p className="text-lg font-semibold tabular-nums">{v}</p>
                    <p className="text-[11px] text-muted-foreground">{l}</p>
                  </div>
                ))}
              </div>
            </div>
            <LoadStrip counts={hourCounts} cap={DEFAULT_CAP} picked={hour} onPick={(h) => setHour((c) => (c === h ? null : h))} />
          </section>

          <section className={card}>
            <div className="flex flex-wrap items-center gap-2 border-b p-4">
              <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search registration, customer or model" className="h-9 max-w-xs" aria-label="Search bookings" />
              {(["all", "pickup", "walkin", "waiting", "arrived"] as Filter[]).map((f) => (
                <button key={f} type="button" onClick={() => setFilter(f)} className={cn("rounded-full border px-3 py-1 text-xs font-medium transition-colors", filter === f ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted")}>
                  {{ all: "All", pickup: "Pickup", walkin: "Drive-in", waiting: "Not arrived", arrived: "Arrived" }[f]}
                  <span className="ml-1.5 tabular-nums opacity-70">{rows.filter(tests[f]).length}</span>
                </button>
              ))}
              {hour !== null && (
                <button type="button" onClick={() => setHour(null)} className="rounded-full bg-accent px-3 py-1 text-xs font-medium text-primary">
                  {hourLabel(hour)} – {hourLabel(hour + 1)} ✕
                </button>
              )}
            </div>
            {appts.error && <p role="alert" className="m-4 rounded-xl bg-brand-red/10 p-3 text-sm text-brand-red">Could not load bookings: {appts.error}</p>}
            <div className="max-h-[620px] divide-y overflow-y-auto">
              {visible.map((a) => {
                const isSel = a.vehicle_id === selected
                const next = a.status === "arrived" ? { href: `/job-cards?v=${a.vehicle_id}`, label: "Open job card" } : a.mode === "pickup" && a.status === "booked" ? { href: `/pickups?v=${a.vehicle_id}`, label: "Track pickup" } : { href: `/reception?v=${a.vehicle_id}`, label: "Check in" }
                const st = STATUS[a.status] ?? { label: a.status, cls: "bg-muted" }
                return (
                  <div key={a.id} ref={isSel ? selRef : undefined} onClick={() => setFocus(a.vehicle_id)} className={cn("grid cursor-pointer grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-4 px-4 py-3 transition-colors hover:bg-muted/50", isSel && "bg-accent/60")}>
                    <span className="text-sm font-semibold tabular-nums">{clock(a.slot_start)}</span>
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Plate reg={regDisplay(a.reg_no)} size="sm" />
                        <span className="truncate text-sm font-medium">{a.customer_name}</span>
                        <span className="text-xs text-muted-foreground">{a.model}</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span>{a.mode === "pickup" ? `Pickup${a.driver_name ? ` · ${a.driver_name}` : ""}` : "Drive-in"}</span>
                        {advisorBy.get(a.id) && <span>· Advisor {advisorBy.get(a.id)}</span>}
                        {a.concerns && <span className="max-w-80 truncate">· “{a.concerns}”</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={cn("rounded-full px-2.5 py-0.5 text-[11px] font-medium whitespace-nowrap", st.cls)}>{st.label}</span>
                      <Link href={next.href} onClick={(e) => { e.stopPropagation(); setFocus(a.vehicle_id) }} className="text-xs font-semibold whitespace-nowrap text-primary hover:underline">
                        {next.label} →
                      </Link>
                    </div>
                  </div>
                )
              })}
              {!visible.length && !appts.error && (
                <p className="px-4 py-12 text-center text-sm text-muted-foreground">{appts.data ? "No bookings match." : "Loading bookings…"}</p>
              )}
            </div>
            <p className="border-t px-4 py-2.5 text-xs text-muted-foreground tabular-nums">Showing {visible.length} of {rows.length}</p>
          </section>
        </div>

        <aside className="xl:sticky xl:top-4 xl:self-start">
          {booking ? (
            <BookingPanel key={booking} vehicleId={booking} onClose={closeBooking} onBooked={(d) => { void appts.refresh(); void decisions.refresh(); refresh(); if (d !== day) setDay(d) }} />
          ) : (
            <VehiclePicker open={picker} onPick={openBooking} onOpen={() => setPicker(true)} />
          )}
        </aside>
      </div>
    </div>
  )
}

// ------------------------------------------------------------ vehicle pick

function VehiclePicker({ open, onPick, onOpen }: { open: boolean; onPick: (id: number) => void; onOpen: () => void }) {
  const [q, setQ] = React.useState("")
  const [hits, setHits] = React.useState<CustomerRow[]>([])
  React.useEffect(() => {
    if (!open || q.trim().length < 2) return
    const t = window.setTimeout(() => {
      erp.customers(q.trim()).then((r) => setHits(r.slice(0, 8))).catch(() => setHits([]))
    }, 250)
    return () => window.clearTimeout(t)
  }, [q, open])

  if (!open)
    return (
      <div className={cn(card, "p-6 text-center")}>
        <p className="text-sm font-semibold">Book a service visit</p>
        <p className="mx-auto mt-1 max-w-xs text-xs text-muted-foreground">Pick a customer and the system suggests the hours where the workshop has room.</p>
        <Button className="mt-4" onClick={onOpen}>New booking</Button>
        <p className="mt-3 text-xs text-muted-foreground">or start from <Link href="/crm" className="font-medium text-primary hover:underline">Service follow-up</Link></p>
      </div>
    )
  return (
    <div className={cn(card, "space-y-3 p-5")}>
      <p className="text-sm font-semibold">New booking</p>
      <Input autoFocus type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Registration, customer or phone" aria-label="Find vehicle" />
      <div className="divide-y">
        {(q.trim().length >= 2 ? hits : []).map((h) => (
          <button key={h.id} type="button" onClick={() => onPick(h.id)} className="flex w-full items-center gap-3 py-2.5 text-left hover:bg-muted/50">
            <Plate reg={h.reg_display} size="sm" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{h.customer_name}</span>
              <span className="block text-xs text-muted-foreground">{h.model} · {h.locality}</span>
            </span>
            <span className="text-xs font-semibold text-primary">Book →</span>
          </button>
        ))}
        {q.trim().length >= 2 && !hits.length && <p className="py-6 text-center text-xs text-muted-foreground">No vehicles match.</p>}
      </div>
    </div>
  )
}

// ------------------------------------------------------------ booking panel

function slotWhy(s: Slot, pref?: string | null) {
  const out: string[] = []
  const free = s.capacity - s.booked
  if (s.off_peak) out.push("Off-peak")
  if (pref && ((pref === "morning" && s.hour < 12) || (pref === "afternoon" && s.hour >= 12 && s.hour < 16) || (pref === "evening" && s.hour >= 16))) out.push(`Matches ${pref} preference`)
  out.push(`${free} of ${s.capacity} places free`)
  for (const r of s.reasons) if (!(s.off_peak && /off-peak/i.test(r)) && !out.some((o) => o.toLowerCase() === r.toLowerCase())) out.push(r.charAt(0).toUpperCase() + r.slice(1))
  return out.slice(0, 3)
}

function Why({ children }: { children: React.ReactNode }) {
  return (
    <details className="group text-xs text-muted-foreground">
      <summary className="cursor-pointer list-none font-medium text-muted-foreground hover:text-foreground">
        <span className="group-open:hidden">Why?</span><span className="hidden group-open:inline">Hide</span>
      </summary>
      <div className="mt-1.5 space-y-0.5">{children}</div>
    </details>
  )
}

function BookingPanel({ vehicleId, onClose, onBooked }: { vehicleId: number; onClose: () => void; onBooked: (day: string) => void }) {
  const [vehicle, setVehicle] = React.useState<Journey["vehicle"] | null>(null)
  const [date, setDate] = React.useState(todayIso(1))
  const [mode, setMode] = React.useState<"walkin" | "pickup">("pickup")
  const [day, setDay] = React.useState<SlotDay | null>(null)
  const [slot, setSlot] = React.useState<string | null>(null)
  const [concerns, setConcerns] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [result, setResult] = React.useState<BookingResult | null>(null)
  const [err, setErr] = React.useState<string | null>(null)

  React.useEffect(() => {
    erp.journey(vehicleId).then((j) => setVehicle(j.vehicle)).catch(() => setVehicle(null))
  }, [vehicleId])

  React.useEffect(() => {
    let live = true
    ai.slots(vehicleId, date, mode)
      .then((d) => {
        if (!live) return
        const sd = d as SlotDay
        setDay(sd)
        setErr(null)
        const top = [...sd.slots].filter((s) => s.recommended_rank).sort((a, b) => (a.recommended_rank ?? 9) - (b.recommended_rank ?? 9))[0]
        setSlot(top?.start ?? null)
      })
      .catch((e) => live && setErr(e instanceof Error ? e.message : "Could not load slots"))
    return () => { live = false }
  }, [vehicleId, date, mode])

  const ranked = (day?.slots ?? []).filter((s) => s.recommended_rank).sort((a, b) => (a.recommended_rank ?? 9) - (b.recommended_rank ?? 9)).slice(0, 3)
  const cap = day?.capacity_per_hour ?? DEFAULT_CAP
  const counts = Object.fromEntries((day?.slots ?? []).map((s) => [s.hour, s.booked]))
  const picked = day?.slots.find((s) => s.start === slot)

  async function book() {
    if (!slot) return
    setBusy(true)
    try {
      const r = await ai.book({ vehicle_id: vehicleId, slot_start: slot, mode, concerns: concerns.trim() })
      setResult(r)
      onBooked(slot.slice(0, 10))
      toast.success(`Booked ${dayLabel(slot.slice(0, 10)).toLowerCase()} at ${clock(slot)}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Booking failed")
    } finally {
      setBusy(false)
    }
  }

  const header = (
    <div className="flex items-start justify-between gap-3 border-b p-5">
      <div className="min-w-0 space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">{result ? "Booking confirmed" : "Book service"}</p>
        {vehicle ? (
          <div className="flex flex-wrap items-center gap-2">
            <Plate reg={vehicle.reg_display} />
            <span className="text-sm font-semibold">{vehicle.customer_name}</span>
            <span className="text-xs text-muted-foreground">{vehicle.model}</span>
          </div>
        ) : <div className="h-6 w-48 animate-pulse rounded bg-muted" />}
      </div>
      <button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-sm text-muted-foreground hover:bg-muted" aria-label="Close">✕</button>
    </div>
  )

  if (result) return <div className={card}>{header}<BookedView r={result} vehicleId={vehicleId} onClose={onClose} /></div>

  return (
    <div className={card}>
      {header}
      <div className="space-y-5 p-5">
        <div className="grid grid-cols-2 gap-3">
          <div className="flex rounded-xl bg-muted p-1">
            {[todayIso(), todayIso(1), todayIso(2)].map((d) => (
              <button key={d} type="button" onClick={() => setDate(d)} className={cn("flex-1 rounded-lg py-1.5 text-xs font-medium", date === d ? "bg-card shadow-sm" : "text-muted-foreground")}>
                {d === todayIso(2) ? new Date(d + "T00:00:00").toLocaleDateString([], { weekday: "short" }) : dayLabel(d)}
              </button>
            ))}
          </div>
          <div className="flex rounded-xl bg-muted p-1">
            {(["pickup", "walkin"] as const).map((m) => (
              <button key={m} type="button" onClick={() => setMode(m)} className={cn("flex-1 rounded-lg py-1.5 text-xs font-medium", mode === m ? "bg-card shadow-sm" : "text-muted-foreground")}>
                {m === "pickup" ? "We pick up" : "Drive-in"}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold">Best hours</p>
            <AssistChip uc={3}>Ranked by workshop load{day?.preferred_time ? ` & ${day.preferred_time} preference` : ""}</AssistChip>
          </div>
          {err && <p className="rounded-xl bg-brand-red/10 p-3 text-xs text-brand-red">{err}</p>}
          {day && !ranked.length && <p className="rounded-xl bg-muted p-4 text-center text-xs text-muted-foreground">No free hours on this day. Try the next day{mode === "pickup" ? " or drive-in" : ""}.</p>}
          {!day && !err && <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-16 animate-pulse rounded-xl bg-muted" />)}</div>}
          {ranked.map((s, i) => {
            const on = s.start === slot
            const ratio = s.booked / s.capacity
            return (
              <button key={s.start} type="button" onClick={() => setSlot(s.start)} className={cn("flex w-full items-center gap-4 rounded-xl border p-3 text-left transition-all", on ? "border-primary bg-accent/60 ring-1 ring-primary" : "hover:border-primary/40")}>
                <div className="w-16 shrink-0">
                  <p className="text-base font-semibold tabular-nums">{clock(s.start)}</p>
                  {i === 0 && <p className="text-[10px] font-semibold tracking-wide text-primary uppercase">Best</p>}
                </div>
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap gap-1">
                    {slotWhy(s, day?.preferred_time).map((w) => <span key={w} className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{w}</span>)}
                  </div>
                  {s.offer && <p className="text-[11px] font-medium text-success">{s.offer}</p>}
                </div>
                <div className="w-14 shrink-0">
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className={cn("h-full rounded-full", loadTone(ratio))} style={{ width: `${Math.min(ratio, 1) * 100}%` }} /></div>
                  <p className="mt-1 text-right text-[10px] text-muted-foreground tabular-nums">{s.booked}/{s.capacity}</p>
                </div>
              </button>
            )
          })}
        </div>

        {day && (
          <details className="group">
            <summary className="cursor-pointer list-none text-xs font-medium text-muted-foreground hover:text-foreground">All hours on {dayLabel(date).toLowerCase()} ▾</summary>
            <div className="mt-2">
              <LoadStrip counts={counts} cap={cap} picked={picked?.hour ?? null} onPick={(h) => { const s = day.slots.find((x) => x.hour === h); if (s?.feasible) setSlot(s.start); else toast.info(`${hourLabel(h)} is full or past`) }} />
            </div>
          </details>
        )}

        <div className="space-y-1.5">
          <label htmlFor="concerns" className="text-sm font-semibold">What does the customer report?</label>
          <Textarea id="concerns" rows={3} value={concerns} onChange={(e) => setConcerns(e.target.value)} placeholder="e.g. AC not cooling, noise from front wheel when braking" />
          <p className="text-[11px] text-muted-foreground">The advisor gets a pre-read of likely causes before the car arrives.</p>
        </div>

        <Button className="h-11 w-full text-sm" disabled={!slot || busy} onClick={book}>
          {busy ? "Booking…" : slot ? `Confirm ${dayLabel(date).toLowerCase()} ${clock(slot)} · ${mode === "pickup" ? "pickup" : "drive-in"}` : "Choose an hour"}
        </Button>
      </div>
    </div>
  )
}

function eta(d: AiDecision) {
  return d.alternatives.find((c) => c.id === d.chosen_id)?.eta_to_customer_min
}

function BookedView({ r, vehicleId, onClose }: { r: BookingResult; vehicleId: number; onClose: () => void }) {
  const a = r.appointment
  const isToday = a.slot_start.slice(0, 10) === todayIso()
  const finding = r.diagnosis?.evidence?.findings?.[0] ?? r.diagnosis?.evidence?.llm_findings?.[0]
  const next = a.mode === "pickup" ? { href: `/pickups?v=${vehicleId}`, label: "Continue: Track pickup" } : isToday ? { href: `/reception?v=${vehicleId}`, label: "Continue: Check in at gate" } : null
  const e = r.chauffeur ? eta(r.chauffeur) : undefined
  return (
    <div className="space-y-5 p-5">
      <div className="rounded-xl bg-success/10 p-4">
        <p className="text-sm font-semibold text-success">{dayLabel(a.slot_start.slice(0, 10))}, {clock(a.slot_start)} · {a.mode === "pickup" ? "Pickup from home" : "Drive-in"}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">Confirmation sent to the customer · ref {a.qr_token}</p>
      </div>
      <ul className="space-y-4">
        {r.advisor && (
          <li className="space-y-1.5">
            <AssistChip uc={8}>Advisor auto-assigned: {r.advisor.chosen_name}</AssistChip>
            <Why>{r.advisor.reasons.slice(0, 4).map((x) => <p key={x}>· {x}</p>)}</Why>
          </li>
        )}
        {a.mode === "pickup" && r.chauffeur && (
          <li className="space-y-1.5">
            <AssistChip uc={4}>Driver auto-assigned: {r.chauffeur.chosen_name}{e != null ? ` · ETA ${Math.round(e)} min` : ""}</AssistChip>
            <Why>{r.chauffeur.reasons.slice(0, 4).map((x) => <p key={x}>· {x}</p>)}</Why>
          </li>
        )}
        {r.diagnosis && (
          <li className="space-y-1.5">
            <AssistChip uc={9}>{finding ? `Pre-read: likely ${finding.likely_cause.toLowerCase()}` : r.diagnosis.summary}</AssistChip>
            {finding && (
              <Why>
                <p>· Reported: {finding.complaint}</p>
                <p>· {finding.why}</p>
                <p>· Check first: {finding.check_first}</p>
              </Why>
            )}
          </li>
        )}
      </ul>
      <div className="flex flex-col gap-2">
        {next && (
          <Link href={next.href} className={cn(buttonVariants(), "h-11 w-full")}>{next.label} →</Link>
        )}
        <Button variant={next ? "ghost" : "default"} className="w-full" onClick={onClose}>Back to diary</Button>
      </div>
    </div>
  )
}
