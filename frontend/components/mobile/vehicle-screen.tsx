"use client"

import * as React from "react"
import Link from "next/link"
import { useParams } from "next/navigation"
import { HugeiconsIcon } from "@hugeicons/react"
import { Call02Icon, Search01Icon } from "@hugeicons/core-free-icons"

import { erp, STAGE_LABEL, type SearchHit, type Stage } from "@/lib/erp-api"
import { Input } from "@/components/ui/input"
import {
  Empty,
  ErrorNote,
  fmtDate,
  inr,
  km,
  Loading,
  MCard,
  Pill,
  SectionTitle,
  useLoad,
} from "@/components/mobile/shared"

export function VehicleScreen() {
  const params = useParams<{ id: string }>()
  const id = Number(params.id)
  const v360 = useLoad(() => erp.vehicle(id), [id])

  if (v360.error)
    return <ErrorNote onRetry={v360.reload}>{v360.error}</ErrorNote>
  if (!v360.data) return <Loading />
  const {
    vehicle: v,
    open_job_card: open,
    history,
    timeline,
    appointments,
  } = v360.data

  return (
    <div className="flex flex-col gap-3">
      <MCard className="flex flex-col gap-1">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-xl font-semibold tracking-wide">
              {v.reg_display || v.reg_no}
            </div>
            <div className="text-sm text-muted-foreground">
              {v.model} · {v.fuel}
            </div>
          </div>
          {open && (
            <Pill tone="info">
              {STAGE_LABEL[open.stage as Stage] ?? open.stage}
            </Pill>
          )}
        </div>
        <div className="mt-2 text-sm font-medium">{v.customer_name}</div>
        <div className="text-xs text-muted-foreground">{v.locality}</div>
        {v.phone && (
          <a
            href={`tel:${v.phone}`}
            className="mt-1 flex items-center gap-1.5 text-sm font-medium text-primary"
          >
            <HugeiconsIcon icon={Call02Icon} className="size-4" /> {v.phone}
          </a>
        )}
      </MCard>

      <div className="grid grid-cols-1 gap-2 min-[380px]:grid-cols-3">
        <Stat label="Odometer" value={km(v.odometer)} />
        <Stat label="Last service" value={fmtDate(v.last_service_date)} />
        <Stat label="Lifetime" value={inr(v360.data.lifetime_value)} />
      </div>
      <MCard className="text-xs text-muted-foreground">
        VIN <span className="font-mono text-foreground">{v.vin}</span> · Sold{" "}
        {fmtDate(v.sale_date)}
      </MCard>

      {open && (
        <>
          <SectionTitle>Open job card</SectionTitle>
          <MCard className="flex flex-col gap-1 text-sm">
            <div className="flex justify-between">
              <span className="font-semibold">JC #{open.id}</span>
              <span className="font-semibold">{inr(open.amount)}</span>
            </div>
            {open.demands.length > 0 && (
              <div className="text-muted-foreground">
                {open.demands.join(", ")}
              </div>
            )}
            {open.promised && (
              <div className="text-xs">Promised {fmtDate(open.promised)}</div>
            )}
          </MCard>
        </>
      )}

      {appointments.length > 0 && (
        <>
          <SectionTitle>Appointments</SectionTitle>
          {appointments.slice(0, 3).map((a) => (
            <MCard key={a.id} className="flex justify-between p-3 text-sm">
              <span>
                {fmtDate(a.slot_start)} ·{" "}
                {a.mode === "pickup" ? "Pickup" : "Walk-in"}
              </span>
              <Pill>{a.status.replace(/_/g, " ")}</Pill>
            </MCard>
          ))}
        </>
      )}

      <SectionTitle>Service history</SectionTitle>
      {!history.length && <Empty>No previous visits.</Empty>}
      {history.slice(0, 6).map((h) => (
        <MCard key={h.id} className="flex justify-between p-3 text-sm">
          <div>
            <div className="font-medium capitalize">
              {h.kind.replace(/_/g, " ")}
            </div>
            <div className="text-xs text-muted-foreground">
              {fmtDate(h.date)} · {km(h.km)}
              {h.advisor_name ? ` · ${h.advisor_name}` : ""}
            </div>
          </div>
          <span className="font-medium">{inr(h.amount)}</span>
        </MCard>
      ))}

      {timeline.length > 0 && (
        <>
          <SectionTitle>Recent activity</SectionTitle>
          <MCard className="flex flex-col gap-2 text-sm">
            {timeline.slice(0, 8).map((t, i) => (
              <div key={i} className="flex gap-3">
                <span className="w-16 shrink-0 text-xs text-muted-foreground">
                  {fmtDate(t.at)}
                </span>
                <span>{t.text}</span>
              </div>
            ))}
          </MCard>
        </>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <MCard className="p-3">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="text-sm font-semibold">{value}</div>
    </MCard>
  )
}

export function SearchScreen() {
  const [q, setQ] = React.useState("")
  const [searchTerm, setSearchTerm] = React.useState("")
  const search = useLoad<SearchHit[]>(
    () =>
      searchTerm.length >= 2 ? erp.search(searchTerm) : Promise.resolve([]),
    [searchTerm]
  )

  React.useEffect(() => {
    const t = setTimeout(() => setSearchTerm(q.trim()), 250)
    return () => clearTimeout(t)
  }, [q])

  const shown =
    q.trim().length < 2 || q.trim() !== searchTerm ? null : search.data

  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-xl font-semibold">Vehicle lookup</h1>
      <div className="relative">
        <HugeiconsIcon
          icon={Search01Icon}
          className="absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          aria-label="Search vehicles"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Reg no, customer, phone or JC #"
          className="h-12 pl-10 text-base"
        />
      </div>
      {q.trim().length < 2 && (
        <Empty>
          Enter at least two characters of a registration, customer name, phone
          number or job card.
        </Empty>
      )}
      {q.trim().length >= 2 && (q.trim() !== searchTerm || search.loading) && (
        <Loading label="Searching vehicles…" />
      )}
      <ErrorNote onRetry={search.reload}>
        {q.trim() === searchTerm ? search.error : null}
      </ErrorNote>
      {shown && !shown.length && !search.error && (
        <Empty>
          No vehicles match “{q.trim()}”. Try the registration or customer name.
        </Empty>
      )}
      {shown?.map((h, i) => (
        <Link
          key={`${h.kind}-${h.vehicle_id}-${h.job_card_id ?? i}`}
          href={`/m/vehicle/${h.vehicle_id}`}
          className="flex min-h-14 flex-col justify-center rounded-2xl border bg-card px-4 py-2"
        >
          <span className="font-medium">{h.label}</span>
          {h.sub && (
            <span className="text-xs text-muted-foreground">{h.sub}</span>
          )}
        </Link>
      ))}
    </div>
  )
}
