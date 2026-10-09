"use client"

import * as React from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Alert02Icon,
  Calendar03Icon,
  CheckmarkCircle02Icon,
  Search01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons"

import {
  extractGate,
  getDamageSamples,
  GateValidationError,
  type GateCheck,
} from "@/lib/api"
import {
  service,
  type CheckInResult,
  type ConditionReport,
  type ExpectedArrival,
  type VehicleOption,
  type Visit,
} from "@/lib/service-api"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  demoPhoto,
  Empty,
  errMsg,
  ErrorNote,
  fileFromUrl,
  fmtTime,
  km,
  Loading,
  MCard,
  normPlate,
  PhotoCapture,
  PhotoTile,
  Pill,
  SectionTitle,
  StickyActions,
  useLoad,
} from "@/components/mobile/shared"
import { erp } from "@/lib/erp-api"
import { followVehicle } from "@/lib/demo-sync"
import { SignaturePad } from "@/components/mobile/signature-pad"

const STEPS = [
  "Vehicle",
  "Number plate",
  "VIN plate",
  "Odometer",
  "Walk-around",
  "Concerns",
  "Review",
]

const ANGLES = [
  "Front",
  "Rear",
  "Left side",
  "Right side",
  "Front-left 45°",
  "Interior / Dashboard",
]

const FUEL = ["E", "1/4", "1/2", "3/4", "F"]
const CHECKLIST = [
  "Spare wheel",
  "Toolkit",
  "Music system",
  "Floor mats",
  "Valuables removed",
]
const CHIPS = [
  "Periodic service",
  "AC not cooling",
  "Brake noise",
  "Engine warning light",
  "Wheel alignment",
  "Battery weak",
  "Washing & polishing",
  "Suspension noise",
]

type Kind = "plate" | "vin" | "odometer"
type Read = {
  file: File | null
  value: string
  busy: boolean
  read: boolean
  error?: string
}
const emptyRead: Read = { file: null, value: "", busy: false, read: false }

type Subject =
  | { kind: "appointment"; appt: ExpectedArrival }
  | { kind: "walkin"; vehicle: VehicleOption }

