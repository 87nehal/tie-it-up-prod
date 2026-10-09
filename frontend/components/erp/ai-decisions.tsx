"use client"

import * as React from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"

import { ai, type AiDecision, type Candidate, type ModelCard, type ServiceDueRow } from "@/lib/erp-api"
import { dayTime, pct } from "@/lib/format"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { PageHeader, Panel, usePoll } from "@/components/erp/kit"

type Tab = "advisor" | "chauffeur" | "diagnosis" | "inspection" | "due" | "models"

const TABS: { key: Tab; label: string; hint: string }[] = [
  { key: "advisor", label: "Advisor matches", hint: "Why this advisor was assigned to the customer" },
  { key: "chauffeur", label: "Chauffeur matches", hint: "Why this chauffeur was dispatched for the pickup" },
  { key: "diagnosis", label: "Issue diagnosis", hint: "Why the customer is likely facing the issue they described" },
  { key: "inspection", label: "Inspections", hint: "Arrival photo findings written up for the advisor" },
  { key: "due", label: "Service due", hint: "Which cars are due and why" },
  { key: "models", label: "Models", hint: "How the matching models were trained" },
]

function EngineBadge({ d }: { d: AiDecision }) {
  if (d.status === "pending") return <Badge variant="outline">Writing rationale…</Badge>
  const llm = d.engine.includes("laya") ? "Laya (local)" : d.engine.includes("ollama") ? "Cloud LLM" : null
  return (
    <span className="flex gap-1">
      {d.engine.startsWith("model") && <Badge variant="secondary">Matching model</Badge>}
      {d.engine.startsWith("rules") && <Badge variant="secondary">Rules + vehicle data</Badge>}
      {llm && <Badge variant="outline">{llm}</Badge>}
    </span>
  )
}

