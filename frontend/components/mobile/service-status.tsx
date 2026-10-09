"use client"

import * as React from "react"
import { erp, type Vehicle360 } from "@/lib/erp-api"
import { service } from "@/lib/service-api"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  ErrorNote,
  MCard,
  Pill,
  fmtDate,
  fmtTime,
  inr,
  useLoad,
} from "./shared"

const PHASES = [
  "Booking",
  "Pickup",
  "Arrival",
  "Estimate",
  "Workshop",
  "Delivery",
]
const PICKUP_LABEL: Record<string, string> = {
  booked: "Your pickup is scheduled",
  en_route: "Your driver is on the way",
  at_customer: "Your driver has arrived",
  collected: "Your car is on the way to the workshop",
  at_gate: "Your car is at the workshop gate",
  arrived: "Your car has checked in",
}

export function ServiceStatus({
  vehicleId,
  record,
}: {
  vehicleId: number
  record?: Vehicle360 | null
}) {
  const journey = useLoad(() => erp.journey(vehicleId), [vehicleId], 5000)
  const pickups = useLoad(() => service.pickups(), [vehicleId], 5000)
  const j = journey.data
  const appointment = record?.appointments.find(
    (a) => a.id === j?.appointment_id
  )
  const pickup = pickups.data?.pickups.find(
    (p) => p.appointment_id === j?.appointment_id
  )
  const estimate = useLoad(
    () =>
      j?.job_card_id ? service.jobCard(j.job_card_id) : Promise.resolve(null),
    [j?.job_card_id],
    5000
  )
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const job = estimate.data?.id === j?.job_card_id ? estimate.data : null
  if (
    !j ||
    j.vehicle.id !== vehicleId ||
    (!j.appointment_id && !j.visit_id && !j.job_card_id)
  )
    return <ErrorNote>{journey.error}</ErrorNote>
  const phase =
    j.step === "delivery"
      ? 5
      : j.step === "workshop"
        ? 4
        : j.step === "job_card"
          ? j.job_card_id
            ? 3
            : 2
          : j.step === "arrival"
            ? 2
            : j.step === "pickup"
              ? 1
              : 0

  async function approve() {
    if (!job) return
    setBusy(true)
    setError(null)
    try {
      await service.approve(job.id)
      estimate.reload()
      journey.reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <MCard className="flex flex-col gap-4 border-emerald-600/20">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-medium text-emerald-700">
            Your service journey
          </div>
          <h2 className="mt-1 text-lg font-semibold">
            {pickup && phase <= 2
              ? (PICKUP_LABEL[pickup.status] ?? j.status)
              : j.status}
          </h2>
          {appointment && (
            <p className="mt-1 text-sm text-muted-foreground">
              {fmtDate(appointment.slot_start)} ·{" "}
              {fmtTime(appointment.slot_start)}
            </p>
          )}
        </div>
        <Pill tone="ok">Live</Pill>
      </div>
      <ol className="grid grid-cols-3 gap-2" aria-label="Service progress">
        {PHASES.map((label, i) => (
          <li
            key={label}
            aria-current={i === phase ? "step" : undefined}
            className={cn(
              "rounded-lg border px-2 py-2 text-xs",
              i < phase
                ? "border-emerald-600/20 bg-emerald-600/5 text-emerald-700"
                : i === phase
                  ? "border-primary bg-primary font-semibold text-primary-foreground"
                  : "text-muted-foreground"
            )}
          >
            <span className="mr-1.5">{i < phase ? "✓" : i + 1}</span>
            {label}
          </li>
        ))}
      </ol>
      {(j.driver || j.advisor) && (
        <div className="grid gap-2 text-sm">
          {j.driver && (
            <div>
              <span className="text-muted-foreground">Pickup driver: </span>
              {j.driver}
            </div>
          )}
          {j.advisor && (
            <div>
              <span className="text-muted-foreground">Service advisor: </span>
              {j.advisor}
            </div>
          )}
        </div>
      )}
      {pickup?.eta && phase <= 2 && (
        <div className="rounded-xl bg-muted p-3 text-sm">
          {pickup.status === "at_customer"
            ? "Driver arrived at your address"
            : pickup.status === "at_gate"
              ? "Awaiting workshop check-in"
              : `${pickup.leg === "to_customer" ? "Driver arrival" : "Workshop arrival"}: ${fmtTime(pickup.eta)}`}
          {pickup.risk === "no_signal" && (
            <p className="mt-1 text-xs text-amber-700">
              Waiting for a fresh location update.
            </p>
          )}
        </div>
      )}
      {appointment?.qr_token && phase <= 2 && (
        <div className="rounded-xl bg-muted p-3">
          <div className="text-xs text-muted-foreground">
            Service pass · show at handover or the gate
          </div>
          <div className="mt-1 font-mono text-xl font-semibold tracking-wider break-all">
            {appointment.qr_token}
          </div>
        </div>
      )}
      {appointment?.concerns && (
        <div className="text-sm">
          <span className="text-muted-foreground">Your concerns: </span>
          {appointment.concerns}
        </div>
      )}
      {job && phase === 3 && (
        <div className="flex flex-col gap-3 border-t pt-3">
          <div className="flex items-center justify-between text-sm">
            <span>Service estimate</span>
            <strong>{inr(job.payload.estimate.totals.customer_payable)}</strong>
          </div>
          <p className="text-xs text-muted-foreground">
            Review the proposed work before we begin.
          </p>
          <ul className="space-y-1 text-sm">
            {job.payload.estimate.lines.map((item, i) => (
              <li key={i} className="flex justify-between gap-2">
                <span>{item.desc}</span>
                <span>{inr(item.amount)}</span>
              </li>
            ))}
          </ul>
          <ErrorNote>{error}</ErrorNote>
          {job.status === "draft" ? (
            <Button className="h-11" disabled={busy} onClick={approve}>
              {busy ? "Approving…" : "Approve estimate"}
            </Button>
          ) : (
            <Pill tone="ok">
              Estimate approved · workshop preparation underway
            </Pill>
          )}
        </div>
      )}
      {j.promised && phase >= 2 && phase < 5 && (
        <p className="text-sm text-muted-foreground">
          Expected ready: {fmtDate(j.promised)} · {fmtTime(j.promised)}
        </p>
      )}
      {phase === 5 && (
        <p className="text-sm text-muted-foreground">
          {j.invoice
            ? `Invoice ${j.invoice}`
            : "Your advisor will help with billing and collection."}
        </p>
      )}
    </MCard>
  )
}