export function ArrivalFlow() {
  const params = useSearchParams()
  const preselect = Number(params.get("appointment")) || null
  const selectedVehicle = Number(params.get("v")) || null

  const [step, setStep] = React.useState(0)
  const [subject, setSubject] = React.useState<Subject | null>(null)
  const [reads, setReads] = React.useState<Record<Kind, Read>>({
    plate: emptyRead,
    vin: emptyRead,
    odometer: emptyRead,
  })
  const [captureId, setCaptureId] = React.useState<string | null>(null)
  const [photoTimes, setPhotoTimes] = React.useState<(string | null)[]>([])
  const [angles, setAngles] = React.useState<(File | null)[]>(
    ANGLES.map(() => null)
  )
  const [fuel, setFuel] = React.useState<string | null>(null)
  const [checks, setChecks] = React.useState<string[]>([])
  const [chips, setChips] = React.useState<string[]>([])
  const [notes, setNotes] = React.useState("")
  const [signature, setSignature] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)
  const [submitError, setSubmitError] = React.useState<string | null>(null)
  const [failedChecks, setFailedChecks] = React.useState<GateCheck[]>([])
  const [result, setResult] = React.useState<CheckInResult | null>(null)
  const [checkedIn, setCheckedIn] = React.useState<CheckInResult | null>(null)

  React.useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" })
  }, [step])

  const vehicleId =
    subject?.kind === "appointment"
      ? subject.appt.vehicle_id
      : subject?.vehicle.id
  const expectedReg =
    subject?.kind === "appointment"
      ? subject.appt.reg_no
      : subject?.vehicle.reg_no

  const setRead = (k: Kind, patch: Partial<Read>) =>
    setReads((r) => ({ ...r, [k]: { ...r[k], ...patch } }))

  async function capture(k: Kind, file: File) {
    setRead(k, { file, value: "", busy: true, read: false, error: undefined })
    try {
      const x = await extractGate([file])
      const f = x.fields[k]
      if (k === "plate" || !captureId) setCaptureId(x.capture_id)
      const t = x.images[0]?.taken_at ?? null
      setPhotoTimes((p) => {
        const n = [...p]
        n[k === "plate" ? 0 : k === "vin" ? 1 : 2] = t
        return n
      })
      if (f && f.value != null && f.value !== "") {
        const v =
          k === "plate" ? (f.display ?? String(f.value)) : String(f.value)
        setRead(k, { busy: false, read: true, value: v })
      } else {
        setRead(k, {
          busy: false,
          read: false,
          error: "Couldn't read this photo — retake or type it in.",
        })
      }
    } catch (e) {
      setRead(k, { busy: false, error: errMsg(e) })
    }
  }

  async function applyDemo(k: Kind) {
    if (!vehicleId) return
    try {
      await capture(k, await demoPhoto(vehicleId, k))
    } catch (e) {
      setRead(k, { error: errMsg(e) })
    }
  }

  async function fillSamples() {
    try {
      const samples = await getDamageSamples()
      if (!samples.length) return
      const files = await Promise.all(
        ANGLES.map((a, i) => {
          if (angles[i]) return Promise.resolve(angles[i])
          const s = samples[i % samples.length]
          return fileFromUrl(s.url, `${a.replace(/\W+/g, "-")}.jpg`)
        })
      )
      setAngles(files)
    } catch (e) {
      setSubmitError(errMsg(e))
    }
  }

  async function submit() {
    setSubmitting(true)
    setSubmitError(null)
    setFailedChecks([])
    try {
      const odo = Number(reads.odometer.value.replace(/[^0-9.]/g, ""))
      const r =
        checkedIn ??
        (await service.checkIn(
          {
            plate: reads.plate.value,
            vin: reads.vin.value || null,
            odometer: Number.isFinite(odo) && odo > 0 ? odo : null,
            capture_id: captureId,
            photo_times: photoTimes,
          },
          angles.filter((f): f is File => !!f)
        ))
      setCheckedIn(r)
      await erp.saveInspection(r.visit.id, {
        fuel,
        checklist: Object.fromEntries(
          CHECKLIST.map((c) => [c, checks.includes(c)])
        ),
        signature,
        concerns: [...chips, notes].filter(Boolean).join(". ") || null,
      })
      setResult(r)
    } catch (e) {
      if (e instanceof GateValidationError) {
        setFailedChecks(e.validation.checks.filter((c) => c.level !== "ok"))
        setSubmitError("Gate-in blocked — please fix the details below.")
      } else setSubmitError(errMsg(e))
    } finally {
      setSubmitting(false)
    }
  }

  if (result) {
    return (
      <ArrivalDone
        result={result}
        angleLabels={ANGLES.filter((_, i) => angles[i])}
        concerns={[...chips, notes.trim()].filter(Boolean).join(". ")}
      />
    )
  }

  const canNext = [
    !!subject,
    reads.plate.value.trim().length >= 4,
    true,
    reads.odometer.value.trim() !== "",
    true,
    true,
    true,
  ][step]

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1>Receive a vehicle</h1>
        <p className="mt-1 mb-4 text-sm text-muted-foreground">
          Identify the vehicle, record its condition, then confirm arrival.
        </p>
        <Stepper step={step} />
      </div>

      {step === 0 && (
        <PickVehicle
          preselect={preselect}
          selectedVehicle={selectedVehicle}
          subject={subject}
          onPick={(s) => {
            followVehicle(
              s.kind === "appointment" ? s.appt.vehicle_id : s.vehicle.id
            )
            setSubject(s)
            setReads({ plate: emptyRead, vin: emptyRead, odometer: emptyRead })
            setCaptureId(null)
            if (
              (s.kind === "appointment" ? s.appt.vehicle_id : s.vehicle.id) !==
              vehicleId
            ) {
              setPhotoTimes([])
              setAngles(ANGLES.map(() => null))
              setFuel(null)
              setChecks([])
              setChips([])
              setNotes("")
              setSignature(null)
            }
          }}
        />
      )}

      {(step === 1 || step === 2 || step === 3) && (
        <ReadStep
          k={(["plate", "vin", "odometer"] as const)[step - 1]}
          read={reads[(["plate", "vin", "odometer"] as const)[step - 1]]}
          expectedReg={expectedReg}
          onFile={capture}
          onDemo={vehicleId ? applyDemo : undefined}
          onChange={(k, v) => setRead(k, { value: v })}
        />
      )}

      {step === 4 && (
        <div className="flex flex-col gap-4">
          <div>
            <h2 className="text-lg font-semibold">Walk-around photos</h2>
            <p className="text-sm text-muted-foreground">
              Capture each angle. The condition check runs after gate-in.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 min-[400px]:grid-cols-3">
            {ANGLES.map((a, i) => (
              <PhotoTile
                key={a}
                label={a}
                file={angles[i]}
                onFile={(f) =>
                  setAngles((p) => p.map((x, j) => (j === i ? f : x)))
                }
              />
            ))}
          </div>
          <div className="flex justify-between px-1 text-sm">
            <span className="text-muted-foreground">
              {angles.filter(Boolean).length} of {ANGLES.length} captured
            </span>
            <button
              type="button"
              className="font-medium text-primary"
              onClick={fillSamples}
            >
              Use sample photos
            </button>
          </div>

          <MCard>
            <div className="mb-2 text-sm font-medium">Fuel level</div>
            <div className="grid grid-cols-5 gap-2">
              {FUEL.map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFuel(f)}
                  className={cn(
                    "h-12 rounded-xl border text-sm font-semibold",
                    fuel === f &&
                      "border-primary bg-primary text-primary-foreground"
                  )}
                >
                  {f}
                </button>
              ))}
            </div>
          </MCard>

          <MCard className="p-0">
            <div className="px-4 pt-3 pb-1 text-sm font-medium">
              Inventory checklist
            </div>
            {CHECKLIST.map((c) => {
              const on = checks.includes(c)
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() =>
                    setChecks((p) =>
                      on ? p.filter((x) => x !== c) : [...p, c]
                    )
                  }
                  className="flex min-h-12 w-full items-center gap-3 border-t px-4 text-left text-sm first-of-type:border-t-0"
                >
                  <span
                    className={cn(
                      "flex size-6 items-center justify-center rounded-md border",
                      on && "border-primary bg-primary text-primary-foreground"
                    )}
                  >
                    {on && (
                      <HugeiconsIcon icon={Tick02Icon} className="size-4" />
                    )}
                  </span>
                  {c}
                </button>
              )
            })}
          </MCard>
        </div>
      )}

      {step === 5 && (
        <div className="flex flex-col gap-4">
          <div>
            <h2 className="text-lg font-semibold">Customer concerns</h2>
            <p className="text-sm text-muted-foreground">
              Tap what the customer mentions, add details in their words.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {CHIPS.map((c) => {
              const on = chips.includes(c)
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() =>
                    setChips((p) => (on ? p.filter((x) => x !== c) : [...p, c]))
                  }
                  className={cn(
                    "min-h-10 rounded-full border px-4 text-sm",
                    on &&
                      "border-primary bg-primary/10 font-medium text-primary"
                  )}
                >
                  {c}
                </button>
              )
            })}
          </div>
          <Textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="e.g. Grinding sound from front left when braking at low speed"
            className="min-h-28 text-base"
          />
          <div>
            <div className="mb-2 text-sm font-medium">Customer signature</div>
            <SignaturePad value={signature} onChange={setSignature} />
          </div>
        </div>
      )}

      {step === 6 && (
        <div className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">Review & gate-in</h2>
          <MCard className="flex flex-col gap-2 text-sm">
            <Row
              label="Customer"
              value={
                subject?.kind === "appointment"
                  ? subject.appt.customer_name
                  : subject?.vehicle.customer_name
              }
            />
            <Row
              label="Model"
              value={
                subject?.kind === "appointment"
                  ? subject.appt.model
                  : subject?.vehicle.model
              }
            />
            <Row
              label="Visit type"
              value={
                subject?.kind === "appointment"
                  ? `Appointment · ${fmtTime(subject.appt.slot_start)}`
                  : "Walk-in"
              }
            />
            <Row label="Reg no" value={reads.plate.value} />
            <Row label="VIN" value={reads.vin.value || "—"} />
            <Row
              label="Odometer"
              value={reads.odometer.value ? `${reads.odometer.value} km` : "—"}
            />
            <Row
              label="Walk-around"
              value={`${angles.filter(Boolean).length} photos`}
            />
            <Row label="Fuel" value={fuel ?? "—"} />
            <Row
              label="Inventory"
              value={checks.length ? checks.join(", ") : "—"}
            />
            <Row
              label="Concerns"
              value={[...chips, notes.trim()].filter(Boolean).join(", ") || "—"}
            />
            <Row
              label="Signature"
              value={signature ? "Captured" : "Not captured"}
            />
          </MCard>
          <ErrorNote>{submitError}</ErrorNote>
          {checkedIn && submitError && (
            <p className="text-sm text-warning">
              The vehicle is checked in. Retry saving the inspection details
              below; this will keep the same visit.
            </p>
          )}
          {failedChecks.map((c) => (
            <div
              key={c.code}
              className="flex gap-2 text-sm text-red-700 dark:text-red-300"
            >
              <HugeiconsIcon
                icon={Alert02Icon}
                className="mt-0.5 size-4 shrink-0"
              />
              {c.message}
            </div>
          ))}
        </div>
      )}

      <StickyActions>
        <Button
          variant="outline"
          className="h-12 flex-1 text-base"
          disabled={step === 0 || submitting || !!checkedIn}
          onClick={() => setStep((s) => s - 1)}
        >
          Back
        </Button>
        {step < STEPS.length - 1 ? (
          <Button
            className="h-12 flex-[2] text-base"
            disabled={
              !canNext || Object.values(reads).some((read) => read.busy)
            }
            onClick={() => setStep((s) => s + 1)}
          >
            {step === 2 && !reads.vin.value
              ? "Skip VIN"
              : step === 5
                ? "Review arrival"
                : `Next: ${STEPS[step + 1]}`}
          </Button>
        ) : (
          <Button
            className="h-12 flex-[2] text-base"
            disabled={submitting}
            onClick={submit}
          >
            {submitting
              ? "Saving arrival…"
              : checkedIn
                ? "Retry saving inspection"
                : "Confirm gate-in"}
          </Button>
        )}
      </StickyActions>
    </div>
  )
}

