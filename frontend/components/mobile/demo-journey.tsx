"use client"

// Entry point for the end-to-end demo. The walkthrough itself (opening each role's
// screen and pressing its buttons) is the DemoTour overlay in the root layout.

import { erp } from "@/lib/erp-api"
import { Button } from "@/components/ui/button"
import { startDemoTour } from "@/components/demo-tour"
import { ErrorNote, Loading, MCard, useLoad } from "@/components/mobile/shared"

const ROLE: Record<string, string> = {
  customer: "🙋 Customer",
  driver: "🚗 Chauffeur",
  gate: "🛡️ Security",
  advisor: "🧑‍💼 Service advisor",
  technician: "🔧 Technician",
  cashier: "💳 Cashier",
}

export function DemoJourney() {
  const steps = useLoad(() => erp.demoSteps(), [])
  if (steps.loading && !steps.data) return <Loading />

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h1 className="text-xl font-semibold">Full journey demo</h1>
        <p className="text-sm text-muted-foreground">
          One car, start to finish, on the real screens: the customer books, a chauffeur is assigned and collects
          the car, the gate checks it in, the advisor opens the job card, the technician works through the bays,
          the cashier bills it and the car leaves.
        </p>
      </div>

      <Button className="h-12 text-base" onClick={startDemoTour} disabled={!steps.data}>
        ▶ Start demo
      </Button>
      <ErrorNote onRetry={steps.reload}>{steps.error}</ErrorNote>

      <MCard className="p-3">
        <div className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">What you&apos;ll see</div>
        <ol className="flex flex-col gap-2">
          {(steps.data ?? []).map((s, i) => (
            <li key={s.key} className="flex items-start gap-3">
              <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{s.title}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{ROLE[s.role]}</span>
                </div>
                <div className="text-xs text-muted-foreground">{s.hint}</div>
              </div>
            </li>
          ))}
        </ol>
      </MCard>
    </div>
  )
}
