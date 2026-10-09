"use client"

import * as React from "react"
import Link from "next/link"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  Login01Icon,
  Logout01Icon,
} from "@hugeicons/core-free-icons"

import { extractGate, GateValidationError, type GateCheck } from "@/lib/api"
import { service } from "@/lib/service-api"
import { erp, type BoardCard } from "@/lib/erp-api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useJourney } from "@/components/erp/journey"
import {
  demoPhoto,
  Empty,
  errMsg,
  ErrorNote,
  fmtTime,
  MCard,
  normPlate,
  PhotoCapture,
  Pill,
  SectionTitle,
  useLoad,
  Loading,
} from "@/components/mobile/shared"

type Kind = "plate" | "vin" | "odometer"

const STEPS: {
  kind: Kind
  label: string
  hint: string
  placeholder: string
}[] = [
  {
    kind: "plate",
    label: "Number plate",
    hint: "Front plate, centred and level",
    placeholder: "Reg no",
  },
  {
    kind: "vin",
    label: "VIN plate",
    hint: "Windscreen corner or door-pillar sticker",
    placeholder: "17-character VIN",
  },
  {
    kind: "odometer",
    label: "Odometer",
    hint: "Ignition on, cluster readable",
    placeholder: "Km reading",
  },
]

type Read = { file: File | null; value: string; read: boolean; busy: boolean }
const EMPTY: Read = { file: null, value: "", read: false, busy: false }