function Row({ label, value }: { label: string; value?: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)] gap-4 border-b py-2 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value ?? "—"}</span>
    </div>
  )
}

function Stepper({ step }: { step: number }) {
  return (
    <div>
      <div className="flex gap-1">
        {STEPS.map((s, i) => (
          <div
            key={s}
            className={cn(
              "h-1.5 flex-1 rounded-full bg-muted",
              i <= step && "bg-primary"
            )}
          />
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-xs text-muted-foreground">
        <span>
          Step {step + 1} of {STEPS.length}
        </span>
        <span className="font-medium text-foreground">{STEPS[step]}</span>
      </div>
    </div>
  )
}

function PickVehicle({
  preselect,
  selectedVehicle,
  subject,
  onPick,
}: {
  preselect: number | null
  selectedVehicle: number | null
  subject: Subject | null
  onPick: (s: Subject) => void
}) {
  const expected = useLoad(() => service.expected(), [], 5000)
  const [q, setQ] = React.useState("")
  const [hits, setHits] = React.useState<VehicleOption[] | null>(null)
  const [searching, setSearching] = React.useState(false)
  const [showAll, setShowAll] = React.useState(false)
  const [searchError, setSearchError] = React.useState<string | null>(null)
  const picked = React.useRef(false)

  React.useEffect(() => {
    if (
      picked.current ||
      (!preselect && !selectedVehicle) ||
      !expected.data ||
      subject
    )
      return
    const a = expected.data.find((x) =>
      preselect ? x.id === preselect : x.vehicle_id === selectedVehicle
    )
    if (a) {
      picked.current = true
      onPick({ kind: "appointment", appt: a })
    }
  }, [preselect, selectedVehicle, expected.data, subject, onPick])

  async function search() {
    if (!q.trim()) return
    setSearching(true)
    setSearchError(null)
    try {
      setHits(await service.vehicles(q.trim()))
    } catch (e) {
      setSearchError(errMsg(e))
    } finally {
      setSearching(false)
    }
  }

  const needle = q.trim().toLowerCase()
  const list = (expected.data ?? []).filter(
    (a) =>
      a.status !== "arrived" &&
      (!needle ||
        normPlate(a.reg_no).includes(normPlate(needle) || "~") ||
        a.customer_name.toLowerCase().includes(needle))
  )

  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Which vehicle is arriving?</h2>
      <div className="flex gap-2">
        <Input
          aria-label="Find arriving vehicle"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
          placeholder="Registration or customer name"
          className="h-12 min-w-0 text-base"
        />
        <Button
          aria-label="Search all vehicles"
          className="h-12 shrink-0 px-4"
          onClick={search}
          disabled={searching || !q.trim()}
        >
          <HugeiconsIcon icon={Search01Icon} className="size-5" />
        </Button>
      </div>
      <ErrorNote onRetry={search}>{searchError}</ErrorNote>
      <SectionTitle>Expected today</SectionTitle>
      {expected.loading && <Loading />}
      <ErrorNote onRetry={expected.reload}>{expected.error}</ErrorNote>
      {expected.data && !list.length && (
        <Empty>No appointments waiting at the gate.</Empty>
      )}
      {(showAll || needle ? list : list.slice(0, 6)).map((a) => {
        const on = subject?.kind === "appointment" && subject.appt.id === a.id
        return (
          <button
            key={a.id}
            type="button"
            onClick={() => onPick({ kind: "appointment", appt: a })}
            className={cn(
              "flex min-h-16 items-center gap-3 rounded-2xl border bg-card p-3 text-left",
              on && "border-primary ring-2 ring-primary/20"
            )}
          >
            <span className="flex size-10 items-center justify-center rounded-xl bg-muted">
              <HugeiconsIcon icon={Calendar03Icon} className="size-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block font-semibold tracking-wide">
                {a.reg_display || a.reg_no}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {a.customer_name} · {a.model}
              </span>
            </span>
            <span className="text-right text-xs">
              <span className="block font-medium">{fmtTime(a.slot_start)}</span>
              <Pill tone={a.mode === "pickup" ? "info" : "neutral"}>
                {a.mode === "pickup" ? "Pickup" : "Walk-in"}
              </Pill>
            </span>
            {on && (
              <HugeiconsIcon
                icon={CheckmarkCircle02Icon}
                className="size-6 text-primary"
              />
            )}
          </button>
        )
      })}

      {!needle && list.length > 6 && (
        <Button
          variant="outline"
          className="h-11"
          onClick={() => setShowAll((value) => !value)}
        >
          {showAll
            ? "Show fewer appointments"
            : `Show all ${list.length} appointments`}
        </Button>
      )}
      {searching && <Loading label="Finding vehicles…" />}
      {hits && <SectionTitle>Vehicle search results</SectionTitle>}
      {hits && !hits.length && <Empty>No vehicle found.</Empty>}
      {hits?.map((v) => {
        const on = subject?.kind === "walkin" && subject.vehicle.id === v.id
        return (
          <button
            key={v.id}
            type="button"
            onClick={() => onPick({ kind: "walkin", vehicle: v })}
            className={cn(
              "flex min-h-14 items-center gap-3 rounded-2xl border bg-card p-3 text-left",
              on && "border-primary ring-2 ring-primary/20"
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="block font-semibold">
                {v.reg_display || v.reg_no}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {v.customer_name} · {v.model} · {km(v.odometer)}
              </span>
            </span>
            {on && (
              <HugeiconsIcon
                icon={CheckmarkCircle02Icon}
                className="size-6 text-primary"
              />
            )}
          </button>
        )
      })}
    </div>
  )
}

const READ_COPY: Record<
  Kind,
  { title: string; hint: string; field: string; placeholder: string }
> = {
  plate: {
    title: "Number plate",
    hint: "Stand 1–2 m in front, plate centred and level",
    field: "Registration number",
    placeholder: "HR26DQ1234",
  },
  vin: {
    title: "VIN plate",
    hint: "VIN is on the driver-side door pillar or under the windscreen",
    field: "VIN (17 characters)",
    placeholder: "MA3XXXXXXXXXXXXXX",
  },
  odometer: {
    title: "Odometer / cluster",
    hint: "Ignition ON, capture the full instrument cluster",
    field: "Odometer (km)",
    placeholder: "42350",
  },
}

function ReadStep({
  k,
  read,
  expectedReg,
  onFile,
  onDemo,
  onChange,
}: {
  k: Kind
  read: Read
  expectedReg?: string
  onFile: (k: Kind, f: File) => void
  onDemo?: (k: Kind) => void
  onChange: (k: Kind, v: string) => void
}) {
  const copy = READ_COPY[k]
  const match =
    k === "plate" && expectedReg && read.value
      ? normPlate(read.value) === normPlate(expectedReg)
      : null
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">{copy.title}</h2>
      <PhotoCapture
        label={`Capture ${copy.title.toLowerCase()}`}
        hint={copy.hint}
        file={read.file}
        busy={read.busy}
        done={read.read}
        onFile={(f) => onFile(k, f)}
        onDemo={onDemo ? () => onDemo(k) : undefined}
      />
      <div className="flex flex-col gap-1.5">
        <label className="px-1 text-sm font-medium">{copy.field}</label>
        <div className="relative">
          <Input
            value={read.value}
            aria-label={copy.field}
            inputMode={k === "odometer" ? "numeric" : "text"}
            onChange={(e) =>
              onChange(
                k,
                k === "odometer" ? e.target.value : e.target.value.toUpperCase()
              )
            }
            placeholder={copy.placeholder}
            className="h-12 pr-10 text-base font-semibold tracking-wide"
          />
          {read.read && (
            <HugeiconsIcon
              icon={CheckmarkCircle02Icon}
              className="absolute top-1/2 right-3 size-5 -translate-y-1/2 text-emerald-600"
            />
          )}
        </div>
        {read.read && (
          <span className="px-1 text-xs text-emerald-700 dark:text-emerald-400">
            Read from photo — check and edit if needed
          </span>
        )}
        {read.error && (
          <span className="px-1 text-xs text-amber-700 dark:text-amber-400">
            {read.error}
          </span>
        )}
        {match === true && (
          <Pill tone="ok" className="self-start">
            Matches appointment
          </Pill>
        )}
        {match === false && (
          <Pill tone="warn" className="self-start">
            Differs from booked {expectedReg}
          </Pill>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- outcome

function describeCondition(c: ConditionReport | null, labels: string[]) {
  if (!c || c.status === "pending") return null
  if (c.available === false || c.error)
    return {
      tone: "neutral" as const,
      lines: ["Condition photos recorded — manual check required."],
    }
  const lines: string[] = []
  c.images.forEach((img, i) => {
    if (!img.detections.length) return
    const counts = new Map<string, number>()
    for (const d of img.detections) {
      const n = d.class_name.replace(/_/g, " ").toLowerCase()
      counts.set(n, (counts.get(n) ?? 0) + 1)
    }
    const what = [...counts]
      .map(([n, k]) => `${k} ${n}${k > 1 && !n.endsWith("s") ? "s" : ""}`)
      .join(", ")
    lines.push(
      `${what} found — ${(labels[i] ?? `photo ${i + 1}`).toLowerCase()}`
    )
  })
  if (!lines.length)
    return { tone: "ok" as const, lines: ["No new damage found"] }
  return { tone: "warn" as const, lines }
}

function ArrivalDone({
  result,
  angleLabels,
  concerns,
}: {
  result: CheckInResult
  angleLabels: string[]
  concerns: string
}) {
  const [visit, setVisit] = React.useState<Visit>(result.visit)
  const [advisor, setAdvisor] = React.useState<string | null>(
    result.visit.advisor_name
  )
  const [jobCard, setJobCard] = React.useState<number | null>(null)
  const started = React.useRef(false)

  React.useEffect(() => {
    if (started.current) return
    started.current = true
    const id = result.visit.id
    ;(async () => {
      if (!result.visit.advisor_name) {
        const best =
          result.advisors.advisors.find((a) => a.available) ??
          result.advisors.advisors[0]
        if (best) {
          try {
            const v = await service.assign(id, best.advisor_id)
            setAdvisor(v.advisor_name ?? best.name)
          } catch {
            setAdvisor(best.name)
          }
        }
      }
      if (concerns) {
        try {
          const jc = await service.createJobCard({
            visit_id: id,
            text: concerns,
            use_llm: false,
          })
          setJobCard(jc.id)
        } catch {
          /* job card can be drafted from the desk */
        }
      }
    })()
  }, [result, concerns])

  const pending = !visit.condition || visit.condition.status === "pending"
  React.useEffect(() => {
    if (!pending) return
    const t = setInterval(() => {
      service.visit(visit.id).then(setVisit, () => {})
    }, 4000)
    return () => clearInterval(t)
  }, [pending, visit.id])

  const cond = describeCondition(visit.condition, angleLabels)

  return (
    <div className="flex flex-col gap-4">
      <MCard className="flex flex-col items-center gap-2 border-emerald-500/30 bg-emerald-500/5 py-6 text-center">
        <span className="flex size-14 items-center justify-center rounded-full bg-emerald-600 text-white">
          <HugeiconsIcon icon={CheckmarkCircle02Icon} className="size-8" />
        </span>
        <div className="text-lg font-semibold">
          Gate-in done · Visit #{visit.id}
        </div>
        <div className="text-sm text-muted-foreground">
          {visit.reg_no} · {visit.model} · {visit.customer_name}
        </div>
        <div className="text-sm font-medium">
          {advisor ? `Assigned advisor: ${advisor}` : "Assigning advisor…"}
        </div>
        <Link
          href={`/m/inspect?visit=${visit.id}`}
          className="text-sm font-medium text-primary"
        >
          Inspect damage with close-ups →
        </Link>
        {result.walk_in && <Pill>Walk-in</Pill>}
      </MCard>

      <MCard>
        <div className="mb-2 text-sm font-medium">Vehicle condition</div>
        {pending ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="size-2 animate-pulse rounded-full bg-primary" />
            Checking walk-around photos…
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {cond?.lines.map((l) => (
              <Pill
                key={l}
                tone={cond.tone}
                className="self-start px-3 py-1 text-sm first-letter:uppercase"
              >
                {l}
              </Pill>
            ))}
          </div>
        )}
      </MCard>

      {jobCard && (
        <MCard className="text-sm">
          Job card <span className="font-semibold">#{jobCard}</span> drafted
          with customer concerns.
        </MCard>
      )}

      <div className="flex flex-col gap-2">
        <Link href={`/m/vehicle/${visit.vehicle_id}`}>
          <Button variant="outline" className="h-12 w-full text-base">
            Open vehicle
          </Button>
        </Link>
        <Button
          className="h-12 w-full text-base"
          onClick={() => window.location.assign("/m/arrival")}
        >
          Next arrival
        </Button>
      </div>
    </div>
  )
}
