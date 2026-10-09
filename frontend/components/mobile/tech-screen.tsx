"use client"

import * as React from "react"
import Link from "next/link"

import { erp, STAGE_LABEL, type BoardCard, type Stage } from "@/lib/erp-api"
import { Button } from "@/components/ui/button"
import { useJourney } from "@/components/erp/journey"
import { cn } from "@/lib/utils"
import {
  Empty,
  errMsg,
  ErrorNote,
  fmtTime,
  Loading,
  MCard,
  Pill,
  SectionTitle,
  useLoad,
} from "@/components/mobile/shared"

const ACTION: Partial<Record<Stage, string>> = {
  approved: "Start job",
  in_progress: "Mark for QC",
  qc: "QC passed",
}
const STAGES: Stage[] = ["in_progress", "qc", "approved"]

export function TechScreen() {
  const { focusId } = useJourney()
  const board = useLoad(() => erp.board(), [], 5000)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [flash, setFlash] = React.useState<string | null>(null)
  const [stageFilter, setStageFilter] = React.useState<Stage>("in_progress")

  async function advance(c: BoardCard) {
    if (!c.job_card_id) return
    setBusy(c.key)
    setError(null)
    try {
      const wo = await erp.advance(c.job_card_id)
      setFlash(
        `${c.reg_display || c.reg_no} → ${wo.wip ? STAGE_LABEL[wo.wip.stage] : "updated"}`
      )
      board.reload()
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(null)
    }
  }

  async function nextBay(c: BoardCard) {
    if (!c.job_card_id) return
    setBusy(c.key)
    setError(null)
    try {
      const wo = await erp.moveBay(c.job_card_id)
      const bay = (wo as { job_card?: { allocation?: { bay?: { name?: string } } } }).job_card?.allocation?.bay?.name
      setFlash(`${c.reg_display || c.reg_no} → ${bay ?? "next bay"}`)
      board.reload()
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h1 className="text-xl font-semibold">Workshop jobs</h1>
        <p className="text-sm text-muted-foreground">
          Work through your bay queue.
        </p>
      </div>
      <ErrorNote onRetry={board.reload}>{error ?? board.error}</ErrorNote>
      <div className="grid grid-cols-3 gap-2" aria-label="Filter workshop jobs">
        {STAGES.map((stage) => (
          <button
            key={stage}
            type="button"
            aria-pressed={stageFilter === stage}
            onClick={() => setStageFilter(stage)}
            className={cn(
              "min-h-16 rounded-xl border bg-card px-2 py-2 text-sm",
              stageFilter === stage &&
                "border-primary bg-primary text-primary-foreground"
            )}
          >
            <span className="block text-lg font-semibold">
              {board.data?.stages.find((s) => s.key === stage)?.cards.length ??
                "—"}
            </span>
            <span className="block text-xs">
              {stage === "approved"
                ? "Up next"
                : stage === "qc"
                  ? "Quality check"
                  : "In progress"}
            </span>
          </button>
        ))}
      </div>
      {flash && (
        <Pill tone="ok" className="self-start px-3 py-1 text-sm">
          {flash}
        </Pill>
      )}
      {board.loading && <Loading />}
      {board.data &&
        [stageFilter].map((key) => {
          const stage = board.data!.stages.find((s) => s.key === key)
          const cards = [...(stage?.cards ?? [])].sort(
            (a, b) =>
              Number(b.vehicle_id === focusId) -
              Number(a.vehicle_id === focusId)
          )
          return (
            <section key={key} className="flex flex-col gap-2">
              <SectionTitle>
                {key === "approved" ? "Up next" : STAGE_LABEL[key]} (
                {cards.length})
              </SectionTitle>
              {!cards.length && (
                <Empty>
                  {key === "approved"
                    ? "No approved jobs waiting to start."
                    : key === "qc"
                      ? "No jobs waiting for quality checks."
                      : "No jobs in progress. Check Up next to start a job."}
                </Empty>
              )}
              {cards.map((c) => (
                <MCard
                  key={c.key}
                  className={cn(
                    "flex flex-col gap-2",
                    c.vehicle_id === focusId &&
                      "border-primary ring-1 ring-primary/20"
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <Link
                      href={`/m/vehicle/${c.vehicle_id}`}
                      className="min-w-0"
                    >
                      <div className="font-semibold">
                        {c.reg_display || c.reg_no}
                      </div>
                      <div className="truncate text-sm text-muted-foreground">
                        {c.model}
                      </div>
                    </Link>
                    {c.job_card_id && <Pill>JC #{c.job_card_id}</Pill>}
                  </div>
                  {c.detail && <div className="text-sm">{c.detail}</div>}
                  <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                    {c.technician && <span>Tech: {c.technician}</span>}
                    {c.bay && <span>Bay: {c.bay}</span>}
                    {c.promised && <span>Promised {fmtTime(c.promised)}</span>}
                  </div>
                  {ACTION[key] && c.job_card_id && (
                    <Button
                      className="h-12 text-base"
                      disabled={busy !== null}
                      onClick={() => advance(c)}
                    >
                      {busy === c.key ? "Updating…" : ACTION[key]}
                    </Button>
                  )}
                  {key === "in_progress" && c.job_card_id && (
                    <Button
                      variant="outline"
                      className="h-12 text-base"
                      disabled={busy !== null}
                      onClick={() => nextBay(c)}
                    >
                      Pull to next bay
                    </Button>
                  )}
                </MCard>
              ))}
            </section>
          )
        })}
    </div>
  )
}
