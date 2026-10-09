"use client"

import * as React from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowRight01Icon,
  CheckmarkCircle02Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons"
import { toast } from "sonner"

import {
  service,
  type Allocation,
  type Appointment,
  type Concern,
  type DemandCode,
  type EstimateLine,
  type Interpretation,
  type JobCard,
  type JobCardSummary,
  type PartAvailability,
  type Visit,
} from "@/lib/service-api"
import { clock, dayTime, inr, todayIso } from "@/lib/format"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { CheckList } from "@/components/common/check-list"
import { ConditionPanel } from "@/components/service/condition-panel"
import { Empty, StatusBadge, useAsync, Why } from "@/components/service/shared"
import {
  AssistChip,
  FollowButton,
  Plate,
  useJourney,
} from "@/components/erp/journey"

// ------------------------------------------------------------------ helpers

type Source = {
  vehicle_id: number
  visit_id?: number
  appointment_id?: number
  reg: string
  model: string
  customer: string
  advisor?: string | null
  at?: string | null
  odometer?: number | null
  text: string
}

/** Concerns the car or its record raised, not the customer. */
const VEHICLE_SOURCES = new Set(["telemetry model", "history"])
/** Below this the interpreter is guessing: the advisor confirms. Mirrors backend SUFFICIENT. */
const CONFIRM_BELOW = 0.6
/** Requests, not symptoms: these are quoted as work, not as an inspection. */
const REQUEST_CODES = new Set(["PMS", "WASH"])

const CARD = "rounded-xl border bg-card shadow-[0_1px_2px_rgba(0,0,0,.03)]"

/** "DL8CJG3001" → "DL 8C JG 3001" for the plate. */
function plateText(reg: string) {
  const m = reg.replace(/\s+/g, "").match(/^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{1,4})$/)
  return m ? [m[1], m[2], m[3], m[4]].filter(Boolean).join(" ") : reg
}

function waited(iso?: string | null) {
  if (!iso) return ""
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  return h < 24 ? `${h} h ${mins % 60} min` : dayTime(iso)
}

function errMsg(e: unknown) {
  return e instanceof Error ? e.message : "Failed"
}

const PAYER: Record<EstimateLine["payer"], { label: string; cls: string }> = {
  customer: { label: "Customer", cls: "border bg-background text-foreground" },
  warranty: { label: "Warranty", cls: "bg-success/10 text-success" },
  campaign: { label: "Campaign", cls: "bg-primary/10 text-primary" },
}

function PayerBadge({ payer }: { payer: EstimateLine["payer"] }) {
  const p = PAYER[payer]
  return (
    <span
      className={cn(
        "inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium",
        p.cls
      )}
    >
      {p.label}
    </span>
  )
}

const SOURCING: Record<PartAvailability["status"], { label: string; cls: string }> = {
  available: { label: "Own stock", cls: "bg-success/10 text-success" },
  alternative: { label: "OEM alternative", cls: "bg-primary/10 text-primary" },
  transfer: { label: "Network transfer", cls: "bg-accent text-accent-foreground" },
  order: { label: "Order from Maruti", cls: "bg-warning/10 text-warning" },
  unavailable: { label: "Unavailable", cls: "bg-brand-red/10 text-brand-red" },
}

function etaText(h: number | null | undefined) {
  if (h == null) return ""
  if (h === 0) return "on hand"
  return h < 24 ? `ETA ${h} h` : `ETA ${Math.round(h / 24)} day${h >= 48 ? "s" : ""}`
}

function SectionTitle({
  n,
  title,
  hint,
  right,
}: {
  n?: number
  title: string
  hint?: React.ReactNode
  right?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-3.5">
      <div className="flex items-start gap-3">
        {n ? (
          <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
            {n}
          </span>
        ) : null}
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
          {hint ? (
            <p className="text-xs text-muted-foreground">{hint}</p>
          ) : null}
        </div>
      </div>
      {right ? <div className="flex flex-wrap items-center gap-2">{right}</div> : null}
    </div>
  )
}

function Tag({
  tone,
  children,
}: {
  tone: "warn" | "info" | "muted" | "ok"
  children: React.ReactNode
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap",
        tone === "warn" && "bg-warning/10 text-warning",
        tone === "info" && "bg-primary/10 text-primary",
        tone === "muted" && "bg-muted text-muted-foreground",
        tone === "ok" && "bg-success/10 text-success"
      )}
    >
      {children}
    </span>
  )
}

// ------------------------------------------------------------------ concerns

function sourceLabel(src: string) {
  if (src === "telemetry model") return "Raised by the car (connected-car alert)"
  if (src === "history") return "Raised by service history"
  return "Customer said"
}

/** One concern: what was said → demand code → likely cause → what to check. */
function ConcernItem({
  c,
  inspectionFirst,
  removed,
  onToggle,
  toggleKind = "remove",
}: {
  c: Concern
  inspectionFirst?: boolean
  removed?: boolean
  onToggle?: () => void
  toggleKind?: "remove" | "include"
}) {
  const vehicle = VEHICLE_SOURCES.has(c.source)
  const confirm = c.confidence < CONFIRM_BELOW
  return (
    <div
      className={cn(
        "grid gap-x-4 gap-y-2 px-5 py-3.5 md:grid-cols-[minmax(0,1fr)_20px_minmax(0,1.5fr)_auto]",
        removed && "bg-muted/40"
      )}
    >
      <div className={cn(removed && "opacity-50")}>
        <p
          className={cn(
            "text-[11px] font-medium",
            vehicle ? "text-primary" : "text-muted-foreground"
          )}
        >
          {sourceLabel(c.source)}
        </p>
        <p className={cn("text-sm", vehicle ? "" : "italic")}>
          {vehicle ? c.customer_words : `“${c.customer_words}”`}
        </p>
      </div>
      <HugeiconsIcon
        icon={ArrowRight01Icon}
        strokeWidth={2}
        className="mt-4 hidden size-4 text-muted-foreground md:block"
      />
      <div className={cn("space-y-1", removed && "opacity-50 line-through")}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-md bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-primary">
            {c.demand_code}
          </span>
          <span className="text-sm font-medium">{c.label}</span>
          {confirm ? <Tag tone="warn">Advisor to confirm</Tag> : null}
          {inspectionFirst ? <Tag tone="info">Inspection first</Tag> : null}
        </div>
        <p className="text-xs">
          <span className="text-muted-foreground">Likely cause · </span>
          {c.cause}
        </p>
        <p className="text-xs">
          <span className="text-muted-foreground">Check · </span>
          {c.correction}
        </p>
        <Why>
          {c.explanation ?? (vehicle
            ? c.source === "telemetry model"
              ? "The car's own sensor data flagged this; the customer did not mention it. Confirm with the customer before work starts."
              : "Due by service interval on this car's record; the customer did not mention it."
            : confirm
              ? "The wording is too vague to pin to one fault (for example only a part name). Confirm the symptom with the customer."
              : `Matched on the part and the symptom in the customer's words (${Math.round(c.confidence * 100)}% match).`)}
          {inspectionFirst
            ? " Quoted as inspection labour only; replacement parts are added after the fault is confirmed."
            : ""}
        </Why>
      </div>
      {onToggle ? (
        <div className="flex items-start justify-end">
          <button
            type="button"
            onClick={onToggle}
            className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {toggleKind === "include"
              ? removed
                ? "Include"
                : "Leave out"
              : removed
                ? "Restore"
                : "Remove"}
          </button>
        </div>
      ) : null}
    </div>
  )
}

