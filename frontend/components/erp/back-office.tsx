"use client"

// Step 7 · Billing & delivery, plus the back office it depends on: parts (stock across
// own store, Dealer B and the regional warehouse, reserved against job cards) and outlet
// setup (the people and bays every other screen allocates from).

import * as React from "react"
import Link from "next/link"
import { toast } from "sonner"

import { getHealth, type HealthResponse } from "@/lib/api"
import { erp, type BoardCard, type Invoice, type PartsView, type StaffView, type WorkOrder } from "@/lib/erp-api"
import { service, type EstimateLine } from "@/lib/service-api"
import { clock, dayTime, inr } from "@/lib/format"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Kpi, PageHeader, Panel, usePoll } from "@/components/erp/kit"
import { AssistChip, FollowButton, Plate, useJourney } from "@/components/erp/journey"

const TH = "px-4 py-2 font-medium"
const TD = "px-4 py-2"
const CARD = "rounded-xl border bg-card shadow-[0_1px_2px_rgba(0,0,0,.03)]"

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors",
        on ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted"
      )}
    >
      {children}
    </button>
  )
}

function Pager({ page, pages, total, onPage }: { page: number; pages: number; total: number; onPage: (p: number) => void }) {
  if (pages <= 1) return null
  return (
    <div className="flex items-center justify-between border-t px-4 py-2 text-xs text-muted-foreground">
      <span>
        {total.toLocaleString("en-IN")} rows · page {page + 1} of {pages}
      </span>
      <div className="flex gap-1">
        <Button size="xs" variant="outline" disabled={page === 0} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <Button size="xs" variant="outline" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  )
}

function useDeepLinkVehicle() {
  const [v, setV] = React.useState<number | null>(null)
  React.useEffect(() => {
    const t = window.setTimeout(() => setV(Number(new URLSearchParams(window.location.search).get("v")) || null), 0)
    return () => window.clearTimeout(t)
  }, [])
  return v
}

// ------------------------------------------------------------------ parts

const SOURCE: Record<string, { label: string; tone: string }> = {
  own: { label: "Own stock", tone: "bg-success/10 text-success" },
  dealer_b: { label: "Transfer · Dealer B", tone: "border bg-card text-warning" },
  warehouse: { label: "Ordered · warehouse", tone: "border bg-card text-info" },
}

