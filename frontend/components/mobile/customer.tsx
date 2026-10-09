"use client"

import * as React from "react"
import Link from "next/link"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Car01Icon,
  CheckmarkCircle02Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons"

import {
  ai,
  erp,
  type AiDecision,
  type BookingResult,
  type CustomerRow,
  type DiagnosisFinding,
  type SlotOption,
} from "@/lib/erp-api"
import { cn } from "@/lib/utils"
import { followVehicle } from "@/lib/demo-sync"
import { inspections } from "@/lib/erp-api"
import { ServiceStatus } from "@/components/mobile/service-status"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Empty,
  ErrorNote,
  Loading,
  MCard,
  PhotoTile,
  Pill,
  SectionTitle,
  StickyActions,
  errMsg,
  fmtDate,
  fmtTime,
  inr,
  km,
  normPlate,
  useLoad,
} from "@/components/mobile/shared"

// ------------------------------------------------------------------ my car store

export type MyCar = {
  id: number
  reg_display: string
  model: string
  customer_name: string
}

const CAR_KEY = "dlr-mobile-my-car"
const CAR_EVENT = "dlr-mobile-my-car-change"

function subscribeCar(cb: () => void) {
  window.addEventListener("storage", cb)
  window.addEventListener(CAR_EVENT, cb)
  return () => {
    window.removeEventListener("storage", cb)
    window.removeEventListener(CAR_EVENT, cb)
  }
}

export function useMyCar(): MyCar | null {
  const raw = React.useSyncExternalStore(
    subscribeCar,
    () => localStorage.getItem(CAR_KEY),
    () => null
  )
  return React.useMemo(() => {
    if (!raw) return null
    try {
      return JSON.parse(raw) as MyCar
    } catch {
      return null
    }
  }, [raw])
}

export function setMyCar(car: MyCar | null) {
  if (car) localStorage.setItem(CAR_KEY, JSON.stringify(car))
  else localStorage.removeItem(CAR_KEY)
  followVehicle(car?.id ?? null)
  window.dispatchEvent(new Event(CAR_EVENT))
}

// ------------------------------------------------------------------ picker + header

function CarPicker({ onDone }: { onDone?: () => void }) {
  const [q, setQ] = React.useState("")
  const list = useLoad(() => erp.customers(), [])
  const needle = q.trim().toLowerCase()
  const rows = (list.data ?? []).filter(
    (c: CustomerRow) =>
      !needle ||
      normPlate(c.reg_no).includes(normPlate(needle) || "~") ||
      c.customer_name.toLowerCase().includes(needle) ||
      c.model.toLowerCase().includes(needle)
  )
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h1 className="text-xl font-semibold">Which car is yours?</h1>
        <p className="text-sm text-muted-foreground">
          Search your registration or name, then select your car.
        </p>
      </div>
      <div className="relative">
        <HugeiconsIcon
          icon={Search01Icon}
          className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search reg no or name"
          className="h-11 pl-9"
        />
      </div>
      <ErrorNote onRetry={list.reload}>{list.error}</ErrorNote>
      {list.loading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty>No cars match.</Empty>
      ) : (
        <div className="flex flex-col gap-2">
          {rows.slice(0, needle ? 40 : 8).map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => {
                setMyCar({
                  id: c.id,
                  reg_display: c.reg_display,
                  model: c.model,
                  customer_name: c.customer_name,
                })
                onDone?.()
              }}
              className="flex min-h-14 items-center gap-3 rounded-2xl border bg-card p-3 text-left active:scale-[0.99]"
            >
              <span className="flex size-10 items-center justify-center rounded-xl bg-muted">
                <HugeiconsIcon icon={Car01Icon} className="size-5" />
              </span>
              <span className="flex-1">
                <span className="block font-medium">{c.reg_display}</span>
                <span className="block text-xs text-muted-foreground">
                  {c.customer_name} · {c.model}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
      {!needle && rows.length > 8 && (
        <p className="px-1 text-sm text-muted-foreground">
          Showing 8 cars. Search above to find yours.
        </p>
      )}
    </div>
  )
}

function CarHeader({ car, onChange }: { car: MyCar; onChange: () => void }) {
  return (
    <MCard className="flex items-center gap-3 border-primary/30 bg-primary/5 p-3">
      <span className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
        <HugeiconsIcon icon={Car01Icon} className="size-5" />
      </span>
      <div className="min-w-0 flex-1 leading-tight">
        <div className="truncate font-semibold">{car.reg_display}</div>
        <div className="truncate text-xs text-muted-foreground">
          {car.customer_name} · {car.model}
        </div>
      </div>
      <button
        type="button"
        className="text-sm font-medium text-primary"
        onClick={onChange}
      >
        Change
      </button>
    </MCard>
  )
}

