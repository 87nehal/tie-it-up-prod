"use client"

// Records: the customer base and the vehicle record (Vehicle 360), the one place where
// the whole visit reads end to end: where the car is now, what was decided for it along
// the way, and its history with the outlet.

import * as React from "react"
import Link from "next/link"

import { erp, type CustomerRow, type Journey, type Vehicle360 } from "@/lib/erp-api"
import { clock, dayTime, inr } from "@/lib/format"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field, Panel, StagePill } from "@/components/erp/kit"
import { AssistChip, FollowButton, Plate, STEPS, USE_CASES, useJourney } from "@/components/erp/journey"

function date(iso?: string | null) {
  if (!iso) return "—"
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
}

const PER = 25
type ListFilter = "all" | "open" | "alert" | "overdue"

function monthsSince(iso?: string | null) {
  if (!iso) return 0
  return (Date.now() - new Date(iso).getTime()) / (30.4 * 86_400_000)
}

export function VehicleList() {
  const [q, setQ] = React.useState("")
  const [rows, setRows] = React.useState<CustomerRow[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)
  const [filter, setFilter] = React.useState<ListFilter>("all")
  const [page, setPage] = React.useState(0)
  React.useEffect(() => {
    let active = true
    const t = window.setTimeout(() => {
      erp.customers(q).then((result) => {
        if (active) { setRows(result); setError(null); setLoading(false); setPage(0) }
      }).catch((reason) => {
        if (active) { setError(reason instanceof Error ? reason.message : String(reason)); setLoading(false) }
      })
    }, 200)
    return () => { active = false; window.clearTimeout(t) }
  }, [q])

  const tests: Record<ListFilter, (r: CustomerRow) => boolean> = {
    all: () => true,
    open: (r) => !!r.open_job_card,
    alert: (r) => !!r.telemetry?.has_issue,
    overdue: (r) => monthsSince(r.last_service_date) > 12,
  }
  const shown = rows.filter(tests[filter])
  const pages = Math.max(1, Math.ceil(shown.length / PER))
  const pg = Math.min(page, pages - 1)
  const capped = rows.length >= 200

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            ["all", "All"],
            ["open", "In the workshop"],
            ["alert", "Car alert"],
            ["overdue", "Service lapsed > 12 mo"],
          ] as [ListFilter, string][]
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => { setFilter(k); setPage(0) }}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium",
              filter === k ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted"
            )}
          >
            {label} <span className="tabular-nums opacity-70">{rows.filter(tests[k]).length}</span>
          </button>
        ))}
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search reg no, customer, mobile, locality" className="ml-auto w-80" />
      </div>
      {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">Could not load customer records: {error}</p>}
      <div className="overflow-hidden rounded-xl border bg-card shadow-[0_1px_2px_rgba(0,0,0,.03)]">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Vehicle</th>
                <th className="px-4 py-2 font-medium">Customer</th>
                <th className="px-4 py-2 font-medium">Locality</th>
                <th className="px-4 py-2 text-right font-medium">Odometer</th>
                <th className="px-4 py-2 font-medium">Last service</th>
                <th className="px-4 py-2 font-medium">Now</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {shown.slice(pg * PER, pg * PER + PER).map((r) => (
                <tr key={r.id} className="border-t hover:bg-muted/30">
                  <td className="px-4 py-2">
                    <Link href={`/vehicles/${r.id}`} className="inline-flex items-center gap-2 hover:opacity-80">
                      <Plate reg={r.reg_display} size="sm" />
                      <span className="text-xs">
                        {r.model} <span className="text-muted-foreground capitalize">{r.fuel}</span>
                      </span>
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    {r.customer_name}
                    <span className="block text-xs text-muted-foreground tabular-nums">{r.phone}</span>
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">{r.locality}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{r.odometer.toLocaleString("en-IN")} km</td>
                  <td className={cn("px-4 py-2", monthsSince(r.last_service_date) > 12 && "text-warning")}>{date(r.last_service_date)}</td>
                  <td className="px-4 py-2">
                    <div className="flex flex-wrap gap-1">
                      {r.open_job_card && <StagePill stage={r.open_job_card.stage ?? r.open_job_card.status} />}
                      {r.telemetry?.has_issue && <Badge variant="destructive">Car alert</Badge>}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-right"><FollowButton vehicleId={r.id} /></td>
                </tr>
              ))}
              {loading && Array.from({ length: 8 }).map((_, i) => (
                <tr key={i} className="border-t"><td colSpan={7} className="px-4 py-3"><div className="h-5 animate-pulse rounded bg-muted" /></td></tr>
              ))}
              {!shown.length && !loading && !error && <tr><td colSpan={7} className="px-4 py-10 text-center text-sm text-muted-foreground">No vehicles match this search.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground">
          <span>
            {shown.length ? `${pg * PER + 1}–${Math.min(shown.length, pg * PER + PER)} of ${shown.length}` : "0"}
            {capped && " · first 200 matches; search by reg no, name or mobile to narrow"}
          </span>
          <div className="flex gap-1">
            <Button size="xs" variant="outline" disabled={pg === 0} onClick={() => setPage(pg - 1)}>Previous</Button>
            <Button size="xs" variant="outline" disabled={pg >= pages - 1} onClick={() => setPage(pg + 1)}>Next</Button>
          </div>
        </div>
      </div>
    </div>
  )
}