export function PartsInventory() {
  const [data, setData] = React.useState<PartsView | null>(null)
  const [q, setQ] = React.useState("")
  const [view, setView] = React.useState<"all" | "short" | "reserved">("all")
  React.useEffect(() => {
    erp.parts().then(setData).catch(() => undefined)
  }, [])
  const all = data?.items ?? []
  const short = all.filter((p) => !(p.stock.own > 0))
  const items = (view === "short" ? short : view === "reserved" ? all.filter((p) => p.reserved > 0) : all).filter(
    (p) => !q || `${p.part_no} ${p.name}`.toLowerCase().includes(q.toLowerCase())
  )
  const res = data?.reservations ?? []
  const bySource = (k: string) => res.filter((r) => r.location === k).length
  const nameOf = (no: string) => all.find((p) => p.part_no === no)?.name ?? no

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Part numbers stocked" value={all.length || "–"} hint={data ? `${data.locations.length} locations` : undefined} />
        <Kpi label="Short in own store" value={short.length} tone={short.length ? "warn" : undefined} hint="sourced from network when needed" />
        <Kpi label="Reserved against job cards" value={res.length} hint={`${bySource("own")} own · ${bySource("dealer_b")} transfer · ${bySource("warehouse")} order`} />
        <Kpi label="Stock value (own)" value={data ? inr(all.reduce((s, p) => s + (p.stock.own ?? 0) * p.price, 0)) : "–"} />
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        <section className={cn(CARD, "overflow-hidden xl:col-span-2")}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
            <div className="flex flex-wrap gap-1.5">
              <Chip on={view === "all"} onClick={() => setView("all")}>All <span className="tabular-nums opacity-70">{all.length}</span></Chip>
              <Chip on={view === "short"} onClick={() => setView("short")}>Short in own store <span className="tabular-nums opacity-70">{short.length}</span></Chip>
              <Chip on={view === "reserved"} onClick={() => setView("reserved")}>Reserved <span className="tabular-nums opacity-70">{all.filter((p) => p.reserved > 0).length}</span></Chip>
            </div>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search part no or name" className="h-8 w-56" />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th className={TH}>Part</th>
                  <th className={cn(TH, "text-right")}>MRP</th>
                  {data?.locations.map((l) => (
                    <th key={l.key} className={cn(TH, "text-right")}>
                      {l.label.split(" (")[0]}
                      <span className="block text-[10px] font-normal">{l.eta_hours ? `${l.eta_hours}h away` : "on hand"}</span>
                    </th>
                  ))}
                  <th className={cn(TH, "text-right")}>Reserved</th>
                </tr>
              </thead>
              <tbody>
                {items.map((p) => {
                  const out = !(p.stock.own > 0)
                  return (
                    <tr key={p.part_no} className="border-t hover:bg-muted/30">
                      <td className={TD}>
                        <span className="font-medium">{p.name}</span>
                        <span className="block font-mono text-[11px] text-muted-foreground">
                          {p.part_no}
                          {p.alt.length > 0 && <span className="font-sans"> · alternative {p.alt.join(", ")}</span>}
                        </span>
                      </td>
                      <td className={cn(TD, "text-right tabular-nums")}>{inr(p.price)}</td>
                      {data?.locations.map((l) => (
                        <td key={l.key} className={cn(TD, "text-right tabular-nums", l.key === "own" && out && "font-semibold text-brand-red")}>
                          {p.stock[l.key] ?? 0}
                        </td>
                      ))}
                      <td className={cn(TD, "text-right tabular-nums")}>{p.reserved || "—"}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {data && items.length === 0 && <p className="p-6 text-center text-sm text-muted-foreground">No parts match.</p>}
          </div>
        </section>
        <section className={cn(CARD, "flex flex-col overflow-hidden")}>
          <div className="border-b px-4 py-3">
            <h3 className="text-sm font-semibold">Reserved for job cards</h3>
            <p className="text-xs text-muted-foreground">Where each part is coming from, decided when the job card was drafted</p>
          </div>
          <ul className="max-h-[40rem] divide-y overflow-y-auto">
            {res.map((r) => {
              const src = SOURCE[r.location] ?? { label: r.location, tone: "bg-muted" }
              const eta = data?.locations.find((l) => l.key === r.location)?.eta_hours ?? 0
              const original = all.find((p) => p.alt.includes(r.part_no))
              return (
                <li key={r.id} className="px-4 py-2.5 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <span className="min-w-0">
                      <span className="font-medium">{r.name}</span> <span className="text-muted-foreground">× {r.qty}</span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Plate reg={r.reg_display} size="sm" />
                        <Link href={`/job-cards?jc=${r.job_card_id}`} className="hover:underline">JC-{r.job_card_id}</Link>
                      </span>
                    </span>
                    <span className={cn("shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium", src.tone)}>{src.label}</span>
                  </div>
                  {(r.location !== "own" || original) && (
                    <AssistChip uc={11} className="mt-1.5">
                      {original
                        ? `Alternative fitted for ${nameOf(original.part_no)} · no wait`
                        : r.location === "dealer_b"
                          ? `Transfer from Dealer B · arrives in ${eta}h`
                          : `Ordered from warehouse · ${eta}h`}
                    </AssistChip>
                  )}
                </li>
              )
            })}
            {data && res.length === 0 && <li className="p-6 text-center text-sm text-muted-foreground">No reservations.</li>}
          </ul>
        </section>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- billing

const MODES = ["UPI", "Card", "Cash", "Insurance"] as const
const PAYER_TONE: Record<string, string> = {
  customer: "bg-muted text-foreground",
  warranty: "bg-success/10 text-success",
  campaign: "bg-accent text-accent-foreground",
}

type Delivered = { card: BoardCard; invoice: Invoice }

export function Billing() {
  const { data, refresh } = usePoll(() => erp.invoices())
  const { setFocus, refresh: refreshJourney } = useJourney()
  const deepLink = useDeepLinkVehicle()
  const [selId, setSelId] = React.useState<number | null>(null)
  const [q, setQ] = React.useState("")
  const [mode, setMode] = React.useState<string>("UPI")
  const [busy, setBusy] = React.useState(false)
  const [done, setDone] = React.useState<Delivered | null>(null)
  const [wo, setWo] = React.useState<WorkOrder | null>(null)
  const [regQ, setRegQ] = React.useState("")
  const [page, setPage] = React.useState(0)

  const ready = data?.ready_to_bill ?? []
  const invoices: Invoice[] = data?.invoices ?? []
  const today = invoices.length ? invoices.map((i) => i.created_at.slice(0, 10)).sort().at(-1)! : ""
  const todays = invoices.filter((i) => i.created_at.slice(0, 10) === today)

  // selection: explicit click > deep link > first in queue
  const selected =
    ready.find((c) => c.vehicle_id === selId) ?? ready.find((c) => c.vehicle_id === deepLink) ?? (done ? null : ready[0]) ?? null
  const jc = selected?.job_card_id ?? null

  React.useEffect(() => {
    if (!jc) return
    let live = true
    erp.workOrder(jc).then((w) => live && setWo(w)).catch(() => undefined)
    return () => {
      live = false
    }
  }, [jc])
  const preview = wo && wo.job_card.id === jc ? wo : null

  const list = ready.filter(
    (c) => !q || `${c.reg_no} ${c.reg_display} ${c.customer_name} JC-${c.job_card_id}`.toLowerCase().includes(q.toLowerCase())
  )

  async function deliver() {
    if (!selected?.job_card_id) return
    setBusy(true)
    setFocus(selected.vehicle_id)
    try {
      const res = await erp.deliver(selected.job_card_id, mode)
      if (res.invoice) setDone({ card: selected, invoice: res.invoice })
      setSelId(null)
      toast.success(`Invoice ${res.invoice?.number} raised · ${selected.reg_display} delivered`)
      await refresh()
      refreshJourney()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const reg = invoices.filter(
    (i) => !regQ || `${i.number} ${i.reg_no} ${i.reg_display} ${i.customer_name}`.toLowerCase().includes(regQ.toLowerCase())
  )
  const PER = 12
  const pages = Math.ceil(reg.length / PER)
  const pg = Math.min(page, Math.max(pages - 1, 0))

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Ready to bill" value={data ? ready.length : "–"} tone={ready.length ? "good" : undefined} hint="passed quality check" />
        <Kpi label="Invoices today" value={todays.length} />
        <Kpi label="Collected today" value={inr(todays.reduce((s, i) => s + i.total, 0))} />
        <Kpi label="GST today" value={inr(todays.reduce((s, i) => s + i.gst, 0))} hint={`@ ${Math.round((data?.gst_rate ?? 0.18) * 100)}%`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        {/* queue */}
        <section className={cn(CARD, "flex flex-col overflow-hidden")}>
          <div className="border-b px-4 py-3">
            <h3 className="text-sm font-semibold">
              Ready for delivery <span className="ml-1 rounded-md bg-muted px-1.5 text-xs tabular-nums">{ready.length}</span>
            </h3>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search reg no, customer, JC" className="mt-2 h-8" />
          </div>
          <ul className="max-h-[32rem] divide-y overflow-y-auto">
            {list.map((c) => {
              const on = selected?.key === c.key
              return (
                <li key={c.key}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelId(c.vehicle_id)
                      setDone(null)
                      setFocus(c.vehicle_id)
                    }}
                    className={cn("flex w-full items-center justify-between gap-2 px-4 py-2.5 text-left hover:bg-muted/50", on && "bg-accent hover:bg-accent")}
                  >
                    <span className="min-w-0">
                      <Plate reg={c.reg_display} size="sm" />
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {c.model} · {c.customer_name}
                      </span>
                    </span>
                    <span className="text-right">
                      <span className="block text-sm font-semibold tabular-nums">{inr(c.amount ?? 0)}</span>
                      <span className="text-[11px] text-muted-foreground">JC-{c.job_card_id}</span>
                    </span>
                  </button>
                </li>
              )
            })}
            {data && ready.length === 0 && (
              <li className="px-4 py-8 text-center text-sm text-muted-foreground">
                Nothing waiting. Vehicles appear here when they pass QC on the{" "}
                <Link href="/workshop" className="text-primary hover:underline">workshop floor</Link>.
              </li>
            )}
          </ul>
        </section>

        {/* invoice preview / delivered */}
        <section className={cn(CARD, "overflow-hidden")}>
          {done && !selId ? (
            <DeliveredView d={done} />
          ) : selected ? (
            <InvoicePreview card={selected} wo={preview} mode={mode} setMode={setMode} busy={busy} onDeliver={deliver} gstRate={data?.gst_rate ?? 0.18} />
          ) : (
            <p className="p-10 text-center text-sm text-muted-foreground">Select a vehicle to prepare its invoice.</p>
          )}
        </section>
      </div>

      <section className={cn(CARD, "overflow-hidden")}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <h3 className="text-sm font-semibold">Invoice register</h3>
          <Input value={regQ} onChange={(e) => { setRegQ(e.target.value); setPage(0) }} placeholder="Search invoice no, reg no, customer" className="h-8 w-64" />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className={TH}>Invoice no</th>
                <th className={TH}>Issued</th>
                <th className={TH}>Vehicle</th>
                <th className={TH}>Customer</th>
                <th className={cn(TH, "text-right")}>Labour</th>
                <th className={cn(TH, "text-right")}>Parts</th>
                <th className={cn(TH, "text-right")}>GST</th>
                <th className={cn(TH, "text-right")}>Total</th>
                <th className={TH}>Payment</th>
              </tr>
            </thead>
            <tbody>
              {reg.slice(pg * PER, pg * PER + PER).map((i) => (
                <tr key={i.id} className={cn("border-t hover:bg-muted/30", done?.invoice.id === i.id && "bg-success/5")}>
                  <td className={cn(TD, "font-mono text-xs")}>{i.number}</td>
                  <td className={cn(TD, "whitespace-nowrap")}>{dayTime(i.created_at)}</td>
                  <td className={TD}>
                    <Link href={`/vehicles/${i.vehicle_id}`} className="hover:opacity-80">
                      <Plate reg={i.reg_display ?? i.reg_no ?? ""} size="sm" />
                    </Link>
                  </td>
                  <td className={TD}>{i.customer_name}</td>
                  <td className={cn(TD, "text-right tabular-nums")}>{inr(i.labour)}</td>
                  <td className={cn(TD, "text-right tabular-nums")}>{inr(i.parts)}</td>
                  <td className={cn(TD, "text-right tabular-nums")}>{inr(i.gst)}</td>
                  <td className={cn(TD, "text-right font-medium tabular-nums")}>{inr(i.total)}</td>
                  <td className={TD}>
                    <Badge variant="secondary">{i.paid ? `Paid · ${i.payment_mode}` : "Due"}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Pager page={pg} pages={pages} total={reg.length} onPage={setPage} />
      </section>
    </div>
  )
}

function InvoicePreview({
  card,
  wo,
  mode,
  setMode,
  busy,
  onDeliver,
  gstRate,
}: {
  card: BoardCard
  wo: WorkOrder | null
  mode: string
  setMode: (m: string) => void
  busy: boolean
  onDeliver: () => void
  gstRate: number
}) {
  const est = wo?.job_card.payload.estimate
  const lines: EstimateLine[] = est?.lines ?? []
  const t = est?.totals
  const payable = t?.customer_payable ?? card.amount ?? 0
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
        <div>
          <div className="flex items-center gap-2">
            <Plate reg={card.reg_display} size="md" />
            <FollowButton vehicleId={card.vehicle_id} />
          </div>
          <p className="mt-1 text-sm">
            <span className="font-medium">{card.customer_name}</span>
            <span className="text-muted-foreground"> · {card.model} · advisor {card.advisor_name ?? "—"}</span>
          </p>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          <p className="font-medium text-foreground">Proforma · JC-{card.job_card_id}</p>
          <p>
            {card.technician && `${card.technician} · `}
            {card.bay}
          </p>
          <Link href={`/vehicles/${card.vehicle_id}`} className="text-primary hover:underline">
            Vehicle record →
          </Link>
        </div>
      </div>

      <div className="px-5 py-3">
        {!wo ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => <div key={i} className="h-6 animate-pulse rounded bg-muted" />)}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-[11px] tracking-wide text-muted-foreground uppercase">
              <tr>
                <th className="py-1.5 font-medium">Item</th>
                <th className="py-1.5 font-medium">Payer</th>
                <th className="py-1.5 text-right font-medium">Qty</th>
                <th className="py-1.5 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id} className="border-t">
                  <td className="py-1.5">
                    {l.desc}
                    <span className="ml-1.5 text-[11px] text-muted-foreground">{l.type === "labour" ? "Labour" : l.code}</span>
                    {l.substituted_for && <AssistChip uc={11} className="ml-1.5">Alternative part · in stock</AssistChip>}
                  </td>
                  <td className="py-1.5">
                    <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium capitalize", PAYER_TONE[l.payer])}>{l.payer}</span>
                  </td>
                  <td className="py-1.5 text-right tabular-nums">{l.type === "labour" ? `${l.hours ?? l.qty}h` : l.qty}</td>
                  <td className={cn("py-1.5 text-right tabular-nums", l.payer !== "customer" && "text-muted-foreground line-through")}>{inr(l.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="grid gap-4 border-t bg-muted/30 px-5 py-4 md:grid-cols-2">
        <dl className="space-y-1 text-sm">
          <Row k="Labour" v={inr(t?.labour ?? 0)} />
          <Row k="Parts" v={inr(t?.parts ?? 0)} />
          <Row k={`GST @ ${Math.round(gstRate * 100)}%`} v={inr(t?.gst ?? 0)} />
          {(t?.warranty_value ?? 0) > 0 && <Row k="Covered by warranty (Maruti)" v={`− ${inr(t!.warranty_value)}`} tone="text-success" />}
          {(t?.campaign_value ?? 0) > 0 && <Row k="Covered by campaign" v={`− ${inr(t!.campaign_value)}`} tone="text-primary" />}
          <div className="mt-2 flex items-baseline justify-between border-t pt-2">
            <dt className="font-semibold">Customer pays</dt>
            <dd className="text-2xl font-semibold tracking-tight tabular-nums">{inr(payable)}</dd>
          </div>
        </dl>
        <div className="flex flex-col justify-between gap-3">
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">Payment mode</p>
            <div className="grid grid-cols-4 gap-1 rounded-xl border bg-card p-1">
              {MODES.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={cn("rounded-lg py-1.5 text-xs font-medium", mode === m ? "bg-primary text-primary-foreground" : "hover:bg-muted")}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>
          <Button size="lg" disabled={busy || !wo} onClick={onDeliver} className="w-full">
            {busy ? "Raising invoice…" : `Collect ${inr(payable)} · invoice & deliver`}
          </Button>
          <p className="text-center text-[11px] text-muted-foreground">Raises the GST invoice, closes JC-{card.job_card_id} and messages the customer</p>
        </div>
      </div>
    </div>
  )
}

function Row({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div className={cn("flex justify-between", tone)}>
      <dt className={tone ? undefined : "text-muted-foreground"}>{k}</dt>
      <dd className="tabular-nums">{v}</dd>
    </div>
  )
}

function DeliveredView({ d }: { d: Delivered }) {
  const i = d.invoice
  return (
    <div className="p-6">
      <div className="flex items-center gap-3">
        <span className="flex size-10 items-center justify-center rounded-full bg-success/10 text-lg text-success">✓</span>
        <div>
          <p className="text-base font-semibold">Delivered · invoice {i.number}</p>
          <p className="text-sm text-muted-foreground">
            {d.card.customer_name} · {d.card.model} · paid {inr(i.total)} by {i.payment_mode} at {clock(i.created_at)}
          </p>
        </div>
      </div>
      <div className="mt-5 grid grid-cols-4 gap-3 rounded-xl border bg-muted/30 p-4 text-sm">
        <div><p className="text-xs text-muted-foreground">Labour</p><p className="font-medium tabular-nums">{inr(i.labour)}</p></div>
        <div><p className="text-xs text-muted-foreground">Parts</p><p className="font-medium tabular-nums">{inr(i.parts)}</p></div>
        <div><p className="text-xs text-muted-foreground">GST</p><p className="font-medium tabular-nums">{inr(i.gst)}</p></div>
        <div><p className="text-xs text-muted-foreground">Total</p><p className="font-semibold tabular-nums">{inr(i.total)}</p></div>
      </div>
      <div className="mt-4 flex items-start gap-3 rounded-xl border border-primary/20 bg-accent px-4 py-3 text-sm">
        <Plate reg={d.card.reg_display} size="sm" className="mt-0.5 shrink-0" />
        <p>
          Gate-out happens at security (staff app <span className="font-mono text-xs">/m/gate</span>): the guard scans the plate and
          the system checks the invoice is closed before the car leaves.
        </p>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Link href={`/vehicles/${d.card.vehicle_id}`} className={buttonVariants({ size: "sm" })}>
          Open vehicle record
        </Link>
        <Link href="/m/gate" className={buttonVariants({ size: "sm", variant: "outline" })}>
          Security gate app
        </Link>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ admin

const ROLE: Record<string, string> = {
  service_manager: "Service manager",
  security: "Security",
  cashier: "Cashier",
}

export function Admin() {
  const [staff, setStaff] = React.useState<StaffView | null>(null)
  const [health, setHealth] = React.useState<HealthResponse | null>(null)
  React.useEffect(() => {
    erp.staff().then(setStaff).catch(() => undefined)
    getHealth().then(setHealth).catch(() => undefined)
  }, [])

  const services = health
    ? [
        ["Arrival condition photos", Boolean(health.damage?.ok && health.damage?.model_loaded)],
        ["Gate document capture", Boolean(health.ocr?.ok)],
        ["Vehicle health signals", Boolean(health.telemetry?.ok)],
        ["Concern suggestions", Boolean(health.llm?.available)],
      ]
    : []

  return (
    <div className="space-y-5">
      <PageHeader
        title="Masters"
        subtitle={staff ? `${staff.advisors.length} advisors · ${staff.technicians.length} technicians · ${staff.drivers.length} drivers · ${staff.bays.length} bays: the capacity every booking, arrival and bay allocation draws on` : "Loading…"}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              await service.resetDemo()
              toast.success("Demo data reset")
              location.reload()
            }}
          >
            Reset demo data
          </Button>
        }
      />
      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title={`Service advisors (${staff?.advisors.length ?? 0})`} bodyClassName="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className={TH}>Name</th>
                <th className={TH}>Languages</th>
                <th className={TH}>Specialisation</th>
                <th className={cn(TH, "text-right")}>Daily cap</th>
                <th className={TH}>Status</th>
              </tr>
            </thead>
            <tbody>
              {staff?.advisors.map((a) => (
                <tr key={a.id} className="border-t">
                  <td className={TD}>{a.name}</td>
                  <td className={cn(TD, "uppercase")}>{a.languages.join(", ")}</td>
                  <td className={cn(TD, "capitalize")}>{a.skills.join(", ")}</td>
                  <td className={cn(TD, "text-right")}>{a.max_load}</td>
                  <td className={TD}><Badge variant={a.on_duty ? "secondary" : "outline"}>{a.on_duty ? "On duty" : "Off"}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title={`Technicians (${staff?.technicians.length ?? 0})`} bodyClassName="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className={TH}>Name</th>
                <th className={TH}>Skills</th>
                <th className={TH}>Certification</th>
                <th className={TH}>Status</th>
              </tr>
            </thead>
            <tbody>
              {staff?.technicians.map((t) => (
                <tr key={t.id} className="border-t">
                  <td className={TD}>{t.name}</td>
                  <td className={cn(TD, "capitalize")}>{t.skills.join(", ")}</td>
                  <td className={TD}>{t.certifications.join(", ")}</td>
                  <td className={TD}><Badge variant={t.on_duty ? "secondary" : "outline"}>{t.on_duty ? "On duty" : "Off"}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title={`Drivers (${staff?.drivers.length ?? 0})`} bodyClassName="p-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className={TH}>Name</th>
                <th className={TH}>Rating</th>
                <th className={TH}>Trips today</th>
                <th className={TH}>Shift ends</th>
                <th className={TH}>Status</th>
              </tr>
            </thead>
            <tbody>
              {staff?.drivers.map((d) => (
                <tr key={d.id} className="border-t">
                  <td className={TD}>{d.name}</td>
                  <td className={TD}>{d.rating}★</td>
                  <td className={TD}>
                    {d.trips_today} / {d.max_trips}
                  </td>
                  <td className={TD}>{d.shift_end}</td>
                  <td className={cn(TD, "capitalize")}>{d.status.replace("_", " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <div className="space-y-5">
          <Panel title={`Bays (${staff?.bays.length ?? 0}) & outlet staff`}>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {staff?.bays.map((b) => (
                <span key={b.id} className={cn("rounded-lg border px-2.5 py-1.5 text-sm", !b.active && "opacity-50")}>
                  <span className="font-medium">{b.name}</span>
                  <span className="block text-[11px] text-muted-foreground capitalize">{b.type}</span>
                </span>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap gap-2 border-t pt-3">
              {staff?.others.map((o) => (
                <span key={o.id} className="rounded-lg bg-muted px-3 py-1.5 text-sm">
                  {o.name} <span className="text-xs text-muted-foreground">· {ROLE[o.role] ?? o.role}</span>
                </span>
              ))}
            </div>
          </Panel>
          <Panel title="Service readiness">
            <p className="mb-3 text-xs text-muted-foreground">Capabilities used within the service journey</p>
            <ul className="grid grid-cols-2 gap-2 text-sm">
              {services.map(([label, ok]) => (
                <li key={label as string} className="flex items-center gap-2">
                  <span className={cn("size-2 rounded-full", ok ? "bg-emerald-500" : "bg-destructive")} />
                  {label}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-muted-foreground">Last refreshed {clock(new Date().toISOString())}</p>
          </Panel>
        </div>
      </div>
    </div>
  )
}