export function GateScreen() {
  const { focusId } = useJourney()
  const expected = useLoad(() => service.expected(), [], 5000)
  const board = useLoad(() => erp.board(), [], 5000)
  const exits = useLoad(() => erp.gateOutsToday(), [], 5000)
  const [reads, setReads] = React.useState<Record<Kind, Read>>({
    plate: EMPTY,
    vin: EMPTY,
    odometer: EMPTY,
  })
  const [captureId, setCaptureId] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [checks, setChecks] = React.useState<GateCheck[]>([])
  const [done, setDone] = React.useState<{
    text: string
    checks: { level: string; message: string }[]
  } | null>(null)
  const [acting, setActing] = React.useState(false)
  const [captureStep, setCaptureStep] = React.useState<Kind>("plate")
  const reading = Object.values(reads).some((read) => read.busy)
  const queueUnavailable =
    expected.loading || board.loading || !!expected.error || !!board.error

  const delivered =
    board.data?.stages.find((s) => s.key === "delivered")?.cards ?? []
  const ready = board.data?.stages.find((s) => s.key === "ready")?.cards ?? []
  const waiting = (expected.data ?? []).filter((a) => a.status !== "arrived")
  const exited = new Set((exits.data ?? []).map((e) => e.job_card_id))
  const toExit = delivered.filter((c) => !exited.has(c.job_card_id ?? -1))

  const plate = reads.plate.value
  const key = normPlate(plate)
  const appt = key
    ? waiting.find((a) => normPlate(a.reg_no) === key)
    : undefined
  const exitCard = key
    ? toExit.find((c) => normPlate(c.reg_no) === key)
    : undefined
  const readyCard = key
    ? ready.find((c) => normPlate(c.reg_no) === key)
    : undefined
  const odometer = Number(reads.odometer.value.replace(/[^0-9]/g, "")) || null
  const vin = normPlate(reads.vin.value) || null
  const captured = [
    reads.plate.value,
    reads.vin.value,
    reads.odometer.value,
  ].filter(Boolean).length

  const set = (k: Kind, patch: Partial<Read>) =>
    setReads((r) => ({ ...r, [k]: { ...r[k], ...patch } }))

  function reset() {
    setCaptureStep("plate")
    setReads({ plate: EMPTY, vin: EMPTY, odometer: EMPTY })
    setCaptureId(null)
    setChecks([])
    setError(null)
  }

  async function scan(k: Kind, f: File) {
    set(k, { file: f, value: "", busy: true, read: false })
    setError(null)
    setDone(null)
    try {
      const x = await extractGate([f])
      setCaptureId((c) => c ?? x.capture_id)
      const field = x.fields[k]
      if (field?.value != null) {
        set(k, { value: String(field.display ?? field.value), read: true })
      } else {
        setError(
          `Couldn't read the ${STEPS.find((s) => s.kind === k)?.label.toLowerCase()} — retake or type it in.`
        )
      }
    } catch (e) {
      setError(errMsg(e))
    } finally {
      set(k, { busy: false })
    }
  }

  async function demo(k: Kind) {
    const vid =
      appt?.vehicle_id ??
      exitCard?.vehicle_id ??
      focusId ??
      waiting[0]?.vehicle_id ??
      toExit[0]?.vehicle_id
    if (!vid) return setError("No demo vehicle available.")
    try {
      await scan(k, await demoPhoto(vid, k))
    } catch (e) {
      setError(errMsg(e))
    }
  }

  async function gateIn() {
    setActing(true)
    setError(null)
    setChecks([])
    try {
      const r = await service.checkIn(
        { plate, vin, odometer, capture_id: captureId },
        []
      )
      const adv = r.visit.advisor_name
      setDone({
        text: `Gate-in done · ${r.visit.reg_no} · Visit #${r.visit.id}${adv ? ` · Advisor: ${adv}` : ""}`,
        checks: r.validation.checks
          .filter((c) => c.level !== "ok")
          .concat(
            r.validation.checks.filter((c) => c.level === "ok").slice(0, 3)
          ),
      })
      reset()
      expected.reload()
    } catch (e) {
      if (e instanceof GateValidationError)
        setChecks(e.validation.checks.filter((c) => c.level !== "ok"))
      else setError(errMsg(e))
    } finally {
      setActing(false)
    }
  }

  async function gateOut(c: BoardCard) {
    setActing(true)
    setError(null)
    try {
      const r = await erp.gateOut(c.vehicle_id, {
        plate: plate || c.reg_no,
        vin,
        odometer,
      })
      setDone({
        text: `Gate-out recorded · ${c.reg_display || c.reg_no} · ${fmtTime(r.at)}`,
        checks: r.checks,
      })
      reset()
      exits.reload()
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setActing(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Gate</h1>
        <p className="text-sm text-muted-foreground">
          Capture number plate, VIN and odometer for every vehicle in or out.
        </p>
      </div>

      {done && (
        <MCard className="flex flex-col gap-2 border-emerald-500/30 bg-emerald-500/5">
          <div className="flex items-center gap-2 text-sm font-medium">
            <HugeiconsIcon
              icon={CheckmarkCircle02Icon}
              className="size-5 text-emerald-600"
            />
            {done.text}
          </div>
          {done.checks.map((ch, i) => (
            <p key={i} className="text-xs text-muted-foreground">
              {ch.level === "ok" ? "✓" : "!"} {ch.message}
            </p>
          ))}
        </MCard>
      )}

      <div
        className="grid grid-cols-3 gap-2"
        aria-label="Vehicle capture steps"
      >
        {STEPS.map((s, i) => (
          <button
            key={s.kind}
            type="button"
            disabled={reading}
            aria-pressed={captureStep === s.kind}
            onClick={() => setCaptureStep(s.kind)}
            className={`min-h-16 rounded-xl border px-2 py-2 text-left ${captureStep === s.kind ? "border-primary bg-primary text-primary-foreground" : "bg-card"}`}
          >
            <span className="block text-xs opacity-70">
              {reads[s.kind].value ? "✓ Captured" : `Step ${i + 1}`}
            </span>
            <span className="mt-1 block text-sm font-semibold">
              {s.kind === "vin" ? "VIN" : s.label}
            </span>
          </button>
        ))}
      </div>
      {STEPS.filter((s) => s.kind === captureStep).map((s) => (
        <MCard key={s.kind} className="flex flex-col gap-2 p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">{s.label}</span>
            {reads[s.kind].read && <Pill tone="ok">Read from photo</Pill>}
          </div>
          <PhotoCapture
            label={`Photograph ${s.label.toLowerCase()}`}
            hint={s.hint}
            file={reads[s.kind].file}
            busy={reads[s.kind].busy}
            done={reads[s.kind].read}
            onFile={(f) => scan(s.kind, f)}
            onDemo={() => demo(s.kind)}
          />
          <Input
            value={reads[s.kind].value}
            aria-label={s.label}
            disabled={reading || acting}
            inputMode={s.kind === "odometer" ? "numeric" : "text"}
            onChange={(e) => {
              set(s.kind, {
                value:
                  s.kind === "odometer"
                    ? e.target.value
                    : e.target.value.toUpperCase(),
                read: false,
              })
              setDone(null)
            }}
            placeholder={s.placeholder}
            className="h-11 text-base font-semibold tracking-wide"
          />
          {captureStep !== "odometer" && (
            <Button
              variant="outline"
              className="mt-1 h-11"
              disabled={reading}
              onClick={() =>
                setCaptureStep(captureStep === "plate" ? "vin" : "odometer")
              }
            >
              Next: {captureStep === "plate" ? "VIN" : "Odometer"}
            </Button>
          )}
        </MCard>
      ))}

      <ErrorNote>{error}</ErrorNote>
      <ErrorNote
        onRetry={() => {
          expected.reload()
          board.reload()
        }}
      >
        {expected.error ?? board.error}
      </ErrorNote>
      {checks.length > 0 && (
        <MCard className="flex flex-col gap-1 border-destructive/30 bg-destructive/5 text-sm">
          <div className="flex items-center gap-2 font-medium text-destructive">
            <HugeiconsIcon icon={Alert02Icon} className="size-4" /> Gate blocked
          </div>
          {checks.map((c, i) => (
            <p key={i}>{c.message}</p>
          ))}
        </MCard>
      )}

      {queueUnavailable && !expected.error && !board.error && (
        <Loading label="Checking the gate queue…" />
      )}
      {key.length >= 4 && !queueUnavailable && (
        <MCard className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">{captured}/3 captured</p>
          {appt ? (
            <>
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-semibold">
                    {appt.reg_display || appt.reg_no}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {appt.customer_name} · {appt.model}
                  </div>
                </div>
                <Pill tone="info">Appointment {fmtTime(appt.slot_start)}</Pill>
              </div>
              <Button
                className="h-12 text-base"
                onClick={gateIn}
                disabled={acting || reading || !odometer}
              >
                <HugeiconsIcon icon={Login01Icon} className="size-5" />
                {acting
                  ? "Gating in…"
                  : odometer
                    ? "Gate-in"
                    : "Capture odometer to gate in"}
              </Button>
              <Link
                href={`/m/arrival?appointment=${appt.id}`}
                className="text-center text-sm font-medium text-primary"
              >
                Hand over to advisor for full walk-around
              </Link>
            </>
          ) : exitCard ? (
            <>
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-semibold">
                    {exitCard.reg_display || exitCard.reg_no}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {exitCard.customer_name} · {exitCard.model}
                  </div>
                </div>
                <Pill tone="ok">Delivered · cleared</Pill>
              </div>
              <Button
                className="h-12 text-base"
                onClick={() => gateOut(exitCard)}
                disabled={acting || reading || !vin || !odometer}
              >
                <HugeiconsIcon icon={Logout01Icon} className="size-5" />
                {acting
                  ? "Checking…"
                  : vin && odometer
                    ? "Gate-out"
                    : "Capture VIN and odometer to gate out"}
              </Button>
            </>
          ) : readyCard ? (
            <div className="text-sm">
              <Pill tone="warn">Not cleared</Pill>
              <p className="mt-2">
                {readyCard.reg_display || readyCard.reg_no} is ready but not yet
                billed/delivered. Do not allow exit.
              </p>
            </div>
          ) : (
            <>
              <div className="text-sm">
                <Pill>No appointment</Pill>
                <p className="mt-2 text-muted-foreground">
                  Vehicle not expected today — gate in as walk-in.
                </p>
              </div>
              <Button
                variant="outline"
                className="h-12 text-base"
                onClick={gateIn}
                disabled={acting || reading || !odometer}
              >
                {acting
                  ? "Gating in…"
                  : odometer
                    ? "Gate-in as walk-in"
                    : "Capture odometer to gate in"}
              </Button>
            </>
          )}
        </MCard>
      )}

      <section>
        <SectionTitle>Cleared for gate-out ({toExit.length})</SectionTitle>
        <ErrorNote>{board.error}</ErrorNote>
        {board.data && !toExit.length && (
          <Empty>No delivered vehicles waiting to exit.</Empty>
        )}
        <div className="flex flex-col gap-2">
          {toExit.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => {
                reset()
                set("plate", { value: c.reg_display || c.reg_no })
                setDone(null)
                window.scrollTo({ top: 0, behavior: "smooth" })
              }}
              className="flex min-h-14 items-center gap-3 rounded-2xl border bg-card p-3 text-left"
            >
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{c.reg_display || c.reg_no}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {c.customer_name} · {c.model}
                </div>
              </div>
              <span className="text-xs font-medium text-primary">
                Capture & exit
              </span>
            </button>
          ))}
        </div>
      </section>

      <section>
        <SectionTitle>Expected at gate ({waiting.length})</SectionTitle>
        <div className="flex flex-col gap-2">
          {waiting.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => {
                reset()
                set("plate", { value: a.reg_display || a.reg_no })
                setDone(null)
                window.scrollTo({ top: 0, behavior: "smooth" })
              }}
              className="flex min-h-14 items-center gap-3 rounded-2xl border bg-card p-3 text-left"
            >
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{a.reg_display || a.reg_no}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {a.customer_name} · {a.model}
                </div>
              </div>
              <span className="text-xs font-medium">
                {fmtTime(a.slot_start)}
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  )
}
