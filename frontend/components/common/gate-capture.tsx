"use client"

import * as React from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Alert02Icon,
  CheckmarkCircle02Icon,
  Clock01Icon,
  ScanIcon,
} from "@hugeicons/core-free-icons"
import { toast } from "sonner"

import {
  extractGate,
  GateValidationError,
  validateGate,
  type GateDirection,
  type GateEntry,
  type GateExtract,
  type GateValidation,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { CheckList } from "@/components/common/check-list"
import { PhotoSlot, urlToFile } from "@/components/common/photo-slot"
import { AssistChip } from "@/components/erp/journey"

const SLOTS = [
  {
    key: "plate",
    label: "Vehicle / plate",
    hint: "Front or rear, plate readable",
  },
  { key: "vin", label: "VIN plate", hint: "Windshield or door-jamb sticker" },
  { key: "odometer", label: "Odometer", hint: "Cluster with ignition on" },
] as const

type SlotKey = (typeof SLOTS)[number]["key"]
const EMPTY: Record<SlotKey, File | null> = {
  plate: null,
  vin: null,
  odometer: null,
}

/** Read-from-photo marker: a tick when the value is clear, a warning to double-check. */
function ConfidenceBadge({ value }: { value?: number | null }) {
  if (value == null) return null
  const ok = value >= 0.8
  return (
    <span
      title={ok ? "Read from photo" : "Please verify against the photo"}
      className={
        ok
          ? "inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400"
          : "inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400"
      }
    >
      <HugeiconsIcon
        icon={ok ? CheckmarkCircle02Icon : Alert02Icon}
        strokeWidth={2}
        className="size-3.5"
      />
      {ok ? null : "Verify"}
    </span>
  )
}

/**
 * The one gate capture flow: photos -> on-device OCR -> editable fields -> live
 * validation against the trip log, vehicle master and clock -> confirm.
 * Used by the Hub Gate, the chauffeur pickup handover and workshop reception.
 */
export function GateCapture({
  direction,
  walkIn = false,
  title = "Gate capture",
  description,
  confirmLabel,
  demoVehicleId,
  header,
  onCommit,
  variant = "cards",
  beforeConfirm,
  assistUc,
  demoLabel = "Sample photos",
  checksTitle = "Checks",
}: {
  /** "inline" drops the card chrome so the capture can sit inside a larger flow. */
  variant?: "cards" | "inline"
  /** Rendered between the checks and the confirm button (e.g. walk-around photos). */
  beforeConfirm?: React.ReactNode
  /** Show the photo-read outcome as an assist chip for this use case. */
  assistUc?: number
  demoLabel?: string
  checksTitle?: string
  direction: GateDirection
  /** Workshop gate: a customer car may arrive without an open trip. */
  walkIn?: boolean
  title?: string
  description?: string
  confirmLabel?: string
  /** Offer rendered demo photos of this vehicle (for presentations). */
  demoVehicleId?: number | null
  header?: React.ReactNode
  onCommit: (entry: GateEntry) => Promise<void>
}) {
  const [photos, setPhotos] = React.useState(EMPTY)
  const [scan, setScan] = React.useState<GateExtract | null>(null)
  const [scanning, setScanning] = React.useState(false)
  const [plate, setPlate] = React.useState("")
  const [vin, setVin] = React.useState("")
  const [odo, setOdo] = React.useState("")
  const [edited, setEdited] = React.useState<Record<string, boolean>>({})
  const [validation, setValidation] = React.useState<GateValidation | null>(
    null
  )
  const [saving, setSaving] = React.useState(false)
  const [clock, setClock] = React.useState<Date | null>(null)

  React.useEffect(() => {
    const tick = () => setClock(new Date())
    const first = window.setTimeout(tick, 0)
    const id = window.setInterval(tick, 1000)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(id)
    }
  }, [])

  const entry = React.useMemo<GateEntry>(
    () => ({
      plate,
      vin: vin || null,
      odometer: odo ? Number(odo) : null,
      capture_id: scan?.capture_id ?? null,
      photo_times: scan?.images.map((i) => i.taken_at) ?? [],
      confidences: {
        registration: edited.plate
          ? null
          : (scan?.fields.plate?.confidence ?? null),
        VIN: edited.vin ? null : (scan?.fields.vin?.confidence ?? null),
        odometer: edited.odo
          ? null
          : (scan?.fields.odometer?.confidence ?? null),
      },
    }),
    [plate, vin, odo, scan, edited]
  )

  // Re-validate whenever the fields change.
  React.useEffect(() => {
    if (!plate.trim()) return
    let active = true
    const t = window.setTimeout(() => {
      validateGate(direction, entry, walkIn)
        .then((v) => active && setValidation(v))
        .catch(() => undefined)
    }, 350)
    return () => {
      active = false
      window.clearTimeout(t)
    }
  }, [direction, entry, plate, walkIn])

  function reset() {
    setPhotos(EMPTY)
    setScan(null)
    setPlate("")
    setVin("")
    setOdo("")
    setEdited({})
    setValidation(null)
  }

  async function loadDemo() {
    if (!demoVehicleId) return
    try {
      const files = await Promise.all(
        SLOTS.map((s) =>
          urlToFile(
            `/api/service/demo/photos/${demoVehicleId}/${s.key}?t=${Date.now()}`,
            `${s.key}.jpg`
          )
        )
      )
      setPhotos({ plate: files[0], vin: files[1], odometer: files[2] })
      toast.success("Sample photos loaded")
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not load sample photos"
      )
    }
  }

  async function runOcr() {
    const files = SLOTS.map((s) => photos[s.key]).filter((f): f is File =>
      Boolean(f)
    )
    if (!files.length) {
      toast.error("Add at least one photo")
      return
    }
    setScanning(true)
    try {
      const result = await extractGate(files)
      setScan(result)
      setEdited({})
      setPlate(result.fields.plate?.value ?? "")
      setVin(result.fields.vin?.value ?? "")
      setOdo(result.fields.odometer ? String(result.fields.odometer.value) : "")
      const found = ["plate", "vin", "odometer"].filter(
        (k) => result.fields[k as keyof GateExtract["fields"]]
      ).length
      toast.success(`Filled ${found} of 3 fields from photos`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not read photos")
    } finally {
      setScanning(false)
    }
  }

  async function confirm() {
    setSaving(true)
    try {
      await onCommit(entry)
      reset()
    } catch (err) {
      if (err instanceof GateValidationError) {
        setValidation(err.validation)
        toast.error("Please resolve the highlighted checks")
      } else {
        toast.error(err instanceof Error ? err.message : "Save failed")
      }
    } finally {
      setSaving(false)
    }
  }

  const f = scan?.fields
  const blocking = validation?.checks.some((c) => c.level === "error") ?? true
  const shownChecks = plate.trim() ? validation?.checks : undefined
  const inline = variant === "inline"
  const readCount = f
    ? [f.plate, f.vin, f.odometer].filter(Boolean).length
    : 0

  const photosBlock = (
    <>
      <div className={inline ? "grid max-w-2xl grid-cols-3 gap-3" : "grid grid-cols-3 gap-3"}>
        {SLOTS.map((s) => (
          <PhotoSlot
            key={s.key}
            label={s.label}
            hint={s.hint}
            file={photos[s.key]}
            disabled={scanning}
            onChange={(file) => setPhotos((p) => ({ ...p, [s.key]: file }))}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          className={inline ? undefined : "flex-1"}
          onClick={runOcr}
          disabled={scanning}
        >
          <HugeiconsIcon
            icon={ScanIcon}
            strokeWidth={2}
            data-icon="inline-start"
          />
          {scanning ? "Reading…" : "Read photos"}
        </Button>
        {demoVehicleId ? (
          <Button variant="outline" onClick={loadDemo} disabled={scanning}>
            {demoLabel}
          </Button>
        ) : null}
        {assistUc && scan ? (
          <AssistChip uc={assistUc}>
            Read {readCount} of 3 from photos
            {f?.plate ? ` · ${f.plate.value}` : ""}
          </AssistChip>
        ) : null}
      </div>
    </>
  )

  const fieldsBlock = (
    <div className={inline ? "grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-3" : "space-y-4"}>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="gate-plate">Registration number</Label>
          <ConfidenceBadge value={edited.plate ? null : f?.plate?.confidence} />
        </div>
        <Input
          id="gate-plate"
          value={plate}
          placeholder="HR26DK4821"
          className="font-mono uppercase"
          onChange={(e) => {
            setPlate(e.target.value.toUpperCase())
            setEdited((x) => ({ ...x, plate: true }))
          }}
        />
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="gate-vin">VIN</Label>
          <ConfidenceBadge value={edited.vin ? null : f?.vin?.confidence} />
        </div>
        <Input
          id="gate-vin"
          value={vin}
          maxLength={17}
          placeholder="17 characters"
          className="font-mono uppercase"
          onChange={(e) => {
            setVin(e.target.value.toUpperCase())
            setEdited((x) => ({ ...x, vin: true }))
          }}
        />
        {!edited.vin && (f?.vin?.read_length ?? 17) > 17 ? (
          <p className="text-xs text-muted-foreground">
            Sticker read {f?.vin?.read_length} characters; a VIN has 17. Check
            which one is extra.
          </p>
        ) : null}
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="gate-odo">Odometer (km)</Label>
          <ConfidenceBadge
            value={edited.odo ? null : f?.odometer?.confidence}
          />
        </div>
        <Input
          id="gate-odo"
          value={odo}
          inputMode="numeric"
          placeholder="e.g. 45678"
          className="font-mono tabular-nums"
          onChange={(e) => {
            setOdo(e.target.value.replace(/\D/g, ""))
            setEdited((x) => ({ ...x, odo: true }))
          }}
        />
      </div>
    </div>
  )

  const checksBody = shownChecks?.length ? (
    <CheckList checks={shownChecks} />
  ) : (
    <p className="text-sm text-muted-foreground">
      Enter or read the registration number to run checks.
    </p>
  )

  const confirmRow = (
    <div className="flex gap-2">
      <Button
        className="flex-1"
        disabled={!plate.trim() || !odo || blocking || saving}
        onClick={confirm}
      >
        {saving
          ? "Saving…"
          : (confirmLabel ??
            (direction === "checkout"
              ? "Confirm check-out"
              : "Confirm check-in"))}
      </Button>
      <Button variant="outline" onClick={reset} disabled={saving}>
        Clear
      </Button>
    </div>
  )

  if (inline) {
    return (
      <div className="space-y-4">
        {header}
        {photosBlock}
        {fieldsBlock}
        <div className="rounded-xl border bg-muted/30 px-4 py-3">
          <p className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {checksTitle}
          </p>
          {checksBody}
        </div>
        {beforeConfirm}
        {confirmRow}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          {description ? (
            <CardDescription>{description}</CardDescription>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-5">
          {header}
          {photosBlock}
          <Separator />
          {fieldsBlock}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{checksTitle}</CardTitle>
          <CardDescription className="flex items-center gap-1.5">
            <HugeiconsIcon
              icon={Clock01Icon}
              strokeWidth={2}
              className="size-3.5"
            />
            System time{" "}
            <span className="font-mono">
              {clock
                ? clock.toLocaleString([], {
                    dateStyle: "medium",
                    timeStyle: "medium",
                  })
                : "—"}
            </span>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {checksBody}
          {beforeConfirm}
          {confirmRow}
        </CardContent>
      </Card>
    </div>
  )
}
