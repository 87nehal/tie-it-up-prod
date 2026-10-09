"use client"

import * as React from "react"
import Link from "next/link"
import { useSearchParams } from "next/navigation"

import { getDamageSamples } from "@/lib/api"
import {
  inspections,
  type DamageInspection,
  type InspectionPhoto,
} from "@/lib/erp-api"
import { service, type VehicleOption, type Visit } from "@/lib/service-api"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  errMsg,
  ErrorNote,
  fileFromUrl,
  MCard,
  normPlate,
  PhotoTile,
  Pill,
  SectionTitle,
  StickyActions,
  useLoad,
} from "@/components/mobile/shared"

const ANGLES = [
  "Front",
  "Front-left",
  "Left side",
  "Rear-left",
  "Rear",
  "Rear-right",
  "Right side",
  "Front-right",
]

type Subject = {
  vehicleId: number
  visitId: number | null
  reg: string
  label: string
}

const TONE: Record<string, "ok" | "warn" | "bad" | "info"> = {
  no_damage_detected: "ok",
  damage_detected: "bad",
  manual_review_required: "warn",
  recapture_required: "warn",
}

function PhotoResult({ p }: { p: InspectionPhoto }) {
  const [annotated, setAnnotated] = React.useState(true)
  const src = annotated && p.annotated_url ? p.annotated_url : p.photo_url
  return (
    <MCard className="flex flex-col gap-2 p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">{p.angle}</span>
        {p.status === "done" ? (
          <Pill tone={TONE[p.decision ?? ""] ?? "info"}>{p.result}</Pill>
        ) : (
          <Pill tone="info">
            {p.status === "assessing" ? "Checking…" : "Queued"}
          </Pill>
        )}
      </div>
      <button
        type="button"
        onClick={() => setAnnotated(!annotated)}
        className="relative overflow-hidden rounded-xl bg-muted"
        disabled={!p.annotated_url}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={p.angle}
          className="aspect-[4/3] w-full object-cover"
        />
        {p.status !== "done" && (
          <span className="absolute inset-x-0 bottom-0 bg-black/60 py-2 text-center text-sm text-white">
            {p.status === "assessing"
              ? "Looking for dents and scratches…"
              : "Waiting"}
          </span>
        )}
        {p.annotated_url && (
          <span className="absolute top-2 right-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] text-white">
            {annotated
              ? "Damage marked · tap for original"
              : "Original · tap for marked"}
          </span>
        )}
      </button>
      {p.status === "done" && (
        <div className="flex flex-wrap gap-1.5 text-xs">
          {p.damage?.length
            ? p.damage.map((d, i) => (
                <span
                  key={i}
                  className="rounded-full bg-destructive/10 px-2 py-0.5 font-medium text-destructive capitalize"
                >
                  {d.type} · {d.size_pct}% of photo
                </span>
              ))
            : p.decision !== "damage_detected" && (
                <span className="text-muted-foreground">
                  {p.decision === "recapture_required"
                    ? "Photo too dark, blurred or too far — retake closer."
                    : p.decision === "manual_review_required"
                      ? "Not sure — inspect this area by hand."
                      : "No dents or scratches seen."}
                </span>
              )}
        </div>
      )}
    </MCard>
  )
}