/** Renders the car picker until a car is chosen, then the header + children. */
function CarGate({ children }: { children: (car: MyCar) => React.ReactNode }) {
  const car = useMyCar()
  const [picking, setPicking] = React.useState(false)
  React.useEffect(() => {
    if (car?.id) followVehicle(car.id)
  }, [car?.id])
  if (!car || picking) return <CarPicker onDone={() => setPicking(false)} />
  return (
    <div className="flex flex-col gap-4">
      <CarHeader car={car} onChange={() => setPicking(true)} />
      {children(car)}
    </div>
  )
}

// ------------------------------------------------------------------ home

export function CustomerHome() {
  return <CarGate>{(car) => <CustomerHomeBody car={car} />}</CarGate>
}

function CustomerHomeBody({ car }: { car: MyCar }) {
  const v360 = useLoad(() => erp.vehicle(car.id), [car.id], 5000)
  const due = useLoad(() => ai.serviceDue(), [])
  const row = due.data?.find((d) => d.vehicle_id === car.id)
  const v = v360.data?.vehicle
  const open = v360.data?.open_job_card
  const upcoming = v360.data?.appointments.find((a) =>
    ["booked", "en_route", "at_customer", "collected", "at_gate"].includes(
      a.status
    )
  )

  return (
    <>
      <div>
        <h1 className="text-xl font-semibold">
          Hello, {car.customer_name.split(" ")[0]}
        </h1>
        <p className="text-sm text-muted-foreground">
          Sharma Motors · your Maruti Suzuki service centre
        </p>
      </div>
      <ErrorNote>{v360.error}</ErrorNote>
      <ServiceStatus vehicleId={car.id} record={v360.data} />

      {row && !open && !upcoming && (
        <MCard className="flex flex-col gap-2 border-amber-500/30 bg-amber-500/5">
          <div className="flex items-center justify-between">
            <div className="font-semibold">Service due</div>
            <Pill tone={row.due_in_days <= 7 ? "warn" : "info"}>
              {row.due_in_days <= 0 ? "Due now" : `In ${row.due_in_days} days`}
            </Pill>
          </div>
          <div className="text-sm text-muted-foreground">
            Around {fmtDate(row.due_date)}
          </div>
          {row.reasons.length > 0 && (
            <ul className="list-disc pl-5 text-sm">
              {row.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          <Button
            nativeButton={false}
            render={<Link href="/m/book" />}
            className="mt-1 h-11"
          >
            Book now
          </Button>
        </MCard>
      )}

      <section>
        <SectionTitle>My car</SectionTitle>
        {v ? (
          <MCard className="grid grid-cols-2 gap-3 text-sm">
            <Info label="Model" value={`${v.model} · ${v.fuel}`} />
            <Info label="Odometer" value={km(v.odometer)} />
            <Info label="Last service" value={fmtDate(v.last_service_date)} />
            <Info label="Bought" value={fmtDate(v.sale_date)} />
          </MCard>
        ) : (
          <Loading />
        )}
      </section>

      {!row && !open && !upcoming && (
        <Button
          nativeButton={false}
          render={<Link href="/m/book" />}
          className="h-12"
        >
          Book a service
        </Button>
      )}
    </>
  )
}

function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  )
}

// ------------------------------------------------------------------ booking

const QUICK = [
  "Periodic service",
  "AC not cooling",
  "Brake noise",
  "Battery/starting issue",
  "Dent/scratch",
  "Check-engine light",
]

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`

function nextDays(n: number) {
  const out: Date[] = []
  const base = new Date()
  for (let i = 0; i < n; i++) {
    const d = new Date(base)
    d.setDate(base.getDate() + i)
    out.push(d)
  }
  return out
}

/** Drop scores, model internals and staff-facing comparisons from reasons. */
function friendly(reasons: string[] | undefined) {
  return (reasons ?? []).filter(
    (r) =>
      !/%|\bscore|probab|model|capacity|ahead of|skipped|auc|\d\.\d/i.test(r)
  )
}

export function BookScreen() {
  return <CarGate>{(car) => <BookBody car={car} />}</CarGate>
}

function BookBody({ car }: { car: MyCar }) {
  const days = React.useMemo(() => nextDays(7), [])
  const [date, setDate] = React.useState(() => ymd(days[0]))
  const [mode, setMode] = React.useState<"walkin" | "pickup">("pickup")
  const [slot, setSlot] = React.useState<string | null>(null)
  const [text, setText] = React.useState("")
  const [chips, setChips] = React.useState<string[]>([])
  const [photos, setPhotos] = React.useState<(File | null)[]>([
    null,
    null,
    null,
  ])
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [result, setResult] = React.useState<BookingResult | null>(null)
  const [uploadedPhotos, setUploadedPhotos] = React.useState(0)
  const [photoError, setPhotoError] = React.useState<string | null>(null)

  const slots = useLoad(
    () => ai.slots(car.id, date, mode),
    [car.id, date, mode]
  )

  const concerns = [...chips, text.trim()].filter(Boolean).join(". ")

  async function confirm() {
    if (!slot) return
    setBusy(true)
    setError(null)
    try {
      const booking = await ai.book({
        vehicle_id: car.id,
        slot_start: slot,
        mode,
        concerns,
      })
      followVehicle(car.id)
      setResult(booking)
      const attachments = photos.flatMap((file, i) =>
        file ? [{ angle: `Customer photo ${i + 1}`, file }] : []
      )
      if (attachments.length) {
        try {
          await inspections.create({ vehicleId: car.id }, attachments)
          setUploadedPhotos(attachments.length)
        } catch (e) {
          setPhotoError(
            `Your booking is saved. Photos could not be uploaded: ${errMsg(e)}`
          )
        }
      }
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  if (result)
    return (
      <>
        <ErrorNote>{photoError}</ErrorNote>
        <Confirmation result={result} photoCount={uploadedPhotos} />
      </>
    )

  return (
    <>
      <div>
        <h1 className="text-xl font-semibold">Book a service</h1>
        <p className="text-sm text-muted-foreground">
          Pick a time — we&apos;ll handle the rest.
        </p>
      </div>

      <section>
        <SectionTitle>How do you want to come in?</SectionTitle>
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ["pickup", "Pickup & drop", "We collect your car"],
              ["walkin", "I'll drop it", "Bring it to the centre"],
            ] as const
          ).map(([k, label, sub]) => (
            <button
              key={k}
              type="button"
              onClick={() => {
                setMode(k)
                setSlot(null)
              }}
              className={cn(
                "rounded-2xl border bg-card p-3 text-left active:scale-[0.99]",
                mode === k && "border-primary ring-2 ring-primary/20"
              )}
            >
              <div className="font-medium">{label}</div>
              <div className="text-xs text-muted-foreground">{sub}</div>
            </button>
          ))}
        </div>
      </section>

      <section>
        <SectionTitle>Date</SectionTitle>
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
          {days.map((d) => {
            const k = ymd(d)
            return (
              <button
                key={k}
                type="button"
                onClick={() => {
                  setDate(k)
                  setSlot(null)
                }}
                className={cn(
                  "flex min-w-16 flex-col items-center rounded-xl border bg-card px-3 py-2 text-sm",
                  date === k &&
                    "border-primary bg-primary text-primary-foreground"
                )}
              >
                <span className="text-[11px] uppercase opacity-80">
                  {d.toLocaleDateString("en-IN", { weekday: "short" })}
                </span>
                <span className="text-lg font-semibold">{d.getDate()}</span>
              </button>
            )
          })}
        </div>
      </section>

      <section>
        <SectionTitle>Time</SectionTitle>
        <ErrorNote onRetry={slots.reload}>{slots.error}</ErrorNote>
        {slots.loading ? (
          <div className="h-32 animate-pulse rounded-2xl bg-muted" />
        ) : (slots.data?.slots.length ?? 0) === 0 ? (
          <Empty>No slots on this day.</Empty>
        ) : (
          <div className="grid grid-cols-2 gap-3 min-[400px]:grid-cols-3">
            {slots.data?.slots.map((s: SlotOption) => (
              <button
                key={s.start}
                type="button"
                disabled={!s.feasible}
                onClick={() => setSlot(s.start)}
                className={cn(
                  "relative flex min-h-16 flex-col items-center justify-center rounded-xl border bg-card p-2 text-sm disabled:opacity-40",
                  slot === s.start && "border-primary ring-2 ring-primary/20",
                  s.recommended_rank === 1 && s.feasible && "border-emerald-500"
                )}
              >
                <span className="font-semibold">{fmtTime(s.start)}</span>
                {!s.feasible ? (
                  <span className="text-[10px] text-muted-foreground">
                    Full
                  </span>
                ) : s.recommended_rank === 1 ? (
                  <span className="text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                    Recommended
                  </span>
                ) : null}
                {s.offer && s.feasible && (
                  <span className="text-center text-[10px] leading-tight text-amber-700 dark:text-amber-300">
                    {s.offer}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <SectionTitle>What&apos;s the problem?</SectionTitle>
        <div className="flex flex-wrap gap-2">
          {QUICK.map((c) => {
            const on = chips.includes(c)
            return (
              <button
                key={c}
                type="button"
                onClick={() =>
                  setChips(on ? chips.filter((x) => x !== c) : [...chips, c])
                }
                className={cn(
                  "rounded-full border px-3 py-1.5 text-sm",
                  on && "border-primary bg-primary text-primary-foreground"
                )}
              >
                {c}
              </button>
            )
          })}
        </div>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Tell us in your own words, e.g. AC is not cooling since last week"
          rows={3}
        />
      </section>

      <section className="flex flex-col gap-2">
        <SectionTitle>Photos (optional)</SectionTitle>
        <div className="grid grid-cols-3 gap-2">
          {photos.map((f, i) => (
            <PhotoTile
              key={i}
              label={`Photo ${i + 1}`}
              file={f}
              onFile={(nf) =>
                setPhotos((p) => p.map((x, j) => (j === i ? nf : x)))
              }
            />
          ))}
        </div>
        <p className="px-1 text-xs text-muted-foreground">
          Photos will be shared with your advisor.
        </p>
      </section>

      <ErrorNote>{error}</ErrorNote>
      <StickyActions>
        <Button
          className="h-12 flex-1"
          disabled={!slot || !concerns || busy}
          onClick={confirm}
        >
          {busy
            ? "Booking…"
            : slot
              ? `Confirm ${fmtTime(slot)}`
              : "Choose a time"}
        </Button>
      </StickyActions>
    </>
  )
}

function findingsOf(d: AiDecision | null | undefined): DiagnosisFinding[] {
  const ev = d?.evidence
  if (ev?.llm_findings?.length) return ev.llm_findings
  return ev?.findings ?? []
}

function Confirmation({
  result,
  photoCount,
}: {
  result: BookingResult
  photoCount: number
}) {
  const a = result.appointment
  const [diag, setDiag] = React.useState<AiDecision | null>(result.diagnosis)
  const [checking, setChecking] = React.useState(
    !result.diagnosis?.evidence.llm_findings?.length
  )

  React.useEffect(() => {
    if (!checking) return
    let tries = 0
    const t = window.setInterval(async () => {
      tries++
      try {
        const r = await ai.booking(a.id)
        if (r.diagnosis) setDiag(r.diagnosis)
        if (r.diagnosis?.evidence.llm_findings?.length || tries >= 40)
          setChecking(false)
      } catch {
        if (tries >= 40) setChecking(false)
      }
    }, 3000)
    return () => window.clearInterval(t)
  }, [a.id, checking])

  const adv = result.advisor
  const ch = result.chauffeur
  const advWhy = friendly(adv?.reasons).slice(0, 2).join(", ")
  const chWhy = friendly(ch?.reasons).slice(0, 1).join("")
  const findings = findingsOf(diag)

  return (
    <>
      <div className="flex flex-col items-center gap-1 pt-2 text-center">
        <HugeiconsIcon
          icon={CheckmarkCircle02Icon}
          className="size-12 text-emerald-600"
        />
        <h1 className="text-xl font-semibold">You&apos;re booked!</h1>
        <p className="text-sm text-muted-foreground">
          {fmtDate(a.slot_start)} · {fmtTime(a.slot_start)} ·{" "}
          {a.mode === "pickup" ? "Pickup & drop" : "Drop-in"}
        </p>
      </div>

      <MCard className="flex flex-col items-center gap-1 text-center">
        <div className="text-xs tracking-wide text-muted-foreground uppercase">
          Service pass code
        </div>
        <div className="font-mono text-3xl font-bold tracking-widest break-all">
          {a.qr_token}
        </div>
        <div className="text-xs text-muted-foreground">
          Show this at the gate
        </div>
      </MCard>

      <MCard className="flex flex-col gap-3 text-sm">
        {adv?.chosen_name ? (
          <div>
            <span className="font-semibold">
              Your service advisor: {adv.chosen_name}
            </span>
            {advWhy && (
              <span className="text-muted-foreground">
                {" "}
                — {advWhy.toLowerCase()}
              </span>
            )}
          </div>
        ) : (
          <div className="text-muted-foreground">
            Your service advisor will be confirmed shortly.
          </div>
        )}
        {a.mode === "pickup" &&
          (ch?.chosen_name || a.driver_name ? (
            <div>
              <span className="font-semibold">
                Pickup by {ch?.chosen_name ?? a.driver_name} · arrives ~
                {fmtTime(a.slot_start)}
              </span>
              {chWhy && (
                <span className="text-muted-foreground">
                  {" "}
                  — {chWhy.toLowerCase()}
                </span>
              )}
            </div>
          ) : (
            <div className="text-muted-foreground">
              We&apos;ll confirm your pickup driver shortly.
            </div>
          ))}
        {photoCount > 0 && (
          <div className="text-muted-foreground">
            {photoCount} photo{photoCount > 1 ? "s" : ""} attached — will be
            shared with your advisor.
          </div>
        )}
      </MCard>

      <section>
        <SectionTitle>What we&apos;ll check</SectionTitle>
        <MCard className="flex flex-col gap-3 text-sm">
          {findings.length === 0 ? (
            <div className="text-muted-foreground">
              {checking
                ? "Our team is reviewing your concerns…"
                : "Your advisor will inspect the car on arrival."}
            </div>
          ) : (
            findings.map((f, i) => (
              <div key={i}>
                <div>
                  <span className="font-semibold">{f.complaint}</span>
                  {f.likely_cause && (
                    <>
                      {" "}
                      — likely{" "}
                      {f.likely_cause.replace(/^likely\s+/i, "").toLowerCase()}
                    </>
                  )}
                </div>
                {f.check_first && (
                  <div className="text-xs text-muted-foreground">
                    We&apos;ll start by checking: {f.check_first}
                  </div>
                )}
              </div>
            ))
          )}
          {checking && findings.length > 0 && (
            <div className="text-xs text-muted-foreground">
              Refining details…
            </div>
          )}
        </MCard>
      </section>

      <Button
        nativeButton={false}
        render={<Link href="/m/customer" />}
        variant="outline"
        className="h-12"
      >
        Track my service
      </Button>
    </>
  )
}

// ------------------------------------------------------------------ my car

export function MyCarScreen() {
  return <CarGate>{(car) => <MyCarBody car={car} />}</CarGate>
}

function MyCarBody({ car }: { car: MyCar }) {
  const v = useLoad(() => erp.vehicle(car.id), [car.id], 5000)
  if (v.error) return <ErrorNote>{v.error}</ErrorNote>
  if (!v.data) return <Loading />
  const d = v.data
  return (
    <>
      <section>
        <SectionTitle>Status</SectionTitle>
        <ServiceStatus vehicleId={car.id} record={d} />
      </section>

      <section>
        <SectionTitle>Service history</SectionTitle>
        {d.history.length === 0 ? (
          <Empty>No past services yet.</Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {d.history.map((h) => (
              <MCard
                key={h.id}
                className="flex items-center justify-between gap-3 p-3 text-sm"
              >
                <div>
                  <div className="font-medium">{h.kind}</div>
                  <div className="text-xs text-muted-foreground">
                    {fmtDate(h.date)} · {km(h.km)}
                    {h.advisor_name ? ` · ${h.advisor_name}` : ""}
                  </div>
                </div>
                <div className="font-medium tabular-nums">{inr(h.amount)}</div>
              </MCard>
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionTitle>Invoices</SectionTitle>
        {d.invoices.length === 0 ? (
          <Empty>No invoices yet.</Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {d.invoices.map((inv) => (
              <MCard
                key={inv.id}
                className="flex items-center justify-between gap-3 p-3 text-sm"
              >
                <div>
                  <div className="font-medium">{inv.number}</div>
                  <div className="text-xs text-muted-foreground">
                    {fmtDate(inv.created_at)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-medium tabular-nums">
                    {inr(inv.total)}
                  </div>
                  <Pill tone={inv.paid >= inv.total ? "ok" : "warn"}>
                    {inv.paid >= inv.total ? "Paid" : "Due"}
                  </Pill>
                </div>
              </MCard>
            ))}
          </div>
        )}
      </section>
    </>
  )
}
