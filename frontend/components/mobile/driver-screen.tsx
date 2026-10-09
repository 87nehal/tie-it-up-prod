"use client"

import * as React from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { useJourney } from "@/components/erp/journey"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Call02Icon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  Location01Icon,
} from "@hugeicons/core-free-icons"

import { extractGate, GateValidationError } from "@/lib/api"
import {
  service,
  type PickupBoard,
  type PickupStatus,
  type VehicleOption,
} from "@/lib/service-api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { followVehicle } from "@/lib/demo-sync"
import {
  demoPhoto,
  Empty,
  errMsg,
  ErrorNote,
  fmtTime,
  fmtDate,
  Loading,
  MCard,
  PhotoCapture,
  Pill,
  SectionTitle,
  useLoad,
} from "@/components/mobile/shared"

const STATUS: Record<
  string,
  { label: string; tone: "neutral" | "info" | "ok" | "warn" | "bad" }
> = {
  booked: { label: "Not started", tone: "neutral" },
  en_route: { label: "En route", tone: "info" },
  at_customer: { label: "At customer", tone: "info" },
  collected: { label: "Collected", tone: "ok" },
  at_gate: { label: "At dealership", tone: "ok" },
}

const RISK: Record<
  PickupStatus["risk"],
  { label: string; tone: "neutral" | "info" | "ok" | "warn" | "bad" }
> = {
  not_started: { label: "Not started", tone: "neutral" },
  on_time: { label: "On time", tone: "ok" },
  at_risk: { label: "At risk", tone: "warn" },
  late: { label: "Late", tone: "bad" },
  no_signal: { label: "No signal", tone: "warn" },
}

const LEG: Record<string, string> = {
  to_customer: "Driving to customer",
  handover: "Vehicle handover at customer",
  to_dealership: "Driving to Sharma Motors",
  at_gate: "Arrived at dealership gate",
}

export function DriverScreen() {
  const { focusId } = useJourney()
  const params = useSearchParams()
  const linkedVehicle = Number(params.get("v")) || null
  const queue = useLoad(() => service.pickups(), [], 15000)
  const [updatedBoard, setUpdatedBoard] = React.useState<PickupBoard | null>(
    null
  )
  const board = updatedBoard ?? queue.data
  const [selected, setSelected] = React.useState<number | null | undefined>(
    undefined
  )

  React.useEffect(() => {
    // A fresh queue supersedes the immediate result of the last trip action.
    void Promise.resolve().then(() => setUpdatedBoard(null))
  }, [queue.data])

  const trip = board?.pickups.find((p) =>
    selected === undefined
      ? p.vehicle_id === linkedVehicle
      : p.appointment_id === selected
  )

  if (trip && board) {
    return (
      <TripDetail
        trip={trip}
        onBack={() => setSelected(null)}
        onBoard={(next) => {
          setUpdatedBoard(next)
          queue.reload()
        }}
      />
    )
  }

  const pickups = [...(board?.pickups ?? [])].sort(
    (a, b) =>
      Number(b.vehicle_id === focusId) - Number(a.vehicle_id === focusId)
  )
  const active = pickups.filter(
    (p) => !["at_gate", "arrived"].includes(p.status)
  )
  const done = pickups.filter((p) => ["at_gate", "arrived"].includes(p.status))

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h1 className="text-xl font-semibold">Pickup trips</h1>
        <p className="text-sm text-muted-foreground">
          Select your assigned trip, then follow the pickup steps.
        </p>
      </div>
      <ErrorNote onRetry={queue.reload}>{queue.error}</ErrorNote>
      {queue.loading && !board && <Loading label="Loading pickup trips…" />}
      {board && !pickups.length && (
        <Empty>No scheduled or active pickups.</Empty>
      )}
      {active.map((p) => (
        <TripRow
          key={p.appointment_id}
          p={p}
          onOpen={() => setSelected(p.appointment_id)}
        />
      ))}
      {done.length > 0 && <SectionTitle>Completed</SectionTitle>}
      {done.map((p) => (
        <TripRow
          key={p.appointment_id}
          p={p}
          onOpen={() => setSelected(p.appointment_id)}
        />
      ))}
    </div>
  )
}

function TripRow({ p, onOpen }: { p: PickupStatus; onOpen: () => void }) {
  const st = STATUS[p.status] ?? { label: p.status, tone: "neutral" as const }
  return (
    <button
      type="button"
      onClick={() => {
        followVehicle(p.vehicle_id)
        onOpen()
      }}
      className="flex min-h-20 items-center gap-3 rounded-2xl border bg-card p-3 text-left active:scale-[0.99]"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{p.reg_no}</span>
          <Pill tone={st.tone}>{st.label}</Pill>
        </div>
        <div className="truncate text-sm text-muted-foreground">
          {p.customer_name}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <HugeiconsIcon icon={Clock01Icon} className="size-3.5" />
          Pickup {fmtDate(p.promised_pickup)} · {fmtTime(p.promised_pickup)}
          {p.driver_name && <> · {p.driver_name}</>}
        </div>
      </div>
      <HugeiconsIcon
        icon={ArrowRight01Icon}
        className="size-5 text-muted-foreground"
      />
    </button>
  )
}