function UnmatchedItem({
  words,
  codes,
  onAdd,
}: {
  words: string
  codes?: DemandCode[]
  onAdd?: (code: string) => void
}) {
  return (
    <div className="grid gap-x-4 gap-y-2 bg-warning/5 px-5 py-3.5 md:grid-cols-[minmax(0,1fr)_20px_minmax(0,1.5fr)_auto]">
      <div>
        <p className="text-[11px] font-medium text-muted-foreground">Customer said</p>
        <p className="text-sm italic">“{words}”</p>
      </div>
      <HugeiconsIcon
        icon={ArrowRight01Icon}
        strokeWidth={2}
        className="mt-4 hidden size-4 text-muted-foreground md:block"
      />
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Tag tone="warn">Advisor to confirm</Tag>
          <span className="text-sm font-medium">No demand code matched</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Ask the customer what they notice and when, then pick the demand code.
        </p>
      </div>
      {codes && onAdd ? (
        <CodePicker codes={codes} onPick={onAdd} label="Assign code" />
      ) : null}
    </div>
  )
}

function CodePicker({
  codes,
  onPick,
  label = "+ Add demand code",
}: {
  codes: DemandCode[]
  onPick: (code: string) => void
  label?: string
}) {
  return (
    <select
      value=""
      aria-label={label}
      onChange={(e) => e.target.value && onPick(e.target.value)}
      className="h-8 max-w-56 rounded-lg border bg-background px-2 text-xs"
    >
      <option value="">{label}</option>
      {codes.map((c) => (
        <option key={c.code} value={c.code}>
          {c.code} · {c.label}
        </option>
      ))}
    </select>
  )
}

function ConcernSplit({
  data,
  render,
  unmatched,
}: {
  data: Interpretation
  render: (c: Concern) => React.ReactNode
  unmatched: React.ReactNode
}) {
  const fromCustomer = data.concerns.filter((c) => !VEHICLE_SOURCES.has(c.source))
  const fromVehicle = data.concerns.filter((c) => VEHICLE_SOURCES.has(c.source))
  return (
    <>
      <div className="bg-muted/40 px-5 py-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        What the customer said
      </div>
      <div className="divide-y">
        {fromCustomer.map(render)}
        {unmatched}
        {!fromCustomer.length && !data.unmatched.length ? (
          <p className="px-5 py-3 text-sm text-muted-foreground">
            No customer concern recorded.
          </p>
        ) : null}
      </div>
      {fromVehicle.length ? (
        <>
          <div className="border-t bg-primary/5 px-5 py-1.5 text-[11px] font-semibold tracking-wide text-primary uppercase">
            Raised by the vehicle, not the customer
          </div>
          <div className="divide-y">{fromVehicle.map(render)}</div>
        </>
      ) : null}
    </>
  )
}

// ------------------------------------------------------------------ job card

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <div className="truncate text-sm font-medium">{children}</div>
    </div>
  )
}

