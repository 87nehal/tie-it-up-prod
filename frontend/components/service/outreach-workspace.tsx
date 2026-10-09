"use client"

import * as React from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { toast } from "sonner"

import { service, type DueList, type DueScore, type NextBestAction, type OutboxItem } from "@/lib/service-api"
import { dayTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { AssistChip, FollowButton, Plate, useJourney } from "@/components/erp/journey"
import { regDisplay } from "@/components/erp/appointments"

type Row = DueScore & { last_at_dealer?: boolean }
type Filter = "all" | "overdue" | "week" | "fault" | "risk" | "booked"

const PAGE = 20
const card = "rounded-xl border bg-card shadow-[0_1px_2px_rgba(0,0,0,.03)]"
const LANG: Record<string, string> = { hi: "Hindi", en: "English", pa: "Punjabi", ta: "Tamil", te: "Telugu", mr: "Marathi", bn: "Bengali", gu: "Gujarati", kn: "Kannada" }
const CHANNEL: Record<string, string> = { app: "App notification", call: "Phone call", in_dealer: "At next visit", sms: "SMS", whatsapp: "WhatsApp" }
const ACTION: Record<string, string> = { win_back: "Win-back", reminder: "Service reminder", telemetry_alert: "Fault follow-up", urgent: "Urgent call" }
const FAULT: Record<string, string> = { "BAT-START": "Weak battery", "ENG-MIL": "Engine warning light", "ENG-TEMP": "Engine running hot", "BRK-WEAR": "Brake wear" }

const fault = (r: Row) => r.tele_flags.length > 0 || !!r.telemetry?.has_issue
const tests: Record<Filter, (r: Row) => boolean> = {
  all: (r) => !r.booked,
  overdue: (r) => !r.booked && r.due_in_days < 0,
  week: (r) => !r.booked && r.due_in_days >= 0 && r.due_in_days <= 7,
  fault: (r) => !r.booked && fault(r),
  risk: (r) => !r.booked && r.retention_risk > 0.55,
  booked: (r) => r.booked,
}
const LABEL: Record<Filter, string> = { all: "To contact", overdue: "Overdue", week: "Due this week", fault: "Car reported a fault", risk: "At risk of leaving", booked: "Already booked" }

function dueText(d: number) {
  if (d < 0) return -d > 60 ? `${Math.round(-d / 30)} mo overdue` : `${-d} d overdue`
  if (d === 0) return "Due today"
  return `Due in ${d} d`
}

/** One short, human reason for the list row (UC1 outcome). */
function headline(r: Row) {
  if (r.tele_flags.length) return `Car reported: ${FAULT[r.tele_flags[0]] ?? r.tele_flags[0]}`
  if (r.last_at_dealer === false) return "Last service done elsewhere"
  const km = r.reasons[0]?.match(/^([\d,]+) km past/)
  if (km) return `${km[1]} km past interval`
  return r.reasons[0] ?? "Approaching service interval"
}

function whyDue(r: Row) {
  const out: { text: string; tone?: "bad" }[] = []
  for (const f of r.tele_flags) out.push({ text: `Connected car: ${FAULT[f] ?? f}`, tone: "bad" })
  if (r.telemetry?.has_issue && !r.tele_flags.length) out.push({ text: r.telemetry.rule_hits[0] ?? "Connected car flagged an issue", tone: "bad" })
  out.push({ text: `${r.km_since.toLocaleString("en-IN")} km since last service` })
  out.push({ text: `${r.days_since} days since last visit` })
  if (r.last_at_dealer === false) out.push({ text: "Went to another workshop last time", tone: "bad" })
  return out
}

export function OutreachWorkspace() {
  const params = useSearchParams()
  const deep = Number(params.get("v") || params.get("vehicle") || params.get("book")) || null
  const { setFocus, refresh } = useJourney()

  const [list, setList] = React.useState<DueList | null>(null)
  const [outbox, setOutbox] = React.useState<OutboxItem[]>([])
  const [q, setQ] = React.useState("")
  const [filter, setFilter] = React.useState<Filter>("all")
  const [page, setPage] = React.useState(0)
  const [selected, setSelected] = React.useState<number | null>(deep)
  const [nba, setNba] = React.useState<NextBestAction | null>(null)
  const [message, setMessage] = React.useState("")
  const [busy, setBusy] = React.useState<string | null>(null)
  const [sent, setSent] = React.useState<number | null>(null)

  const load = React.useCallback(async () => {
    try {
      const [d, o] = await Promise.all([service.due(30), service.outbox()])
      setList(d)
      setOutbox(o)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load")
    }
  }, [])
  React.useEffect(() => {
    const t = window.setTimeout(load, 0)
    return () => window.clearTimeout(t)
  }, [load])

  const pick = React.useCallback(async (id: number, llm = false) => {
    setSelected(id)
    setFocus(id)
    if (!llm) { setNba(null); setSent(null) }
    setBusy(llm ? "llm" : "nba")
    try {
      const n = await service.nba(id, llm)
      setNba(n)
      setMessage(n.message)
      if (llm && n.message_engine !== "ollama") toast.info("Kept the standard wording")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed")
    } finally {
      setBusy(null)
    }
  }, [setFocus])

  React.useEffect(() => {
    if (!deep) return
    const t = window.setTimeout(() => void pick(deep), 0)
    return () => window.clearTimeout(t)
  }, [deep, pick])

  const rows = React.useMemo(
    () => [...((list?.customers ?? []) as Row[])].sort((a, b) => b.priority - a.priority),
    [list]
  )
  const needle = q.trim().toLowerCase().replace(/\s+/g, "")
  const visible = rows.filter((r) => tests[filter](r) && (!needle || `${r.customer_name}${r.reg_no}${r.model}`.toLowerCase().replace(/\s+/g, "").includes(needle)))
  const pages = Math.max(1, Math.ceil(visible.length / PAGE))
  const cur = Math.min(page, pages - 1)

  // keep a deep-linked customer visible in the list
  React.useEffect(() => {
    if (!deep || !rows.length) return
    const i = visible.findIndex((r) => r.vehicle_id === deep)
    const t = window.setTimeout(() => {
      if (i >= 0) setPage(Math.floor(i / PAGE))
      else if (rows.some((r) => r.vehicle_id === deep && r.booked)) setFilter("booked")
    }, 0)
    return () => window.clearTimeout(t)
  }, [deep, rows.length]) // eslint-disable-line react-hooks/exhaustive-deps

  const row = rows.find((r) => r.vehicle_id === selected) ?? null
  const contacted = new Set(outbox.filter((o) => !o.action.startsWith("jc")).map((o) => o.vehicle_id))

  async function send() {
    if (!nba) return
    setBusy("send")
    try {
      await service.send({ vehicle_id: nba.vehicle_id, action: nba.action, channel: nba.channel, offer: nba.offer, message })
      setSent(nba.vehicle_id)
      setOutbox(await service.outbox())
      refresh()
      toast.success(`Reminder queued for ${nba.customer_name}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed")
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        Customers due for service in the next 30 days, most urgent first. Pick one to see who to contact, how, and when.
      </p>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_440px]">
        <section className={card}>
          <div className="space-y-3 border-b p-4">
            <Input type="search" value={q} onChange={(e) => { setQ(e.target.value); setPage(0) }} placeholder="Search customer, registration or model" className="h-9 max-w-sm" aria-label="Search customers" />
            <div className="flex flex-wrap gap-2">
              {(Object.keys(tests) as Filter[]).map((f) => (
                <button key={f} type="button" onClick={() => { setFilter(f); setPage(0) }} className={cn("rounded-full border px-3 py-1 text-xs font-medium transition-colors", filter === f ? "border-primary bg-primary text-primary-foreground" : "hover:bg-muted", f === "fault" && filter !== f && "text-brand-red")}>
                  {LABEL[f]}<span className="ml-1.5 tabular-nums opacity-70">{rows.filter(tests[f]).length}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="divide-y">
            {visible.slice(cur * PAGE, cur * PAGE + PAGE).map((r) => {
              const on = r.vehicle_id === selected
              const hot = r.retention_risk > 0.55
              return (
                <button key={r.vehicle_id} type="button" onClick={() => void pick(r.vehicle_id)} className={cn("grid w-full grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-muted/50", on && "bg-accent/60")}>
                  <span className={cn("size-2 rounded-full", fault(r) ? "bg-brand-red" : hot ? "bg-warning" : "bg-primary/30")} />
                  <span className="min-w-0 space-y-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium">{r.customer_name}</span>
                      <Plate reg={regDisplay(r.reg_no)} size="sm" />
                      <span className="text-xs text-muted-foreground">{r.model}</span>
                    </span>
                    <span className="block"><AssistChip uc={1} className={cn(fault(r) && "border-brand-red/20 bg-brand-red/5")}>{headline(r)}</AssistChip></span>
                  </span>
                  <span className="text-right">
                    <span className={cn("block text-xs font-semibold tabular-nums", r.due_in_days < 0 ? "text-brand-red" : "text-foreground")}>{dueText(r.due_in_days)}</span>
                    <span className="mt-1 block text-[11px] text-muted-foreground">
                      {r.booked ? "Booked" : contacted.has(r.vehicle_id) ? "Reminder sent" : ""}
                    </span>
                  </span>
                </button>
              )
            })}
            {!visible.length && <p className="px-4 py-12 text-center text-sm text-muted-foreground">{list ? "No customers match." : "Loading follow-up list…"}</p>}
          </div>

          <div className="flex items-center justify-between border-t px-4 py-2.5 text-xs text-muted-foreground">
            <span className="tabular-nums">
              {visible.length ? `${cur * PAGE + 1}–${Math.min(visible.length, cur * PAGE + PAGE)} of ${visible.length}` : "0 customers"}
            </span>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" disabled={cur === 0} onClick={() => setPage(cur - 1)}>← Prev</Button>
              <span className="tabular-nums">{cur + 1} / {pages}</span>
              <Button size="sm" variant="ghost" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)}>Next →</Button>
            </div>
          </div>
        </section>

        <aside className="space-y-5 xl:sticky xl:top-4 xl:self-start">
          {!selected ? (
            <div className={cn(card, "p-8 text-center")}>
              <p className="text-sm font-semibold">Pick a customer</p>
              <p className="mx-auto mt-1 max-w-xs text-xs text-muted-foreground">You&apos;ll see why they are due, the best way to reach them and a ready-to-send message in their language.</p>
            </div>
          ) : (
            <div className={card}>
              <div className="flex items-start justify-between gap-3 border-b p-5">
                <div className="min-w-0 space-y-1.5">
                  <p className="text-base font-semibold">{row?.customer_name ?? nba?.customer_name ?? "…"}</p>
                  {row && (
                    <div className="flex flex-wrap items-center gap-2">
                      <Plate reg={regDisplay(row.reg_no)} />
                      <span className="text-xs text-muted-foreground">{row.model}</span>
                      <span className={cn("text-xs font-semibold", row.due_in_days < 0 ? "text-brand-red" : "")}>{dueText(row.due_in_days)}</span>
                    </div>
                  )}
                </div>
                <FollowButton vehicleId={selected} />
              </div>

              {row && (
                <div className="space-y-2.5 border-b p-5">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Why now</p>
                    <AssistChip uc={1}>{row.due_in_days < 0 ? "Service overdue" : "Service due soon"}</AssistChip>
                  </div>
                  <ul className="space-y-1.5">
                    {whyDue(row).map((w) => (
                      <li key={w.text} className={cn("flex items-center gap-2 text-sm", w.tone === "bad" && "font-medium text-brand-red")}>
                        <span className={cn("size-1.5 rounded-full", w.tone === "bad" ? "bg-brand-red" : "bg-primary/40")} />{w.text}
                      </li>
                    ))}
                  </ul>
                  <details className="group text-xs text-muted-foreground">
                    <summary className="cursor-pointer list-none hover:text-foreground"><span className="group-open:hidden">Why?</span><span className="hidden group-open:inline">Hide</span></summary>
                    <div className="mt-1.5 space-y-0.5">
                      {row.reasons.map((x) => <p key={x}>· {x}</p>)}
                      <p>· Likelihood of coming in: {Math.round(row.due_probability * 100)}% · risk of losing customer: {Math.round(row.retention_risk * 100)}%</p>
                    </div>
                  </details>
                </div>
              )}

              <div className="space-y-4 p-5">
                {!nba || nba.vehicle_id !== selected ? (
                  <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-10 animate-pulse rounded-xl bg-muted" />)}</div>
                ) : row?.booked ? (
                  <div className="space-y-3">
                    <p className="rounded-xl bg-success/10 p-4 text-sm text-success">Already booked — no reminder needed.</p>
                    <Link href={`/appointments?v=${selected}`} className={cn(buttonVariants({ variant: "outline" }), "w-full")}>See booking →</Link>
                  </div>
                ) : (
                  <>
                    <div className="space-y-2">
                      <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Recommended follow-up</p>
                      <AssistChip uc={2}>{CHANNEL[nba.channel] ?? nba.channel} · {dayTime(nba.send_at)} · in {LANG[nba.language] ?? nba.language}</AssistChip>
                      <div className="grid grid-cols-2 gap-2 text-sm">
                        <div className="rounded-xl bg-muted/60 p-3"><p className="text-[11px] text-muted-foreground">Purpose</p><p className="font-medium">{ACTION[nba.action] ?? nba.action.replaceAll("_", " ")}</p></div>
                        <div className="rounded-xl bg-muted/60 p-3"><p className="text-[11px] text-muted-foreground">Offer</p><p className="font-medium">{nba.offer ?? "None needed"}</p></div>
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <label htmlFor="msg" className="text-xs font-semibold text-muted-foreground">Message ({LANG[nba.language] ?? nba.language})</label>
                        <button type="button" onClick={() => void pick(nba.vehicle_id, true)} disabled={busy !== null} className="text-xs font-medium text-primary hover:underline disabled:opacity-50">
                          {busy === "llm" ? "Rewording…" : "Reword"}
                        </button>
                      </div>
                      <Textarea id="msg" rows={4} value={message} onChange={(e) => setMessage(e.target.value)} />
                    </div>
                    {sent === selected ? (
                      <div className="space-y-3">
                        <p className="rounded-xl bg-success/10 p-3 text-sm text-success">Reminder queued — {CHANNEL[nba.channel]?.toLowerCase() ?? nba.channel} at {dayTime(nba.send_at)}.</p>
                        <Link href={`/appointments?book=${selected}`} className={cn(buttonVariants(), "h-11 w-full")}>Continue: Book service →</Link>
                      </div>
                    ) : (
                      <div className="grid grid-cols-2 gap-2">
                        <Button variant="outline" className="h-11" onClick={send} disabled={busy !== null || !message.trim()}>
                          {busy === "send" ? "Sending…" : "Send reminder"}
                        </Button>
                        <Link href={`/appointments?book=${selected}`} onClick={() => setFocus(selected)} className={cn(buttonVariants(), "h-11")}>Book service →</Link>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          <details className={cn(card, "group p-5")}>
            <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-semibold">
              Sent today <span className="text-xs font-normal text-muted-foreground tabular-nums">{outbox.length} messages ▾</span>
            </summary>
            <div className="mt-3 max-h-72 divide-y overflow-y-auto">
              {outbox.slice(0, 30).map((o) => (
                <div key={o.id} className="flex items-center justify-between gap-3 py-2">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{o.customer_name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{o.message}</span>
                  </span>
                  <span className="shrink-0 text-right text-[11px] text-muted-foreground">{CHANNEL[o.channel] ?? o.channel}<br />{dayTime(o.created_at)}</span>
                </div>
              ))}
              {!outbox.length && <p className="py-4 text-center text-xs text-muted-foreground">Nothing sent yet.</p>}
            </div>
          </details>
        </aside>
      </div>
    </div>
  )
}