function TripDetail({
  trip,
  onBack,
  onBoard,
}: {
  trip: PickupStatus
  onBack: () => void
  onBoard: (b: PickupBoard) => void
}) {
  const [vehicle, setVehicle] = React.useState<VehicleOption | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    service.vehicles(trip.reg_no).then(
      (v) => setVehicle(v[0] ?? null),
      () => {}
    )
  }, [trip.reg_no])

  async function act(label: string, fn: () => Promise<PickupBoard>) {
    setBusy(label)
    setError(null)
    try {
      onBoard(await fn())
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(null)
    }
  }

  const st = STATUS[trip.status] ?? {
    label: trip.status,
    tone: "neutral" as const,
  }
  const risk = RISK[trip.risk]
  const canHandover = trip.status === "at_customer" || trip.leg === "handover"
  const started = trip.status !== "booked"

  return (
    <div className="flex flex-col gap-4">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1 self-start text-sm font-medium text-primary"
      >
        <HugeiconsIcon icon={ArrowLeft01Icon} className="size-4" /> All trips
      </button>

      <MCard className="flex flex-col gap-2">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-lg font-semibold">{trip.reg_no}</div>
            <div className="text-sm text-muted-foreground">
              {vehicle?.model}
            </div>
          </div>
          <Pill tone={st.tone}>{st.label}</Pill>
        </div>
        <div className="mt-1 text-sm font-medium">{trip.customer_name}</div>
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <HugeiconsIcon icon={Location01Icon} className="size-4" />
          {vehicle ? `${vehicle.locality}, Gurugram` : "—"}
        </div>
        {vehicle?.phone && (
          <a
            href={`tel:${vehicle.phone}`}
            className="flex items-center gap-1.5 text-sm font-medium text-primary"
          >
            <HugeiconsIcon icon={Call02Icon} className="size-4" />{" "}
            {vehicle.phone}
          </a>
        )}
      </MCard>

      <MCard className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Route</span>
          <Pill tone={risk.tone}>{risk.label}</Pill>
        </div>
        <ol className="flex flex-col gap-3 border-l-2 border-dashed pl-4 text-sm">
          <li className="relative">
            <span className="absolute top-1 -left-[1.4rem] size-3 rounded-full bg-primary" />
            Sharma Motors, Sector 18
          </li>
          <li className="relative">
            <span className="absolute top-1 -left-[1.4rem] size-3 rounded-full border-2 border-primary bg-background" />
            {trip.customer_name} · {vehicle?.locality ?? "customer address"} —
            pickup by {fmtTime(trip.promised_pickup)}
          </li>
          <li className="relative">
            <span className="absolute top-1 -left-[1.4rem] size-3 rounded-full bg-primary" />
            Back to Sharma Motors
            {trip.deadline ? ` by ${fmtTime(trip.deadline)}` : ""}
          </li>
        </ol>
        <div className="grid grid-cols-3 gap-2 text-center">
          <Stat
            label="Now"
            value={trip.leg ? (LEG[trip.leg] ?? trip.leg) : "Not started"}
          />
          <Stat label="ETA" value={fmtTime(trip.eta)} />
          <Stat
            label="Remaining"
            value={
              trip.remaining_km != null
                ? `${trip.remaining_km.toFixed(1)} km`
                : "—"
            }
          />
        </div>
        {trip.buffer_min != null && (
          <div className="text-xs text-muted-foreground">
            {trip.buffer_min >= 0
              ? `${Math.round(trip.buffer_min)} min to spare`
              : `${Math.round(-trip.buffer_min)} min behind promise`}
          </div>
        )}
        {trip.interventions.map((i) => (
          <div
            key={i}
            className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300"
          >
            {i}
          </div>
        ))}
      </MCard>

      <ErrorNote>{error}</ErrorNote>

      <div className="grid grid-cols-2 gap-2">
        <Button
          className="h-12 text-base"
          disabled={started || !!busy}
          onClick={() =>
            act("start", () => service.dispatch(trip.appointment_id))
          }
        >
          {busy === "start"
            ? "Starting…"
            : started
              ? "Trip started"
              : "Start trip"}
        </Button>
        <Button
          variant="outline"
          className="h-12 text-base"
          disabled={!!busy}
          onClick={() => act("sim", () => service.simulate(5))}
        >
          {busy === "sim" ? "…" : "Simulate +5 min"}
        </Button>
      </div>

      {(canHandover ||
        trip.status === "collected" ||
        trip.status === "at_gate") && (
        <Handover
          trip={trip}
          vehicleId={vehicle?.id ?? null}
          onBoard={onBoard}
        />
      )}
      {trip.status === "at_gate" && (
        <Button
          nativeButton={false}
          render={<Link href={`/m/arrival?v=${trip.vehicle_id}`} />}
          className="h-12"
        >
          Continue to workshop arrival
        </Button>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-muted/60 p-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-xs leading-tight font-semibold">{value}</div>
    </div>
  )
}

type Shot = {
  file: File | null
  value: string
  busy: boolean
  read: boolean
  time: string | null
  capture: string | null
}
const emptyShot: Shot = {
  file: null,
  value: "",
  busy: false,
  read: false,
  time: null,
  capture: null,
}

function Handover({
  trip,
  vehicleId,
  onBoard,
}: {
  trip: PickupStatus
  vehicleId: number | null
  onBoard: (b: PickupBoard) => void
}) {
  const [plate, setPlate] = React.useState<Shot>(emptyShot)
  const [odo, setOdo] = React.useState<Shot>(emptyShot)
  const [otp, setOtp] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [done, setDone] = React.useState(
    trip.status === "collected" || trip.status === "at_gate"
  )

  async function shoot(kind: "plate" | "odometer", file: File) {
    const set = kind === "plate" ? setPlate : setOdo
    set((s) => ({ ...s, file, busy: true, read: false }))
    try {
      const x = await extractGate([file])
      const f = x.fields[kind]
      const v =
        f?.value != null
          ? kind === "plate"
            ? (x.fields.plate?.display ?? String(f.value))
            : String(f.value)
          : ""
      set((s) => ({
        ...s,
        busy: false,
        read: !!v,
        value: v || s.value,
        time: x.images[0]?.taken_at ?? null,
        capture: x.capture_id,
      }))
    } catch (e) {
      set((s) => ({ ...s, busy: false }))
      setError(errMsg(e))
    }
  }

  async function demo(kind: "plate" | "odometer") {
    if (!vehicleId) return
    try {
      await shoot(kind, await demoPhoto(vehicleId, kind))
    } catch (e) {
      setError(errMsg(e))
    }
  }

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const odometer = Number(odo.value.replace(/[^0-9.]/g, ""))
      const r = await service.handover(trip.appointment_id, {
        plate: plate.value,
        service_pass: otp.trim(),
        odometer: Number.isFinite(odometer) ? odometer : null,
        capture_id: plate.capture ?? odo.capture,
        photo_times: [plate.time, odo.time],
      })
      onBoard(r.board)
      setDone(true)
    } catch (e) {
      if (e instanceof GateValidationError)
        setError(
          e.validation.checks
            .filter((c) => c.level !== "ok")
            .map((c) => c.message)
            .join(" ")
        )
      else setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <MCard className="flex items-center gap-2 border-emerald-500/30 bg-emerald-500/5 text-sm font-medium">
        <HugeiconsIcon
          icon={CheckmarkCircle02Icon}
          className="size-5 text-emerald-600"
        />
        Vehicle collected from customer — drive safe.
      </MCard>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <SectionTitle>Pickup handover</SectionTitle>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-2">
          <PhotoCapture
            label="Plate"
            file={plate.file}
            busy={plate.busy}
            done={plate.read}
            onFile={(f) => shoot("plate", f)}
            onDemo={vehicleId ? () => demo("plate") : undefined}
          />
          <Input
            value={plate.value}
            onChange={(e) =>
              setPlate((s) => ({ ...s, value: e.target.value.toUpperCase() }))
            }
            placeholder="Reg no"
            className="h-11"
          />
        </div>
        <div className="flex flex-col gap-2">
          <PhotoCapture
            label="Odometer"
            file={odo.file}
            busy={odo.busy}
            done={odo.read}
            onFile={(f) => shoot("odometer", f)}
            onDemo={vehicleId ? () => demo("odometer") : undefined}
          />
          <Input
            value={odo.value}
            inputMode="numeric"
            onChange={(e) => setOdo((s) => ({ ...s, value: e.target.value }))}
            placeholder="km"
            className="h-11"
          />
        </div>
      </div>
      <div>
        <label className="px-1 text-sm font-medium">
          Customer service pass
        </label>
        <Input
          value={otp}
          onChange={(e) => setOtp(e.target.value.toUpperCase())}
          placeholder="DSP-12345678"
          className="mt-1 h-12 text-center font-mono text-lg"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Ask the customer for the pass shown in their service tracker.
        </p>
      </div>
      <ErrorNote>{error}</ErrorNote>
      <Button
        className="h-12 text-base"
        disabled={
          busy || !plate.value || !odo.value || !/^DSP-\d{8}$/.test(otp.trim())
        }
        onClick={submit}
      >
        {busy ? "Confirming…" : "Confirm handover"}
      </Button>
    </div>
  )
}