function Candidates({ list, chosen }: { list: Candidate[]; chosen: number | null }) {
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs text-muted-foreground">
        <tr>
          <th className="py-1.5 pr-3 font-medium">Candidate</th>
          <th className="py-1.5 pr-3 text-right font-medium">P(good outcome)</th>
          <th className="py-1.5 pr-3 font-medium">Facts</th>
          <th className="py-1.5 pr-3 font-medium">Helped</th>
          <th className="py-1.5 font-medium">Hurt / blocked</th>
        </tr>
      </thead>
      <tbody>
        {list.map((c) => (
          <tr key={c.id} className={cn("border-t align-top", c.id === chosen && "bg-emerald-50 dark:bg-emerald-950/30")}>
            <td className="py-1.5 pr-3 font-medium whitespace-nowrap">
              {c.name}
              {c.id === chosen && <span className="ml-1 text-xs text-emerald-700">✓ chosen</span>}
            </td>
            <td className="py-1.5 pr-3 text-right tabular-nums">
              {c.eligible ? (
                <span className="inline-flex items-center gap-2">
                  <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                    <span className="block h-full bg-primary" style={{ width: `${c.p_good * 100}%` }} />
                  </span>
                  {pct(c.p_good)}
                </span>
              ) : (
                "—"
              )}
            </td>
            <td className="py-1.5 pr-3 text-xs text-muted-foreground">{c.facts.join(" · ")}</td>
            <td className="py-1.5 pr-3 text-xs text-emerald-700 dark:text-emerald-400">{c.for.join(", ") || "—"}</td>
            <td className="py-1.5 text-xs text-destructive">
              {[...c.blockers, ...c.against].join(", ") || "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function DecisionCard({ d, open: initial }: { d: AiDecision; open?: boolean }) {
  const [open, setOpen] = React.useState(Boolean(initial))
  const findings = d.evidence.llm_findings ?? d.evidence.findings
  return (
    <div id={`d${d.id}`} className={cn("rounded-xl border bg-card", initial && "ring-2 ring-primary/40")}>
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <p className="font-medium">{d.summary}</p>
          <p className="text-xs text-muted-foreground">
            <Link href={`/vehicles/${d.vehicle_id}`} className="font-mono hover:underline">
              {d.reg_display}
            </Link>{" "}
            · {d.model} · {d.customer_name} · {dayTime(d.created_at)}
            {d.appointment_id && ` · appointment #${d.appointment_id}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {d.confidence != null && (
            <span className="text-xs text-muted-foreground">
              predicted good outcome <b className="text-foreground">{pct(d.confidence)}</b>
            </span>
          )}
          <EngineBadge d={d} />
        </div>
      </div>
      <div className="grid gap-4 border-t px-4 py-3 lg:grid-cols-2">
        <div>
          <p className="mb-1 text-xs font-semibold text-muted-foreground uppercase">Why</p>
          {d.kind === "diagnosis" && findings?.length ? (
            <ul className="space-y-2 text-sm">
              {findings.map((f, i) => (
                <li key={i}>
                  <p className="font-medium">
                    {f.complaint}: possible cause — {f.likely_cause}
                  </p>
                  <p className="text-xs text-muted-foreground">Evidence: {f.why}</p>
                  <p className="text-xs">Check first: {f.check_first}</p>
                </li>
              ))}
            </ul>
          ) : (
            <ul className="list-disc space-y-0.5 pl-4 text-sm">
              {d.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <p className="mb-1 text-xs font-semibold text-muted-foreground uppercase">Rationale</p>
          {d.narrative ? (
            <p className="text-sm">{d.narrative}</p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {d.status === "pending"
                ? "Laya is writing the rationale…"
                : d.kind === "diagnosis"
                  ? "Findings above combine the customer's words with this car's mileage, OBD data and service history."
                  : "No written rationale (language model was off); the reasons on the left come from the matching model."}
            </p>
          )}
        </div>
      </div>
      {d.alternatives.length > 0 && (
        <div className="border-t px-4 py-2">
          <Button variant="ghost" size="xs" onClick={() => setOpen(!open)}>
            {open ? "Hide" : "Show"} all {d.alternatives.length} candidates considered
          </Button>
          {open && (
            <div className="mt-2 overflow-x-auto">
              <Candidates list={d.alternatives} chosen={d.chosen_id} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function DueTable({ rows }: { rows: ServiceDueRow[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <table className="w-full text-sm">
        <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-4 py-2 font-medium">Vehicle</th>
            <th className="px-4 py-2 font-medium">Customer</th>
            <th className="px-4 py-2 font-medium">Due</th>
            <th className="px-4 py-2 font-medium">Priority</th>
            <th className="px-4 py-2 text-right font-medium">P(due)</th>
            <th className="px-4 py-2 text-right font-medium">Churn risk</th>
            <th className="px-4 py-2 font-medium">Why</th>
            <th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.vehicle_id} className="border-t align-top">
              <td className="px-4 py-2">
                <Link href={`/vehicles/${r.vehicle_id}`} className="font-mono font-medium hover:underline">
                  {r.reg_no}
                </Link>
                <span className="block text-xs text-muted-foreground">{r.model}</span>
              </td>
              <td className="px-4 py-2">{r.customer_name}</td>
              <td className="px-4 py-2 whitespace-nowrap">
                {r.due_in_days < 0 ? `${-r.due_in_days} d overdue` : `in ${r.due_in_days} d`}
              </td>
              <td className="px-4 py-2">
                <Badge variant={r.priority === "High" ? "destructive" : r.priority === "Medium" ? "outline" : "secondary"}>
                  {r.priority}
                </Badge>
              </td>
              <td className="px-4 py-2 text-right tabular-nums">{pct(r.due_probability)}</td>
              <td className="px-4 py-2 text-right tabular-nums">{pct(r.retention_risk)}</td>
              <td className="px-4 py-2">
                <ul className="list-disc pl-4 text-xs">
                  {r.reasons.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </td>
              <td className="px-4 py-2 text-right">
                {r.booked ? (
                  <Badge variant="secondary">Booked</Badge>
                ) : (
                  <Link href={`/crm?vehicle=${r.vehicle_id}`} className="text-xs text-primary hover:underline">
                    Follow up
                  </Link>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Models({ cards }: { cards: ModelCard[] }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {cards.map((m) => (
        <Panel key={m.kind} title={`${m.kind[0].toUpperCase()}${m.kind.slice(1)} matching model`}>
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-muted-foreground">Algorithm</dt>
            <dd>{m.algorithm}</dd>
            <dt className="text-muted-foreground">Training data</dt>
            <dd>{m.trained_on}</dd>
            <dt className="text-muted-foreground">Holdout AUC</dt>
            <dd className="tabular-nums">{m.holdout_auc}</dd>
          </dl>
          <p className="mt-3 mb-1 text-xs font-semibold text-muted-foreground uppercase">Learned weights (log-odds)</p>
          <ul className="space-y-1">
            {Object.entries(m.weights).map(([k, w]) => (
              <li key={k} className="grid grid-cols-[1fr_8rem_3rem] items-center gap-2 text-sm">
                <span>{k}</span>
                <span className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <span className="block h-full bg-primary" style={{ width: `${Math.min(100, (Math.abs(w) / 3) * 100)}%` }} />
                </span>
                <span className="text-right tabular-nums">{w.toFixed(2)}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted-foreground">
            Hard rules (off duty, fully booked, shift end, trip limit) filter candidates before the model ranks them.
            POC history is synthetic; retrain on the dealer&apos;s logged assignments and CSAT / on-time outcomes.
          </p>
        </Panel>
      ))}
    </div>
  )
}

export function AiDecisions() {
  const params = useSearchParams()
  const focus = Number(params.get("decision")) || null
  const [picked, setTab] = React.useState<Tab | null>(null)
  const decisions = usePoll(() => ai.decisions(), 5000)
  const due = usePoll(() => ai.serviceDue(), 60_000)
  const [models, setModels] = React.useState<ModelCard[]>([])
  React.useEffect(() => {
    ai.models().then(setModels).catch(() => undefined)
  }, [])

  const focused = decisions.data?.find((d) => d.id === focus)
  const tab: Tab = picked ?? focused?.kind ?? ((params.get("tab") as Tab) || "advisor")
  const focusedId = focused?.id
  React.useEffect(() => {
    if (focusedId) document.getElementById(`d${focusedId}`)?.scrollIntoView({ block: "center" })
  }, [focusedId])

  const list = (decisions.data ?? []).filter((d) => d.kind === tab)
  const count = (k: Tab) =>
    k === "due" ? due.data?.length ?? 0 : k === "models" ? models.length : (decisions.data ?? []).filter((d) => d.kind === k).length

  return (
    <div>
      <PageHeader
        title="AI decisions"
        subtitle="Every automatic match and diagnosis the system made, with the evidence behind it"
      />
      <div className="mb-4 flex flex-wrap gap-1 border-b">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm",
              tab === t.key ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {t.label} <span className="ml-1 text-xs text-muted-foreground tabular-nums">{count(t.key)}</span>
          </button>
        ))}
      </div>
      <p className="mb-3 text-sm text-muted-foreground">{TABS.find((t) => t.key === tab)?.hint}</p>
      {tab === "due" ? (
        <DueTable rows={due.data ?? []} />
      ) : tab === "models" ? (
        <Models cards={models} />
      ) : (
        <div className="space-y-3">
          {list.map((d) => (
            <DecisionCard key={d.id} d={d} open={d.id === focus} />
          ))}
          {list.length === 0 && (
            <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
              No decisions yet. They appear when customers book in the app or vehicles arrive.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