function JobCardView({
  jc,
  codes,
  advisor,
  onChange,
}: {
  jc: JobCard
  codes: DemandCode[]
  advisor?: string | null
  onChange: (jc: JobCard) => void
}) {
  const p = jc.payload
  const draft = jc.status === "draft"
  const [selectedCodes, setSelectedCodes] = React.useState<string[]>(p.demand_codes)
  const [removed, setRemoved] = React.useState<string[]>(p.removed)
  const [reason, setReason] = React.useState("")
  const [showArrival, setShowArrival] = React.useState(false)
  const { busy, run } = useAsync()

  const dirty =
    selectedCodes.join() !== p.demand_codes.join() ||
    removed.join() !== p.removed.join()
  const reviewRequired = !p.interpretation.sufficient && !p.overrides?.length
  const codeLabel = (code: string) =>
    codes.find((c) => c.code === code)?.label ?? code

  const lines = p.estimate.lines
  const partLines = lines.filter((l) => l.type === "part")
  const campaignCodes = new Set(p.estimate.campaigns.map((c) => c.code))
  const inspectionFirst = (code: string) =>
    !REQUEST_CODES.has(code) && !campaignCodes.has(code) &&
    lines.some((l) => l.demand_code === code) &&
    !lines.some((l) => l.demand_code === code && l.type === "part")

  const interpreted = new Set(p.interpretation.concerns.map((c) => c.demand_code))
  const addedByAdvisor = selectedCodes.filter((c) => !interpreted.has(c))
  const toggleCode = (code: string) =>
    setSelectedCodes((s) =>
      s.includes(code) ? s.filter((x) => x !== code) : [...s, code]
    )
  const addCode = (code: string) =>
    setSelectedCodes((s) => (s.includes(code) ? s : [...s, code]))

  async function save() {
    if ((dirty || reviewRequired) && !reason.trim()) {
      toast.error("Record the advisor's reason first")
      return
    }
    try {
      onChange(
        await run("save", () =>
          service.revise(jc.id, {
            demand_codes: selectedCodes,
            removed,
            override_reason: reason || undefined,
          })
        )
      )
      setReason("")
      toast.success("Scope saved and estimate re-priced")
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  async function step(kind: "approve" | "release") {
    try {
      const next = await run(kind, () =>
        kind === "approve" ? service.approve(jc.id) : service.release(jc.id)
      )
      onChange(next)
      toast.success(
        kind === "approve"
          ? "Customer approved: parts reserved, bay and technician booked"
          : "Released to the workshop"
      )
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  const t = p.estimate.totals
  const plan = p.allocation
  const covered = t.warranty_value + t.campaign_value
  // Group estimate lines under their demand code, in job order.
  const groups: { code: string; lines: EstimateLine[] }[] = []
  for (const ln of lines) {
    const g = groups.find((x) => x.code === ln.demand_code)
    if (g) g.lines.push(ln)
    else groups.push({ code: ln.demand_code, lines: [ln] })
  }
  const tel = p.telemetry
  const lastService = p.history[0]

  return (
    <div className="space-y-4 pb-28">
      {/* ---------------------------------------------------- vehicle header */}
      <section className={CARD}>
        <div className="flex flex-wrap items-center gap-3 px-5 pt-4">
          <Plate reg={plateText(p.vehicle.reg_no)} size="lg" />
          <div className="min-w-0">
            <p className="text-base font-semibold tracking-tight">
              {p.vehicle.model}{" "}
              <span className="text-sm font-normal text-muted-foreground capitalize">
                · {p.vehicle.fuel}
              </span>
            </p>
            <p className="text-xs text-muted-foreground">
              JC-{jc.id} · opened {dayTime(jc.created_at)} · VIN{" "}
              <span className="font-mono">{p.vehicle.vin}</span>
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <StatusBadge value={jc.status === "draft" ? "awaiting approval" : jc.status} />
            <FollowButton vehicleId={jc.vehicle_id} />
            <Link
              href={`/vehicles/${jc.vehicle_id}`}
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            >
              Vehicle record
            </Link>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4 px-5 py-4 md:grid-cols-5">
          <Fact label="Customer">
            {p.customer.name}
            <span className="block text-xs font-normal text-muted-foreground">
              {p.customer.phone}
            </span>
          </Fact>
          <Fact label="Odometer at arrival">
            {p.vehicle.odometer_at_arrival.toLocaleString("en-IN")} km
          </Fact>
          <Fact label="Warranty">
            {p.estimate.warranty.active ? (
              <span className="text-success">In warranty</span>
            ) : (
              "Out of warranty"
            )}
            <span className="block text-xs font-normal text-muted-foreground">
              {p.estimate.warranty.age_years} yrs · {p.estimate.warranty.limit}
            </span>
          </Fact>
          <Fact label="Service advisor">
            {advisor ?? "Not assigned"}
            {p.appointment ? (
              <span className="block text-xs font-normal text-muted-foreground">
                Booked {clock(p.appointment.slot_start)} ·{" "}
                {p.appointment.mode === "pickup" ? "pickup" : "walk-in"}
              </span>
            ) : (
              <span className="block text-xs font-normal text-muted-foreground">
                Walk-in
              </span>
            )}
          </Fact>
          <Fact label="Campaigns open">
            {p.estimate.campaigns.length ? (
              p.estimate.campaigns.map((c) => (
                <span key={c.code} className="block truncate" title={c.title}>
                  {c.code}
                  <span className="text-xs font-normal text-muted-foreground">
                    {" "}
                    · {c.title}
                  </span>
                </span>
              ))
            ) : (
              <span className="text-muted-foreground">None</span>
            )}
          </Fact>
        </div>
        <div className="grid gap-px overflow-hidden rounded-b-2xl border-t bg-border text-xs md:grid-cols-3">
          <div className="bg-card px-5 py-2.5">
            <span className="text-muted-foreground">Last service · </span>
            {lastService
              ? `${lastService.date} · ${lastService.km.toLocaleString("en-IN")} km · ${lastService.kind} · ${inr(lastService.amount)}`
              : "No dealer history"}
            {p.history.length > 1 ? (
              <div className="ml-1.5 inline-block align-top"><Why>
                {p.history
                  .map(
                    (h) =>
                      `${h.date}: ${h.km.toLocaleString("en-IN")} km, ${h.kind}, ${h.demand_codes.join(" + ")}, ${inr(h.amount)}`
                  )
                  .join(" · ")}
              </Why></div>
            ) : null}
          </div>
          <div className="bg-card px-5 py-2.5">
            <span className="text-muted-foreground">Connected car · </span>
            {tel ? (
              tel.has_issue ? (
                <span className="text-warning">
                  {tel.rule_hits[0] ?? "Alert raised"}
                </span>
              ) : (
                "No active alerts"
              )
            ) : (
              "Not connected"
            )}
            {tel ? (
              <div className="ml-1.5 inline-block align-top"><Why>
                {tel.reason}
                {tel.codes.length ? ` Fault codes: ${tel.codes.join(", ")}.` : ""}
              </Why></div>
            ) : null}
          </div>
          <div className="bg-card px-5 py-2.5">
            <span className="text-muted-foreground">Arrival record · </span>
            {p.visit_id ? (
              <button
                type="button"
                onClick={() => setShowArrival((s) => !s)}
                className="font-medium text-primary underline-offset-2 hover:underline"
              >
                {showArrival ? "Hide" : "Gate checks & condition"}
              </button>
            ) : (
              "Not arrived yet"
            )}
          </div>
        </div>
        {showArrival && p.visit_id ? (
          <div className="grid gap-6 border-t px-5 py-4 md:grid-cols-[minmax(0,18rem)_1fr]">
            <CheckList checks={p.gate_checks} />
            <ConditionPanel condition={p.condition} />
          </div>
        ) : null}
      </section>

      {/* ---------------------------------------------------- 1 concerns */}
      <section className={CARD}>
        <SectionTitle
          n={1}
          title="Concerns"
          hint="What was reported, the demand code it maps to, the likely cause and what to check."
          right={
            p.interpretation.sufficient ? (
              <AssistChip uc={9}>
                {p.interpretation.concerns.length} concern
                {p.interpretation.concerns.length === 1 ? "" : "s"} coded
              </AssistChip>
            ) : (
              <AssistChip uc={9}>Partly coded · advisor to confirm</AssistChip>
            )
          }
        />
        {reviewRequired ? (
          <div className="border-b bg-warning/10 px-5 py-2.5 text-sm text-warning">
            <span className="font-medium">Advisor review needed.</span>{" "}
            {p.interpretation.note ??
              "Some wording could not be coded with confidence."}{" "}
            Confirm the scope with the customer and record your decision below.
          </div>
        ) : null}
        <ConcernSplit
          data={p.interpretation}
          render={(c) => (
            <ConcernItem
              key={c.demand_code + c.source}
              c={c}
              inspectionFirst={inspectionFirst(c.demand_code)}
              removed={!selectedCodes.includes(c.demand_code)}
              onToggle={draft ? () => toggleCode(c.demand_code) : undefined}
            />
          )}
          unmatched={p.interpretation.unmatched.map((u) => (
            <UnmatchedItem
              key={u}
              words={u}
              codes={draft ? codes.filter((c) => !selectedCodes.includes(c.code)) : undefined}
              onAdd={addCode}
            />
          ))}
        />
        {addedByAdvisor.length ? (
          <>
            <div className="border-t bg-muted/40 px-5 py-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              Added by the advisor
            </div>
            <div className="divide-y">
              {addedByAdvisor.map((code) => (
                <div key={code} className="flex items-center gap-2 px-5 py-2.5">
                  <span className="rounded-md bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-primary">
                    {code}
                  </span>
                  <span className="text-sm">{codeLabel(code)}</span>
                  {campaignCodes.has(code) ? <Tag tone="info">Campaign</Tag> : null}
                  {!p.demand_codes.includes(code) ? (
                    <Tag tone="muted">Unsaved</Tag>
                  ) : null}
                  {draft && !campaignCodes.has(code) ? (
                    <button
                      type="button"
                      onClick={() => toggleCode(code)}
                      className="ml-auto rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          </>
        ) : null}
        {draft ? (
          <div className="flex flex-wrap items-center gap-3 border-t px-5 py-3">
            <CodePicker
              codes={codes.filter((c) => !selectedCodes.includes(c.code))}
              onPick={addCode}
            />
            <span className="text-xs text-muted-foreground">
              Missing a job or a wrong code? Add or remove it, then save with a reason.
            </span>
          </div>
        ) : null}
        {draft && (dirty || reviewRequired) ? (
          <div className="flex flex-wrap items-end gap-3 rounded-b-2xl border-t bg-warning/5 px-5 py-3">
            <div className="min-w-72 flex-1 space-y-1">
              <Label htmlFor="reason" className="text-xs">
                {reviewRequired && !dirty
                  ? "Advisor decision (recorded on the job card)"
                  : "Reason for the change (recorded on the job card)"}
              </Label>
              <Input
                id="reason"
                value={reason}
                placeholder={
                  reviewRequired && !dirty
                    ? "e.g. confirmed symptom and inspection scope with customer"
                    : "e.g. customer declined wash"
                }
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            {dirty ? (
              <Button
                variant="ghost"
                onClick={() => {
                  setSelectedCodes(p.demand_codes)
                  setRemoved(p.removed)
                }}
              >
                Undo
              </Button>
            ) : null}
            <Button onClick={save} disabled={busy !== null || !reason.trim()}>
              {busy === "save"
                ? "Saving…"
                : dirty
                  ? "Save & re-price"
                  : "Confirm reviewed scope"}
            </Button>
          </div>
        ) : null}
        {p.overrides?.length ? (
          <div className="border-t px-5 py-2.5 text-xs text-muted-foreground">
            Advisor decisions:{" "}
            {p.overrides.map((o) => `${dayTime(o.at)} · ${o.reason}`).join("; ")}
          </div>
        ) : null}
      </section>

      {/* ---------------------------------------------------- 2 estimate */}
      <section className={CARD}>
        <SectionTitle
          n={2}
          title="Estimate"
          hint={
            <>
              JC-{jc.id} · {p.customer.name} · {plateText(p.vehicle.reg_no)} ·{" "}
              {p.estimate.labour_hours} labour hrs
            </>
          }
          right={
            <AssistChip uc={10}>
              Priced with GST
              {covered > 0 ? ` · ${inr(covered)} billed to Maruti` : ""}
            </AssistChip>
          }
        />
        {p.estimate.note ? (
          <div className="border-b bg-primary/5 px-5 py-2.5 text-xs text-primary">
            <span className="font-semibold">Inspection first.</span>{" "}
            {p.estimate.note}
          </div>
        ) : null}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-[11px] text-muted-foreground uppercase">
                <th className="w-10 py-2 pl-5" />
                <th className="py-2 font-medium">Description</th>
                <th className="py-2 font-medium">Type</th>
                <th className="py-2 text-right font-medium">Qty / hrs</th>
                <th className="py-2 text-right font-medium">Rate</th>
                <th className="py-2 pl-4 font-medium">Payer</th>
                <th className="py-2 pr-5 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <React.Fragment key={g.code}>
                  <tr className="bg-muted/40">
                    <td />
                    <td colSpan={6} className="py-1.5 text-xs font-medium">
                      <span className="font-mono text-primary">{g.code}</span>{" "}
                      <span className="text-muted-foreground">
                        {campaignCodes.has(g.code)
                          ? "Manufacturer campaign"
                          : codeLabel(g.code)}
                      </span>
                      {inspectionFirst(g.code) ? (
                        <span className="ml-2 text-[11px] text-primary">
                          inspection only · parts after diagnosis
                        </span>
                      ) : null}
                    </td>
                  </tr>
                  {g.lines.map((ln) => {
                    const off = removed.includes(ln.id)
                    return (
                      <tr
                        key={ln.id}
                        className={cn("border-b border-dashed last:border-0", off && "opacity-40")}
                      >
                        <td className="py-2 pl-5 align-top">
                          <input
                            type="checkbox"
                            disabled={!draft}
                            aria-label={`Include ${ln.desc}`}
                            checked={!off}
                            onChange={(e) =>
                              setRemoved(
                                e.target.checked
                                  ? removed.filter((r) => r !== ln.id)
                                  : [...removed, ln.id]
                              )
                            }
                          />
                        </td>
                        <td className={cn("py-2", off && "line-through")}>
                          {ln.desc}
                          <span className="block font-mono text-[11px] text-muted-foreground">
                            {ln.code}
                            {ln.substituted_for ? ` · replaces ${ln.substituted_for}` : ""}
                          </span>
                        </td>
                        <td className="py-2 text-xs text-muted-foreground">
                          {ln.type === "part" ? "Part" : "Labour"}
                        </td>
                        <td className="py-2 text-right tabular-nums">{ln.qty}</td>
                        <td className="py-2 text-right text-muted-foreground tabular-nums">
                          {inr(ln.unit_price)}
                        </td>
                        <td className="py-2 pl-4">
                          <PayerBadge payer={ln.payer} />
                        </td>
                        <td className="py-2 pr-5 text-right font-medium tabular-nums">
                          {ln.payer === "customer" ? (
                            inr(ln.amount)
                          ) : (
                            <span className="text-muted-foreground line-through decoration-1">
                              {inr(ln.amount)}
                            </span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </React.Fragment>
              ))}
              {!lines.length ? (
                <tr>
                  <td colSpan={7} className="px-5 py-4 text-sm text-muted-foreground">
                    No lines. Add a demand code in Concerns.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-end justify-between gap-4 border-t px-5 py-4">
          <p className="max-w-sm text-xs text-muted-foreground">
            {dirty
              ? "Unsaved scope changes: save to re-price before the customer approves."
              : "Warranty and campaign lines are billed to Maruti Suzuki and shown struck through for the customer."}
          </p>
          <dl className="w-full max-w-xs space-y-1 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Labour</dt>
              <dd className="tabular-nums">{inr(t.labour)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Parts</dt>
              <dd className="tabular-nums">{inr(t.parts)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">GST</dt>
              <dd className="tabular-nums">{inr(t.gst)}</dd>
            </div>
            {t.warranty_value ? (
              <div className="flex justify-between text-success">
                <dt>Warranty (Maruti)</dt>
                <dd className="tabular-nums">{inr(t.warranty_value)}</dd>
              </div>
            ) : null}
            {t.campaign_value ? (
              <div className="flex justify-between text-primary">
                <dt>Campaign (Maruti)</dt>
                <dd className="tabular-nums">{inr(t.campaign_value)}</dd>
              </div>
            ) : null}
            <div className="mt-2 flex items-baseline justify-between border-t pt-2">
              <dt className="font-medium">Customer pays</dt>
              <dd className="text-xl font-semibold tracking-tight tabular-nums">
                {inr(t.customer_payable)}
              </dd>
            </div>
          </dl>
        </div>
      </section>

      {/* ---------------------------------------------------- 3 parts & allocation */}
      <section className={CARD}>
        <SectionTitle
          n={3}
          title="Parts & workshop allocation"
          hint={`${plan.hours} hrs · skills needed: ${plan.skills.join(", ") || "general"}`}
        />
        <div className="grid divide-y lg:grid-cols-2 lg:divide-x lg:divide-y-0">
          <div className="space-y-3 px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">Parts sourcing</p>
              <PartsChip lines={partLines} blocking={p.parts_blocking} />
            </div>
            {partLines.length ? (
              <ul className="divide-y rounded-xl border">
                {partLines.map((ln) => (
                  <PartRow key={ln.id} ln={ln} off={removed.includes(ln.id)} />
                ))}
              </ul>
            ) : (
              <p className="rounded-xl border border-dashed px-3 py-3 text-xs text-muted-foreground">
                No parts quoted. Symptom jobs are inspected first; parts are sourced once
                the fault is confirmed.
              </p>
            )}
            {p.parts_blocking ? (
              <p className="rounded-lg bg-brand-red/10 px-3 py-2 text-xs text-brand-red">
                A part is unavailable across the network. Back-order it or untick the line
                before approval.
              </p>
            ) : null}
            {p.reserved?.length ? (
              <p className="text-xs text-success">
                Reserved:{" "}
                {p.reserved.map((r) => `${r.part_no} × ${r.qty} (${r.location})`).join(", ")}
              </p>
            ) : null}
          </div>
          <AllocationPanel plan={plan} />
        </div>
      </section>

      {/* ---------------------------------------------------- 4 approve & release */}
      <ActionBar
        jc={jc}
        busy={busy}
        dirty={dirty}
        reviewRequired={reviewRequired}
        blocked={p.parts_blocking || !plan.feasible}
        onStep={step}
      />
    </div>
  )
}

function PartsChip({ lines, blocking }: { lines: EstimateLine[]; blocking: boolean }) {
  if (!lines.length) return <AssistChip uc={11}>Draft job card ready · no parts yet</AssistChip>
  const own = lines.filter((l) => l.availability?.status === "available").length
  const eta = Math.max(0, ...lines.map((l) => l.availability?.eta_hours ?? 0))
  return (
    <AssistChip uc={11}>
      {blocking
        ? "Part unavailable in network"
        : own === lines.length
          ? `All ${lines.length} parts in own stock`
          : `${own}/${lines.length} in stock · rest ${etaText(eta)}`}
    </AssistChip>
  )
}

function PartRow({ ln, off }: { ln: EstimateLine; off: boolean }) {
  const a = ln.availability
  const s = a ? SOURCING[a.status] : null
  return (
    <li className={cn("flex flex-wrap items-start gap-3 px-3 py-2.5 text-sm", off && "opacity-40")}>
      <div className="min-w-0 flex-1">
        <p className="truncate">{ln.desc}</p>
        <p className="font-mono text-[11px] text-muted-foreground">
          {ln.code} × {ln.qty}
          {ln.substituted_for ? ` · alternative for ${ln.substituted_for}` : ""}
        </p>
      </div>
      <div className="text-right">
        {s ? (
          <span className={cn("inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium", s.cls)}>
            {s.label}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
        {a ? (
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {[a.source, etaText(a.eta_hours)].filter(Boolean).join(" · ")}
          </p>
        ) : null}
        {a && (a.note || a.locations.length) ? (
          <Why>
            {a.note ? `${a.note} ` : ""}
            {a.locations.map((l) => `${l.label || l.location}: ${l.qty}`).join(" · ")}
          </Why>
        ) : null}
      </div>
    </li>
  )
}

function AllocationPanel({ plan }: { plan: Allocation }) {
  if (!plan.feasible)
    return (
      <div className="space-y-2 px-5 py-4">
        <p className="text-sm font-medium">Technician & bay</p>
        <p className="rounded-lg bg-brand-red/10 px-3 py-2 text-sm text-brand-red">
          No bay or technician free today. {plan.reason}
        </p>
      </div>
    )
  const others = (plan.technicians ?? []).filter(
    (x) => x.technician_id !== plan.technician?.technician_id
  )
  return (
    <div className="space-y-3 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">Technician & bay</p>
        <AssistChip uc={12}>
          {plan.technician?.name} · {plan.bay?.name} · ready {clock(plan.promised_delivery)}
        </AssistChip>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-xl border p-3">
          <p className="text-[11px] text-muted-foreground">Technician</p>
          <p className="text-sm font-semibold">{plan.technician?.name}</p>
          <p className="text-[11px] text-muted-foreground">
            Level {plan.technician?.level}
          </p>
        </div>
        <div className="rounded-xl border p-3">
          <p className="text-[11px] text-muted-foreground">Bay</p>
          <p className="text-sm font-semibold">{plan.bay?.name}</p>
          <p className="text-[11px] text-muted-foreground capitalize">{plan.bay?.type}</p>
        </div>
        <div className="rounded-xl border border-primary/30 bg-primary/5 p-3">
          <p className="text-[11px] text-muted-foreground">Promised</p>
          <p className="text-sm font-semibold text-primary">{clock(plan.promised_delivery)}</p>
          <p className="text-[11px] text-muted-foreground">
            work {clock(plan.start)} – {clock(plan.end)}
          </p>
        </div>
      </div>
      <Why>
        <span className="block">
          Picked for skills ({plan.technician?.skills.join(", ")}), certification{" "}
          {plan.technician?.certifications.join(", ") || "none"} and{" "}
          {plan.technician?.load_hours_today} h already loaded today; {plan.bay?.name} is
          free from {clock(plan.bay?.free_at)}.
        </span>
        {others.length ? (
          <span className="mt-1 block">
            Other candidates:{" "}
            {others
              .slice(0, 4)
              .map(
                (x) =>
                  `${x.name} (L${x.level}, ${x.load_hours_today} h loaded, free ${clock(x.free_at)})`
              )
              .join(" · ")}
          </span>
        ) : null}
      </Why>
    </div>
  )
}

const STAGES = ["Drafted", "Customer approval", "Released to workshop"]

function ActionBar({
  jc,
  busy,
  dirty,
  reviewRequired,
  blocked,
  onStep,
}: {
  jc: JobCard
  busy: string | null
  dirty: boolean
  reviewRequired: boolean
  blocked: boolean
  onStep: (k: "approve" | "release") => void
}) {
  const p = jc.payload
  const plan = p.allocation
  const stage = jc.status === "draft" ? 1 : jc.status === "approved" ? 2 : 3
  const t = p.estimate.totals
  const covered = t.warranty_value + t.campaign_value

  if (jc.status === "released")
    return (
      <section className={cn(CARD, "border-success/30 bg-success/5 px-5 py-4")}>
        <div className="flex flex-wrap items-center gap-4">
          <HugeiconsIcon icon={CheckmarkCircle02Icon} strokeWidth={2} className="size-6 text-success" />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">
              Released to workshop
              {plan.feasible
                ? ` · ${plan.technician?.name}, ${plan.bay?.name}, promised ${clock(plan.promised_delivery)}`
                : ""}
            </p>
            <p className="text-xs text-muted-foreground">
              {dayTime(p.released_at)} · job summary sent to {p.customer.name}
            </p>
          </div>
          <Button nativeButton={false} render={<Link href={`/workshop?v=${jc.vehicle_id}`} />}>
            Continue: Workshop floor
            <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} className="size-4" />
          </Button>
        </div>
      </section>
    )

  const hold = dirty
    ? "Save the scope change first so the customer approves the re-priced estimate."
    : reviewRequired
      ? "Confirm the uncertain concerns in section 1 before asking the customer."
      : blocked
        ? "Resolve the part or allocation issue in section 3."
        : null

  return (
    <section
      className={cn(
        CARD,
        "sticky bottom-3 z-10 border-primary/20 px-5 py-3.5 shadow-[0_12px_32px_-12px_rgba(0,0,0,.2)]"
      )}
    >
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <ol className="flex items-center gap-2 text-[11px]">
          {STAGES.map((s, i) => (
            <li key={s} className="flex items-center gap-2">
              <span
                className={cn(
                  "flex size-5 items-center justify-center rounded-full text-[10px] font-semibold",
                  i + 1 < stage && "bg-success text-white",
                  i + 1 === stage && "bg-primary text-primary-foreground",
                  i + 1 > stage && "bg-muted text-muted-foreground"
                )}
              >
                {i + 1 < stage ? "✓" : i + 1}
              </span>
              <span className={cn(i + 1 === stage ? "font-medium" : "text-muted-foreground")}>
                {s}
              </span>
              {i < STAGES.length - 1 ? <span className="text-muted-foreground">—</span> : null}
            </li>
          ))}
        </ol>
        <div className="min-w-0 flex-1 text-sm">
          {jc.status === "draft" ? (
            hold ? (
              <span className="text-warning">{hold}</span>
            ) : (
              <span>
                Read out to {p.customer.name}:{" "}
                <span className="font-semibold">{inr(t.customer_payable)}</span>
                {covered ? ` (Maruti covers ${inr(covered)})` : ""}
                {plan.feasible ? `, ready by ${clock(plan.promised_delivery)}` : ""}.
              </span>
            )
          ) : (
            <span>
              Approved {dayTime(p.approved_at)}
              {p.reserved?.length ? " · parts reserved" : ""}
              {plan.feasible ? ` · ${plan.technician?.name}, ${plan.bay?.name} booked` : ""}
            </span>
          )}
        </div>
        {jc.status === "draft" ? (
          <Button
            size="lg"
            onClick={() => onStep("approve")}
            disabled={!!hold || busy !== null}
          >
            {busy === "approve"
              ? "Recording…"
              : `Customer approved ${inr(t.customer_payable)}`}
          </Button>
        ) : (
          <Button size="lg" onClick={() => onStep("release")} disabled={busy !== null}>
            {busy === "release" ? "Releasing…" : "Release to workshop"}
          </Button>
        )}
      </div>
    </section>
  )
}

// ------------------------------------------------------------------ new card from a visit

function NewCardView({
  source,
  text,
  setText,
  preview,
  excluded,
  setExcluded,
  busy,
  onInterpret,
  onDraft,
}: {
  source: Source
  text: string
  setText: (t: string) => void
  preview: Interpretation | null
  excluded: string[]
  setExcluded: React.Dispatch<React.SetStateAction<string[]>>
  busy: string | null
  onInterpret: () => void
  onDraft: () => void
}) {
  return (
    <div className="space-y-4">
      <section className={CARD}>
        <div className="flex flex-wrap items-center gap-3 px-5 py-4">
          <Plate reg={plateText(source.reg)} size="lg" />
          <div>
            <p className="text-base font-semibold tracking-tight">{source.model}</p>
            <p className="text-xs text-muted-foreground">
              {source.customer}
              {source.advisor ? ` · advisor ${source.advisor}` : ""}
              {source.odometer ? ` · ${source.odometer.toLocaleString("en-IN")} km` : ""}
              {source.visit_id
                ? ` · arrived ${clock(source.at)}`
                : ` · booked ${clock(source.at)}, not arrived`}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Tag tone="warn">No job card yet</Tag>
            <FollowButton vehicleId={source.vehicle_id} />
          </div>
        </div>
      </section>
      <section className={CARD}>
        <SectionTitle
          n={1}
          title="Concerns"
          hint="Type what the customer said, in Hindi, Hinglish or English. Each concern is mapped to a demand code."
          right={
            preview ? (
              <AssistChip uc={9}>
                {preview.sufficient ? `${preview.concerns.length} coded` : "Advisor to confirm"}
              </AssistChip>
            ) : null
          }
        />
        <div className="space-y-3 px-5 py-4">
          <Textarea
            rows={3}
            value={text}
            placeholder="e.g. AC thanda nahi kar raha aur front brake se awaaz aati hai"
            onChange={(e) => setText(e.target.value)}
          />
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="outline" onClick={onInterpret} disabled={busy !== null || !text.trim()}>
              {busy === "interp" ? "Reading…" : preview ? "Re-read concerns" : "Suggest jobs"}
            </Button>
            <Button onClick={onDraft} disabled={busy !== null || !text.trim()}>
              {busy === "draft" ? "Drafting…" : "Draft job card & estimate"}
            </Button>
          </div>
        </div>
        {preview ? (
          <div className="border-t">
            {!preview.sufficient ? (
              <div className="border-b bg-warning/10 px-5 py-2.5 text-sm text-warning">
                {preview.note ?? "Some wording could not be coded with confidence."} You can
                correct codes after drafting.
              </div>
            ) : null}
            <ConcernSplit
              data={preview}
              render={(c) => (
                <ConcernItem
                  key={c.demand_code + c.source}
                  c={c}
                  inspectionFirst={!REQUEST_CODES.has(c.demand_code) && !VEHICLE_SOURCES.has(c.source)}
                  removed={excluded.includes(c.demand_code)}
                  toggleKind="include"
                  onToggle={() =>
                    setExcluded((x) =>
                      x.includes(c.demand_code)
                        ? x.filter((y) => y !== c.demand_code)
                        : [...x, c.demand_code]
                    )
                  }
                />
              )}
              unmatched={preview.unmatched.map((u) => (
                <UnmatchedItem key={u} words={u} />
              ))}
            />
          </div>
        ) : null}
      </section>
    </div>
  )
}

// ------------------------------------------------------------------ queue

type Group = "open" | "draft" | "approved" | "released"
const GROUPS: { key: Group; label: string }[] = [
  { key: "open", label: "To open" },
  { key: "draft", label: "Awaiting approval" },
  { key: "approved", label: "Approved" },
  { key: "released", label: "Released" },
]

type QItem = {
  key: string
  group: Group
  reg: string
  model: string
  customer: string
  meta: string
  sort: number
  jcId?: number
  source?: Source
  amount?: number
  booked?: boolean
}

type CardRow = JobCardSummary & { vehicle_id?: number; visit_id?: number | null }

export function JobCardWorkspace() {
  const params = useSearchParams()
  const { setFocus, refresh } = useJourney()
  const [visits, setVisits] = React.useState<Visit[]>([])
  const [appts, setAppts] = React.useState<Appointment[]>([])
  const [cards, setCards] = React.useState<CardRow[]>([])
  const [codes, setCodes] = React.useState<DemandCode[]>([])
  const [source, setSource] = React.useState<Source | null>(null)
  const [search, setSearch] = React.useState("")
  const [group, setGroup] = React.useState<Group | null>(null)
  const [text, setText] = React.useState("")
  const [excluded, setExcluded] = React.useState<string[]>([])
  const [preview, setPreview] = React.useState<Interpretation | null>(null)
  const [jc, setJc] = React.useState<JobCard | null>(null)
  const { busy, run } = useAsync()

  const load = React.useCallback(async () => {
    const [v, a, c, d] = await Promise.all([
      service.visits(),
      service.appointments(todayIso()),
      service.jobCards(),
      service.demandCodes(),
    ])
    setVisits(v)
    setAppts(a.filter((x) => x.status !== "arrived" && x.status !== "cancelled"))
    setCards(c as CardRow[])
    setCodes(d)
    return { v, c: c as CardRow[] }
  }, [])

  const choose = React.useCallback(
    (s: Source) => {
      setSource(s)
      setText(s.text)
      setPreview(null)
      setExcluded([])
      setJc(null)
      setFocus(s.vehicle_id)
    },
    [setFocus]
  )

  const open = React.useCallback(
    async (id: number) => {
      try {
        const next = await service.jobCard(id)
        setJc(next)
        setSource(null)
        setFocus(next.vehicle_id)
      } catch (e) {
        toast.error(errMsg(e))
      }
    },
    [setFocus]
  )

  const visitSource = (v: Visit): Source => ({
    vehicle_id: v.vehicle_id,
    visit_id: v.id,
    reg: v.reg_no,
    model: v.model,
    customer: v.customer_name,
    advisor: v.advisor_name,
    at: v.arrived_at,
    odometer: v.odometer,
    text: v.concerns ?? "",
  })

  const visitParam = Number(params.get("visit"))
  const jcParam = Number(params.get("jc"))
  const vParam = Number(params.get("v"))
  React.useEffect(() => {
    const t = window.setTimeout(() => {
      if (jcParam) void open(jcParam)
      load()
        .then(({ v, c }) => {
          if (jcParam) {
            const row = c.find((x) => x.id === jcParam)
            if (row) setGroup(row.status === "draft" ? "draft" : row.status)
            return
          }
          let hit = v.find((x) => x.id === visitParam)
          if (!hit && vParam) {
            const card = c.find((x) => x.vehicle_id === vParam && x.status !== "released") ??
              c.find((x) => x.vehicle_id === vParam)
            const visit = v.find((x) => x.vehicle_id === vParam && !x.job_card)
            if (card && (card.status !== "released" || !visit)) {
              setGroup(card.status === "draft" ? "draft" : card.status)
              void open(card.id)
              return
            }
            hit = visit
          }
          if (hit?.job_card) void open(hit.job_card.id)
          else if (hit) {
            setGroup("open")
            choose(visitSource(hit))
          }
        })
        .catch((e) => toast.error(errMsg(e)))
    }, 0)
    return () => window.clearTimeout(t)
  }, [load, open, choose, visitParam, jcParam, vParam])

  async function interpret() {
    try {
      setPreview(await run("interp", () => service.interpret(text, source?.vehicle_id, true)))
      setExcluded([])
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  async function draftCard() {
    if (!source) return
    try {
      let c = await run("draft", () =>
        service.createJobCard({
          visit_id: source.visit_id,
          appointment_id: source.appointment_id,
          text,
          use_llm: true,
        })
      )
      // Apply jobs the advisor left out in the suggestion list.
      if (excluded.length) {
        const base = c
        c = await run("draft", () =>
          service.revise(base.id, {
            demand_codes: base.payload.demand_codes.filter((d) => !excluded.includes(d)),
            removed: base.payload.removed,
            override_reason: "Advisor left out suggested jobs",
          })
        )
      }
      setJc(c)
      setSource(null)
      setFocus(c.vehicle_id)
      refresh()
      void load()
      toast.success(`JC-${c.id} drafted with estimate`)
    } catch (e) {
      toast.error(errMsg(e))
    }
  }

  // ---- queue
  const items: QItem[] = []
  for (const v of visits) {
    if (v.job_card) continue
    items.push({
      key: `v${v.id}`,
      group: "open",
      reg: v.reg_no,
      model: v.model,
      customer: v.customer_name,
      meta: `Arrived ${clock(v.arrived_at)} · waiting ${waited(v.arrived_at)}`,
      sort: new Date(v.arrived_at).getTime(),
      source: visitSource(v),
    })
  }
  for (const a of appts) {
    items.push({
      key: `a${a.id}`,
      group: "open",
      reg: a.reg_no,
      model: a.model ?? "",
      customer: a.customer_name,
      meta: `Booked ${clock(a.slot_start)} · not arrived`,
      sort: 1e15 + new Date(a.slot_start).getTime(),
      booked: true,
      source: {
        vehicle_id: a.vehicle_id,
        appointment_id: a.id,
        reg: a.reg_no,
        model: a.model ?? "",
        customer: a.customer_name,
        at: a.slot_start,
        text: a.concerns,
      },
    })
  }
  for (const c of cards) {
    const ts = new Date(c.created_at).getTime()
    items.push({
      key: `c${c.id}`,
      group: c.status === "draft" ? "draft" : c.status,
      reg: c.reg_no,
      model: c.model,
      customer: c.customer_name,
      meta:
        c.status === "released"
          ? `JC-${c.id} · ${dayTime(c.created_at)}`
          : `JC-${c.id} · waiting ${waited(c.created_at)}`,
      // Oldest first while waiting; newest first once released.
      sort: c.status === "released" ? -ts : ts,
      jcId: c.id,
      amount: c.customer_payable,
    })
  }
  const counts = Object.fromEntries(
    GROUPS.map((g) => [g.key, items.filter((i) => i.group === g.key && !i.booked).length])
  ) as Record<Group, number>
  const bookedCount = items.filter((i) => i.booked).length
  const activeGroup: Group = group ?? (counts.open ? "open" : "draft")
  const q = search.trim().toLowerCase().replace(/\s+/g, "")
  const visible = items
    .filter((i) =>
      q
        ? `${i.reg}${i.customer}${i.model}jc-${i.jcId ?? ""}`
            .toLowerCase()
            .replace(/\s+/g, "")
            .includes(q)
        : i.group === activeGroup
    )
    .sort((a, b) => a.sort - b.sort)

  const advisorFor = (j: JobCard) =>
    visits.find((v) => v.id === j.visit_id)?.advisor_name ?? null

  return (
    <div className="grid items-start gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
      <aside className={cn(CARD, "xl:sticky xl:top-4")}>
        <div className="space-y-3 border-b p-3">
          <div className="relative">
            <HugeiconsIcon
              icon={Search01Icon}
              strokeWidth={2}
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              aria-label="Find vehicle, customer or job card"
              placeholder="Plate, customer or JC number"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {GROUPS.map((g) => (
              <button
                key={g.key}
                type="button"
                onClick={() => {
                  setGroup(g.key)
                  setSearch("")
                }}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                  !q && activeGroup === g.key
                    ? "border-primary bg-primary text-primary-foreground"
                    : "bg-background hover:bg-muted"
                )}
              >
                {g.label}
                <span
                  className={cn(
                    "rounded-full px-1.5 text-[10px] tabular-nums",
                    !q && activeGroup === g.key ? "bg-white/20" : "bg-muted"
                  )}
                >
                  {counts[g.key]}
                </span>
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground">
            {q
              ? `${visible.length} match${visible.length === 1 ? "" : "es"} across all stages`
              : activeGroup === "open"
                ? `Arrived without a job card, longest waiting first${bookedCount ? ` · ${bookedCount} more booked today` : ""}`
                : activeGroup === "released"
                  ? "Most recent first"
                  : "Longest waiting first"}
          </p>
        </div>
        <ul className="max-h-[calc(100vh-17rem)] divide-y overflow-y-auto">
          {visible.map((i) => {
            const selected = i.jcId
              ? jc?.id === i.jcId
              : (source?.visit_id && source.visit_id === i.source?.visit_id) ||
                (source?.appointment_id && source.appointment_id === i.source?.appointment_id)
            return (
              <li key={i.key}>
                <button
                  type="button"
                  onClick={() => (i.jcId ? void open(i.jcId) : i.source && choose(i.source))}
                  className={cn(
                    "flex w-full items-start gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/60",
                    selected && "bg-accent hover:bg-accent",
                    i.booked && "opacity-70"
                  )}
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <Plate reg={plateText(i.reg)} size="sm" />
                      <span className="truncate text-xs text-muted-foreground">{i.model}</span>
                    </div>
                    <p className="truncate text-sm font-medium">{i.customer}</p>
                    <p className="truncate text-[11px] text-muted-foreground">{i.meta}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    {i.amount != null ? (
                      <p className="text-sm font-medium tabular-nums">{inr(i.amount)}</p>
                    ) : null}
                    {q ? (
                      <span className="text-[10px] text-muted-foreground">
                        {GROUPS.find((g) => g.key === i.group)?.label}
                      </span>
                    ) : null}
                  </div>
                </button>
              </li>
            )
          })}
          {!visible.length ? (
            <li className="p-4">
              <Empty>{q ? "Nothing matches." : "Nothing here right now."}</Empty>
            </li>
          ) : null}
        </ul>
      </aside>

      <div className="min-w-0">
        {source ? (
          <NewCardView
            source={source}
            text={text}
            setText={(t) => {
              setText(t)
              setPreview(null)
              setExcluded([])
            }}
            preview={preview}
            excluded={excluded}
            setExcluded={setExcluded}
            busy={busy}
            onInterpret={interpret}
            onDraft={draftCard}
          />
        ) : jc ? (
          <JobCardView
            key={`${jc.id}-${jc.updated_at}`}
            jc={jc}
            codes={codes}
            advisor={advisorFor(jc)}
            onChange={(next) => {
              setJc(next)
              refresh()
              void load()
            }}
          />
        ) : (
          <Empty>Pick a vehicle on the left to open or continue its job card.</Empty>
        )}
      </div>
    </div>
  )
}