const KIND_DOT: Record<string, string> = {
  service: "bg-emerald-500",
  appointment: "bg-sky-500",
  gate: "bg-slate-500",
  job_card: "bg-violet-500",
  invoice: "bg-amber-500",
  message: "bg-zinc-400",
}

function WhereNow({ j }: { j: Journey }) {
  const delivered = j.step === "delivery" && !!j.invoice
  return (
    <section className="rounded-xl border bg-card p-5 shadow-[0_1px_2px_rgba(0,0,0,.03)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">Where it is now</p>
          <p className="mt-0.5 text-lg font-semibold tracking-tight">
            Step {j.step_n} · {STEPS.find((s) => s.key === j.step)?.label}: <span className="text-primary">{j.status}</span>
          </p>
          <p className="text-sm text-muted-foreground">
            {[
              j.advisor && `Advisor ${j.advisor}`,
              j.driver && `Driver ${j.driver}`,
              j.promised && `promised ${clock(j.promised)}`,
              j.invoice && `invoice ${j.invoice}`,
            ]
              .filter(Boolean)
              .join(" · ") || "No open visit"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <FollowButton vehicleId={j.vehicle.id} className="h-8 border px-3 text-xs" />
          {j.next && (
            <Link href={j.next.href} className={buttonVariants({ size: "sm" })}>
              {j.next.label} →
            </Link>
          )}
        </div>
      </div>
      <ol className="mt-5 grid grid-cols-7 gap-1">
        {STEPS.map((s) => {
          const past = s.n < j.step_n || delivered
          const now = s.n === j.step_n && !delivered
          return (
            <li key={s.key} className="min-w-0">
              <div className={cn("h-1.5 rounded-full", past ? "bg-primary" : now ? "bg-brand-red" : "bg-muted")} />
              <p className={cn("mt-1.5 flex items-center gap-1 truncate text-[11px]", now ? "font-semibold text-foreground" : past ? "text-foreground" : "text-muted-foreground")}>
                <span className={cn("flex size-4 shrink-0 items-center justify-center rounded-full text-[9px]", past ? "bg-primary text-primary-foreground" : now ? "bg-brand-red text-white" : "bg-muted")}>
                  {past ? "✓" : s.n}
                </span>
                {s.short}
              </p>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

function Decisions({ j }: { j: Journey }) {
  const { presenter } = useJourney()
  return (
    <Panel
      title="Decisions on this visit"
      action={<span className="text-xs text-muted-foreground">{j.assists.length} made by the system, each open to the advisor</span>}
      bodyClassName="p-0"
    >
      {j.assists.length ? (
        <ol className="divide-y">
          {j.assists.map((a) => {
            const step = STEPS.find((s) => s.key === USE_CASES[a.uc]?.step)
            return (
              <li key={`${a.uc}-${a.title}`} className="flex items-start gap-3 px-5 py-3">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent text-[11px] font-bold text-primary">
                  {presenter ? a.uc : step?.n}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-muted-foreground">
                    {step?.label} · {USE_CASES[a.uc]?.title ?? a.title}
                    {presenter && <span className="ml-1 font-semibold text-primary">UC {a.uc}</span>}
                  </p>
                  <p className="text-sm font-medium">{a.outcome}</p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {a.review ? (
                    <Badge variant="outline" className="border-warning text-warning">Needs review</Badge>
                  ) : a.confidence != null ? (
                    <span className="text-[11px] text-muted-foreground tabular-nums">{Math.round(a.confidence * 100)}% likely</span>
                  ) : null}
                  {step && (
                    <Link href={a.decision_id ? `/ai?decision=${a.decision_id}` : step.href} className="text-[11px] text-primary hover:underline">
                      Why?
                    </Link>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      ) : (
        <p className="px-5 py-6 text-sm text-muted-foreground">Nothing decided yet; this vehicle has no visit in progress.</p>
      )}
    </Panel>
  )
}

export function Vehicle360View({ id }: { id: number }) {
  const [data, setData] = React.useState<Vehicle360 | null>(null)
  const [journey, setJourney] = React.useState<Journey | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const { setFocus } = useJourney()
  React.useEffect(() => {
    erp.vehicle(id).then(setData).catch((e) => setError(String(e.message ?? e)))
    erp.journey(id).then(setJourney).catch(() => setJourney(null))
  }, [id])

  if (error) return <p className="text-sm text-destructive">{error}</p>
  if (!data) return <div className="h-40 animate-pulse rounded-xl bg-muted" />
  const v = data.vehicle
  const open = data.open_job_card
  const lastVisit = data.visits[0]
  const insp = lastVisit?.inspection

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border bg-card p-5 shadow-[0_1px_2px_rgba(0,0,0,.03)]">
        <div className="flex items-center gap-4">
          <Plate reg={v.reg_display} size="lg" />
          <div>
            <h2 className="text-lg font-semibold tracking-tight">
              Maruti Suzuki {v.model} <span className="text-sm font-normal text-muted-foreground capitalize">· {v.fuel} · {v.odometer.toLocaleString("en-IN")} km</span>
            </h2>
            <p className="text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{v.customer_name}</span> · {v.phone} · {v.locality} · customer since {date(v.sale_date)}
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {open && <StagePill stage={open.stage} />}
              {v.telemetry?.has_issue && <AssistChip uc={1}>Car alert: {v.telemetry.reason}</AssistChip>}
              <span className="rounded-md bg-muted px-2 py-0.5 text-xs">Lifetime value {inr(data.lifetime_value)}</span>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {open && (
            <Link href={`/job-cards?jc=${open.id}`} onClick={() => setFocus(v.id)} className={buttonVariants({ size: "sm", variant: "outline" })}>
              Job card JC-{open.id}
            </Link>
          )}
          <Link href={`/crm?vehicle=${v.id}`} onClick={() => setFocus(v.id)} className={buttonVariants({ size: "sm", variant: "outline" })}>
            Contact customer
          </Link>
        </div>
      </div>

      {journey && <WhereNow j={journey} />}
      {journey && <Decisions j={journey} />}

      <div className="grid gap-5 xl:grid-cols-3">
        <div className="space-y-5 xl:col-span-2">
          <Panel title="Vehicle & customer">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-4">
              <Field label="VIN">
                <span className="font-mono text-xs">{v.vin}</span>
              </Field>
              <Field label="Sale date">{date(v.sale_date)}</Field>
              <Field label="Odometer">{v.odometer.toLocaleString("en-IN")} km</Field>
              <Field label="Avg running">{Math.round(v.avg_km_day)} km/day</Field>
              <Field label="Last service">{date(v.last_service_date)}</Field>
              <Field label="Last service km">{v.last_service_km?.toLocaleString("en-IN")} km</Field>
              <Field label="Preferred contact">
                <span className="capitalize">
                  {v.preferred_channel} · {v.preferred_time}
                </span>
              </Field>
              <Field label="Lifetime value">{inr(data.lifetime_value)}</Field>
            </dl>
          </Panel>

          <Panel title="Job cards" bodyClassName="p-0">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Job card</th>
                  <th className="px-4 py-2 font-medium">Opened</th>
                  <th className="px-4 py-2 font-medium">Jobs</th>
                  <th className="px-4 py-2 font-medium">Stage</th>
                  <th className="px-4 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {data.job_cards.map((j) => (
                  <tr key={j.id} className="border-t">
                    <td className="px-4 py-2">
                      <Link href={`/job-cards?jc=${j.id}`} className="font-medium hover:underline">
                        JC-{j.id}
                      </Link>
                    </td>
                    <td className="px-4 py-2">{dayTime(j.created_at)}</td>
                    <td className="px-4 py-2 text-muted-foreground">{j.demands.join(", ") || "—"}</td>
                    <td className="px-4 py-2"><StagePill stage={j.stage} /></td>
                    <td className="px-4 py-2 text-right tabular-nums">{inr(j.amount)}</td>
                  </tr>
                ))}
                {data.job_cards.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-4 text-center text-muted-foreground">No job cards in the system yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </Panel>

          <Panel title="Service history" bodyClassName="p-0">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Date</th>
                  <th className="px-4 py-2 font-medium">Type</th>
                  <th className="px-4 py-2 text-right font-medium">Km</th>
                  <th className="px-4 py-2 font-medium">Jobs</th>
                  <th className="px-4 py-2 font-medium">Advisor</th>
                  <th className="px-4 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {data.history.map((h) => (
                  <tr key={h.id} className="border-t">
                    <td className="px-4 py-2">{date(h.date)}</td>
                    <td className="px-4 py-2 capitalize">{h.kind}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{h.km.toLocaleString("en-IN")}</td>
                    <td className="px-4 py-2 font-mono text-xs">{(h.demand_codes ?? []).join(", ")}</td>
                    <td className="px-4 py-2">{h.advisor_name ?? "—"}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{inr(h.amount ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>

        <div className="space-y-5">
          {lastVisit && (
            <Panel title={`Last arrival · ${dayTime(lastVisit.arrived_at)}`}>
              <dl className="grid grid-cols-2 gap-3">
                <Field label="Odometer in">{lastVisit.odometer?.toLocaleString("en-IN")} km</Field>
                <Field label="Advisor">{lastVisit.advisor_name}</Field>
                <Field label="Fuel level">{insp?.fuel}</Field>
                <Field label="Belongings">
                  {insp ? Object.entries(insp.checklist).filter(([, y]) => y).map(([k]) => k).join(", ") : null}
                </Field>
              </dl>
              {insp?.concerns && <p className="mt-3 text-sm">“{insp.concerns}”</p>}
              {insp?.signature && (
                <div className="mt-3">
                  <p className="text-xs text-muted-foreground">Customer signature</p>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={insp.signature} alt="Customer signature" className="mt-1 h-16 rounded border bg-white" />
                </div>
              )}
            </Panel>
          )}
          {data.inspections.length > 0 && (
            <Panel title="Damage inspections">
              <ul className="space-y-3">
                {data.inspections.map((ins) => (
                  <li key={ins.id} className="text-sm">
                    <p className="font-medium">{ins.summary}</p>
                    <p className="text-xs text-muted-foreground">
                      #{ins.id} · {dayTime(ins.created_at)} · {ins.progress.done}/{ins.progress.total} photos
                      {ins.engine?.includes("laya") ? " · note by Laya" : ""}
                    </p>
                    <div className="mt-1.5 flex gap-1.5 overflow-x-auto">
                      {ins.photos.map((p) => (
                        <a key={p.index} href={p.annotated_url ?? p.photo_url} target="_blank" className="shrink-0" title={`${p.angle}: ${p.result ?? p.status}`}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={p.annotated_url ?? p.photo_url}
                            alt={p.angle}
                            className={cn("h-14 w-20 rounded border-2 object-cover", p.decision === "damage_detected" ? "border-destructive" : "border-transparent")}
                          />
                        </a>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
          <Panel title="Invoices">
            {data.invoices.length ? (
              <ul className="space-y-2 text-sm">
                {data.invoices.map((i) => (
                  <li key={i.id} className="flex justify-between gap-2">
                    <span>
                      <span className="font-mono text-xs">{i.number}</span>
                      <span className="block text-xs text-muted-foreground">
                        {dayTime(i.created_at)} · {i.payment_mode}
                      </span>
                    </span>
                    <span className="font-medium tabular-nums">{inr(i.total)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No invoices in this system yet.</p>
            )}
          </Panel>
          <Panel title="Activity">
            <ol className="relative space-y-3 border-l pl-4">
              {data.timeline.map((e, i) => (
                <li key={i} className="text-sm">
                  <span className={cn("absolute -left-[5px] mt-1.5 size-2.5 rounded-full", KIND_DOT[e.kind] ?? "bg-zinc-400")} />
                  <p>{e.text}</p>
                  <p className="text-xs text-muted-foreground">{e.at.length > 10 ? dayTime(e.at) : date(e.at)}</p>
                </li>
              ))}
            </ol>
          </Panel>
        </div>
      </div>
    </div>
  )
}