export function InspectScreen() {
  const params = useSearchParams()
  const visits = useLoad(() => service.visits(), [])
  const [q, setQ] = React.useState("")
  const [hits, setHits] = React.useState<VehicleOption[]>([])
  const [subject, setSubject] = React.useState<Subject | null>(null)
  const [ignoreLinked, setIgnoreLinked] = React.useState(false)
  const [photos, setPhotos] = React.useState<(File | null)[]>(
    ANGLES.map(() => null)
  )
  const [extra, setExtra] = React.useState<File[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [result, setResult] = React.useState<DamageInspection | null>(null)

  // deep link from the arrival flow / visit list: /m/inspect?visit=12
  const visitParam = Number(params.get("visit")) || null
  const linked = visitParam
    ? (visits.data ?? []).find((v) => v.id === visitParam)
    : undefined
  const active: Subject | null =
    subject ??
    (linked && !ignoreLinked
      ? {
          vehicleId: linked.vehicle_id,
          visitId: linked.id,
          reg: linked.reg_no,
          label: `${linked.customer_name} · ${linked.model}`,
        }
      : null)

  React.useEffect(() => {
    if (q.trim().length < 2) return
    const t = setTimeout(
      () =>
        service
          .vehicles(q)
          .then(setHits)
          .catch(() => setHits([])),
      250
    )
    return () => clearTimeout(t)
  }, [q])

  const resultId = result?.id
  const running = result?.status === "running"
  const progress = useLoad(
    () => (resultId ? inspections.get(resultId) : Promise.resolve(null)),
    [resultId],
    running ? 3000 : 0
  )
  React.useEffect(() => {
    let alive = true
    if (progress.data?.id === resultId) {
      void Promise.resolve().then(() => {
        if (alive && progress.data) setResult(progress.data)
      })
    }
    return () => {
      alive = false
    }
  }, [progress.data, resultId])

  const taken = photos.filter(Boolean).length + extra.length

  async function useSamples() {
    try {
      const samples = await getDamageSamples()
      if (!samples.length) return
      const files = await Promise.all(
        ANGLES.slice(0, 4).map((a, i) =>
          fileFromUrl(samples[i % samples.length].url, `${a}.jpg`)
        )
      )
      setPhotos((cur) => cur.map((f, i) => f ?? files[i] ?? null))
    } catch (e) {
      setError(errMsg(e))
    }
  }

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      const list = [
        ...photos.flatMap((f, i) => (f ? [{ angle: ANGLES[i], file: f }] : [])),
        ...extra.map((f, i) => ({ angle: `Close-up ${i + 1}`, file: f })),
      ]
      setResult(
        await inspections.create(
          { vehicleId: active?.vehicleId, visitId: active?.visitId },
          list
        )
      )
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  if (result) {
    const note = result.note
    return (
      <div className="flex flex-col gap-4 pb-24">
        <div>
          <h1 className="text-xl font-semibold">Inspection #{result.id}</h1>
          <p className="text-sm text-muted-foreground">
            {result.reg_no
              ? `${result.reg_no} · ${result.model} · ${result.customer_name}`
              : "No vehicle linked"}
          </p>
        </div>
        <MCard
          className={cn(
            "flex flex-col gap-1",
            result.status === "done" ? "" : "border-sky-500/30 bg-sky-500/5"
          )}
        >
          <div className="flex items-center justify-between text-sm">
            <span className="font-semibold">{result.summary}</span>
            <span className="text-xs text-muted-foreground tabular-nums">
              {result.progress.done}/{result.progress.total} photos
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all"
              style={{
                width: `${(result.progress.done / Math.max(1, result.progress.total)) * 100}%`,
              }}
            />
          </div>
          {result.status === "running" && (
            <p className="text-xs text-muted-foreground">
              Each photo takes up to a couple of minutes on this workshop PC.
              You can leave this screen; results are saved
              {result.visit_id ? " to the visit" : ""}.
            </p>
          )}
        </MCard>

        <ErrorNote onRetry={progress.reload}>{progress.error}</ErrorNote>

        {note && (note.findings.length > 0 || note.customer_note) && (
          <MCard className="flex flex-col gap-2">
            <SectionTitle>Inspection note</SectionTitle>
            <p className="text-sm">{note.summary}</p>
            {note.findings.map((f, i) => (
              <div key={i} className="rounded-xl bg-muted/50 p-2 text-sm">
                <p className="font-medium">
                  {f.area}: {f.damage}
                </p>
                <p className="text-xs text-muted-foreground">{f.action}</p>
              </div>
            ))}
            {note.customer_note && (
              <p className="text-sm italic">“{note.customer_note}”</p>
            )}
          </MCard>
        )}

        {result.photos.map((p) => (
          <PhotoResult key={p.index} p={p} />
        ))}

        <StickyActions>
          {result.vehicle_id ? (
            <Link href={`/m/vehicle/${result.vehicle_id}`} className="flex-1">
              <Button variant="outline" className="h-12 w-full">
                Vehicle record
              </Button>
            </Link>
          ) : null}
          <Button
            className="h-12 flex-1"
            onClick={() => {
              setResult(null)
              setPhotos(ANGLES.map(() => null))
              setExtra([])
            }}
          >
            New inspection
          </Button>
        </StickyActions>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 pb-24">
      <div>
        <h1 className="text-xl font-semibold">Damage inspection</h1>
        <p className="text-sm text-muted-foreground">
          Photograph the car from each side; dents and scratches are marked.
        </p>
      </div>

      <section>
        <SectionTitle>Vehicle</SectionTitle>
        {active ? (
          <MCard className="flex items-center justify-between gap-3 p-3">
            <div>
              <div className="font-semibold">{active.reg}</div>
              <div className="text-xs text-muted-foreground">
                {active.label}
                {active.visitId ? ` · visit #${active.visitId}` : ""}
              </div>
            </div>
            <button
              type="button"
              className="min-h-11 px-2 text-sm font-medium text-primary"
              onClick={() => {
                setSubject(null)
                setIgnoreLinked(true)
              }}
            >
              Change
            </button>
          </MCard>
        ) : (
          <div className="flex flex-col gap-2">
            <ErrorNote onRetry={visits.reload}>{visits.error}</ErrorNote>
            {(visits.data ?? []).slice(0, 3).map((v: Visit) => (
              <button
                key={v.id}
                type="button"
                onClick={() =>
                  setSubject({
                    vehicleId: v.vehicle_id,
                    visitId: v.id,
                    reg: v.reg_no,
                    label: `${v.customer_name} · ${v.model}`,
                  })
                }
                className="flex min-h-14 items-center justify-between gap-3 rounded-2xl border bg-card p-3 text-left"
              >
                <div className="min-w-0">
                  <div className="font-semibold">{v.reg_no}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {v.customer_name} · {v.model}
                  </div>
                </div>
                <Pill tone="info">In workshop</Pill>
              </button>
            ))}
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Or search reg no / customer"
              className="h-11"
            />
            {q.trim().length >= 2 &&
              hits.slice(0, 5).map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => {
                    setSubject({
                      vehicleId: v.id,
                      visitId: null,
                      reg: v.reg_display,
                      label: `${v.customer_name} · ${v.model}`,
                    })
                    setQ("")
                  }}
                  className="flex min-h-12 items-center rounded-2xl border bg-card p-3 text-left text-sm"
                >
                  <span className="font-semibold">{v.reg_display}</span>
                  <span className="ml-2 truncate text-muted-foreground">
                    {v.customer_name} · {v.model}
                  </span>
                </button>
              ))}
            {q && normPlate(q).length >= 2 && hits.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No match — you can still inspect without linking a vehicle.
              </p>
            )}
          </div>
        )}
      </section>

      <section>
        <div className="flex items-center justify-between">
          <SectionTitle>Photos ({taken})</SectionTitle>
          <button
            type="button"
            className="text-sm font-medium text-primary"
            onClick={useSamples}
          >
            Use sample photos
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3 min-[400px]:grid-cols-3">
          {ANGLES.map((a, i) => (
            <PhotoTile
              key={a}
              label={a}
              file={photos[i]}
              onFile={(f) =>
                setPhotos((cur) => cur.map((x, j) => (j === i ? f : x)))
              }
            />
          ))}
          {extra.map((f, i) => (
            <PhotoTile
              key={`x${i}`}
              label={`Close-up ${i + 1}`}
              file={f}
              onFile={(nf) =>
                setExtra((cur) => cur.map((x, j) => (j === i ? nf : x)))
              }
            />
          ))}
          <PhotoTile
            label="+ Close-up of damage"
            file={null}
            onFile={(f) => setExtra((cur) => [...cur, f])}
          />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Stand 2–3 m away, whole panel in frame, good light. Add close-ups of
          anything the customer points out.
        </p>
      </section>

      <ErrorNote>{error}</ErrorNote>
      <StickyActions>
        <Button
          className="h-12 w-full text-base"
          disabled={!taken || busy}
          onClick={submit}
        >
          {busy
            ? "Uploading…"
            : taken
              ? `Check ${taken} photo${taken > 1 ? "s" : ""} for damage`
              : "Take at least one photo"}
        </Button>
      </StickyActions>
    </div>
  )
}
