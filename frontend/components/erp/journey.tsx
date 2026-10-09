"use client"

// The thread that makes the outlet screens one system: the seven journey steps, the
// vehicle the advisor is following across them, and the intelligent assists (DBP use
// cases 1-12) that have already worked on that vehicle. Matching and prediction stay
// behind the screens; only their outcome is shown, with the use-case number visible
// in presenter mode.

import * as React from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowRight01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  Presentation01Icon,
  SparklesIcon,
} from "@hugeicons/core-free-icons"

import {
  erp,
  type Assist,
  type GuideItem,
  type Journey,
  type JourneyCounts,
  type JourneyStep,
} from "@/lib/erp-api"
import { clock } from "@/lib/format"
import { cn } from "@/lib/utils"
import { FOCUS_KEY, followVehicle, subscribeFocus, subscribeDataChange } from "@/lib/demo-sync"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"

export const STEPS: { key: JourneyStep; n: number; label: string; short: string; href: string }[] = [
  { key: "follow_up", n: 1, label: "Service follow-up", short: "Follow-up", href: "/crm" },
  { key: "appointment", n: 2, label: "Appointments", short: "Appointment", href: "/appointments" },
  { key: "pickup", n: 3, label: "Pickup & drop", short: "Pickup", href: "/pickups" },
  { key: "arrival", n: 4, label: "Vehicle arrival", short: "Arrival", href: "/reception" },
  { key: "job_card", n: 5, label: "Job cards", short: "Job card", href: "/job-cards" },
  { key: "workshop", n: 6, label: "Workshop floor", short: "Workshop", href: "/workshop" },
  { key: "delivery", n: 7, label: "Billing & delivery", short: "Delivery", href: "/billing" },
]

/** What each step's badge counts, said the way a service manager would. */
export const COUNT_HINT: Record<JourneyStep, string> = {
  follow_up: "customers due in 30 days, not booked",
  appointment: "visits booked today",
  pickup: "scheduled and active pickups",
  arrival: "still to arrive today",
  job_card: "waiting on a job card or approval",
  workshop: "in bays or quality check",
  delivery: "ready to invoice and deliver",
}

export const USE_CASES: Record<number, { title: string; step: JourneyStep }> = {
  1: { title: "Service-due prediction", step: "follow_up" },
  2: { title: "Next-best-action outreach", step: "follow_up" },
  3: { title: "Capacity-aware slot recommendation", step: "appointment" },
  4: { title: "Chauffeur matching", step: "pickup" },
  5: { title: "Pickup & drop ETA monitoring", step: "pickup" },
  6: { title: "Gate-in OCR & validation", step: "arrival" },
  7: { title: "Condition capture", step: "arrival" },
  8: { title: "Advisor matching", step: "arrival" },
  9: { title: "Concern interpretation", step: "job_card" },
  10: { title: "Estimate automation", step: "job_card" },
  11: { title: "Draft job card & parts sourcing", step: "job_card" },
  12: { title: "Bay & technician allocation", step: "workshop" },
}

export function stepForPath(pathname: string): JourneyStep | null {
  return STEPS.find((s) => pathname === s.href || pathname.startsWith(`${s.href}/`))?.key ?? null
}

// ------------------------------------------------------------------ context

type JourneyCtx = {
  focusId: number | null
  focus: Journey | null
  setFocus: (id: number | null) => void
  refresh: () => void
  counts: JourneyCounts | null
  presenter: boolean
  setPresenter: (on: boolean) => void
  guideOpen: boolean
  setGuideOpen: (open: boolean) => void
}

const Ctx = React.createContext<JourneyCtx | null>(null)

export function useJourney() {
  const ctx = React.useContext(Ctx)
  if (!ctx) throw new Error("useJourney outside JourneyProvider")
  return ctx
}

/** Optional variant for components that may render outside the desktop shell (mobile app). */
export function useJourneyMaybe() {
  return React.useContext(Ctx)
}

const PRESENTER_KEY = "dms.presenter"

function UrlFocus({ onVehicle }: { onVehicle: (id: number) => void }) {
  // deep links (?v=, ?vehicle=, ?book=) put that vehicle in focus
  const params = useSearchParams()
  const id = Number(params.get("v") || params.get("vehicle") || params.get("book")) || null
  React.useEffect(() => {
    if (id) onVehicle(id)
  }, [id, onVehicle])
  return null
}

export function JourneyProvider({ children }: { children: React.ReactNode }) {
  const [focusId, setFocusId] = React.useState<number | null>(null)
  const [focus, setFocusData] = React.useState<Journey | null>(null)
  const [counts, setCounts] = React.useState<JourneyCounts | null>(null)
  const [presenter, setPresenterState] = React.useState(false)
  const [guideOpen, setGuideOpen] = React.useState(false)
  const [tick, setTick] = React.useState(0)

  React.useEffect(() => {
    const t = window.setTimeout(() => {
      const saved = Number(window.localStorage.getItem(FOCUS_KEY)) || null
      setFocusId((cur) => cur ?? saved)
      setPresenterState(window.localStorage.getItem(PRESENTER_KEY) === "1")
    }, 0)
    return () => window.clearTimeout(t)
  }, [])

  const setFocus = React.useCallback((id: number | null) => {
    setFocusId(id)
    followVehicle(id)
    if (!id) setFocusData(null)
  }, [])

  const setPresenter = React.useCallback((on: boolean) => {
    setPresenterState(on)
    window.localStorage.setItem(PRESENTER_KEY, on ? "1" : "0")
    if (on) setGuideOpen(true)
  }, [])

  const refresh = React.useCallback(() => setTick((n) => n + 1), [])

  React.useEffect(() => subscribeFocus(() => {
    const id = Number(localStorage.getItem(FOCUS_KEY)) || null
    setFocusId(id)
    if (!id) setFocusData(null)
  }), [])
  React.useEffect(() => subscribeDataChange(refresh), [refresh])

  React.useEffect(() => {
    let live = true
    const load = () => erp.journeyCounts().then((c) => live && setCounts(c)).catch(() => undefined)
    void load()
    const t = window.setInterval(load, 20_000)
    return () => {
      live = false
      window.clearInterval(t)
    }
  }, [tick])

  React.useEffect(() => {
    if (!focusId) return
    let live = true
    const load = () =>
      erp
        .journey(focusId)
        .then((j) => live && setFocusData(j))
        .catch(() => {
          if (live) setFocus(null)
        })
    void load()
    const t = window.setInterval(load, 10_000)
    return () => {
      live = false
      window.clearInterval(t)
    }
  }, [focusId, tick, setFocus])

  const value = React.useMemo(
    () => ({ focusId, focus: focus && focus.vehicle.id === focusId ? focus : null, setFocus, refresh, counts,
             presenter, setPresenter, guideOpen, setGuideOpen }),
    [focusId, focus, setFocus, refresh, counts, presenter, setPresenter, guideOpen]
  )
  return (
    <Ctx.Provider value={value}>
      <React.Suspense fallback={null}>
        <UrlFocus onVehicle={setFocus} />
      </React.Suspense>
      {children}
      <PresenterGuide />
    </Ctx.Provider>
  )
}

// ------------------------------------------------------------------ pieces

/** Indian registration plate. */
export function Plate({ reg, size = "md", className }: { reg: string; size?: "sm" | "md" | "lg"; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-stretch overflow-hidden rounded-[5px] border-[1.5px] border-neutral-900 bg-white font-mono font-bold whitespace-nowrap text-neutral-900 shadow-[0_1px_0_rgba(0,0,0,.08)] dark:border-neutral-300",
        size === "sm" && "text-[11px]",
        size === "md" && "text-[13px]",
        size === "lg" && "text-lg",
        className
      )}
    >
      <span
        className={cn(
          "flex flex-col items-center justify-center bg-[#1d3fb0] font-sans font-bold text-white",
          size === "lg" ? "px-1.5 text-[8px]" : "px-1 text-[6px]"
        )}
        aria-hidden
      >
        IND
      </span>
      <span className={cn("tracking-wide", size === "lg" ? "px-2.5 py-0.5" : "px-1.5 py-px")}>{reg}</span>
    </span>
  )
}

/**
 * Outcome of an intelligent assist, inline where the staff need it. The model is not the
 * point; the decision is. In presenter mode the chip also shows which use case it is.
 */
export function AssistChip({
  uc,
  children,
  className,
  title,
}: {
  uc?: number
  children: React.ReactNode
  className?: string
  title?: string
}) {
  const ctx = useJourneyMaybe()
  return (
    <span
      title={title ?? (uc ? `${USE_CASES[uc]?.title} (use case ${uc})` : undefined)}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full border bg-card px-2 py-0.5 text-[11px] font-medium text-foreground shadow-[0_1px_1px_rgba(0,0,0,.03)]",
        className
      )}
    >
      <HugeiconsIcon icon={SparklesIcon} strokeWidth={2} className="size-3 shrink-0 text-muted-foreground" />
      {ctx?.presenter && uc ? (
        <span className="rounded-full bg-primary px-1.5 text-[10px] leading-4 font-semibold text-primary-foreground">
          UC{uc}
        </span>
      ) : null}
      <span className="truncate">{children}</span>
    </span>
  )
}

/** The seven steps, with live work counts; the page you're on and the followed vehicle are marked. */
export function JourneyBar() {
  const pathname = usePathname()
  const { counts, focus } = useJourney()
  const here = stepForPath(pathname)
  const focusN = focus?.step_n ?? 0
  return (
    <nav aria-label="Service journey" className="mb-4 overflow-x-auto">
      <ol className="tray flex min-w-max items-stretch gap-0.5 p-1">
        {STEPS.map((s, i) => {
          const active = here === s.key
          const done = focus ? s.n < focusN : false
          const at = focus ? s.n === focusN : false
          return (
            <li key={s.key} className="flex items-center">
              <Link
                href={s.href}
                aria-current={active ? "page" : undefined}
                title={counts ? `${counts[s.key]} ${COUNT_HINT[s.key]}` : s.label}
                className={cn(
                  "group flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[13px] transition-colors",
                  active
                    ? "border-border bg-card font-medium text-foreground shadow-[0_1px_2px_rgba(0,0,0,.06)]"
                    : "border-transparent text-muted-foreground hover:bg-card/70 hover:text-foreground"
                )}
              >
                <span
                  className={cn(
                    "num flex size-[18px] shrink-0 items-center justify-center rounded-[5px] text-[10px]",
                    active
                      ? "bg-foreground text-background"
                      : done
                        ? "bg-success/15 text-success"
                        : at
                          ? "bg-brand-red text-white"
                          : "border bg-card text-muted-foreground"
                  )}
                >
                  {done ? <HugeiconsIcon icon={CheckmarkCircle02Icon} strokeWidth={2.4} className="size-3" /> : s.n}
                </span>
                <span>{s.short}</span>
                {counts && (
                  <span
                    className={cn(
                      "num text-[11px]",
                      active ? "text-foreground" : "text-muted-foreground/80"
                    )}
                  >
                    {counts[s.key]}
                  </span>
                )}
                {at && !active && <span className="size-1.5 rounded-full bg-brand-red" aria-label="followed vehicle is here" />}
              </Link>
              {i < STEPS.length - 1 && (
                <span className="mx-0.5 h-3 w-px shrink-0 bg-border" aria-hidden />
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

/** The vehicle being followed through the journey: where it is and the next thing to do. */
export function FocusStrip() {
  const { focus, setFocus, presenter } = useJourney()
  const pathname = usePathname()
  const [open, setOpen] = React.useState(false)
  if (!focus) return null
  const v = focus.vehicle
  const nextHere = focus.next && pathname === focus.next.href.split("?")[0]
  return (
    <section className="tray mb-4">
      <div className="tray-inner overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <span className="caption flex items-center gap-1.5"><span className="live-dot size-1.5 rounded-full bg-brand-red" />Following</span>
        <Link href={`/vehicles/${v.id}`} className="flex items-center gap-2 hover:opacity-80">
          <Plate reg={v.reg_display} />
          <span className="text-sm font-semibold">{v.model}</span>
          <span className="text-sm text-muted-foreground">· {v.customer_name}</span>
        </Link>
        <span className="flex items-center gap-2 text-sm">
          <span className="flex size-5 items-center justify-center rounded-full bg-brand-red text-[10px] font-bold text-white">
            {focus.step_n}
          </span>
          <span className="font-medium">{focus.status}</span>
          {focus.promised && <span className="text-muted-foreground">· promised {clock(focus.promised)}</span>}
        </span>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          <HugeiconsIcon icon={SparklesIcon} strokeWidth={2} className="size-3.5" />
          {focus.assists.length} assists on this visit
        </button>
        <div className="ml-auto flex items-center gap-2">
          {focus.next && !nextHere && (
            <Link
              href={focus.next.href}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-foreground shadow-sm hover:bg-primary/90"
            >
              Next: {focus.next.label}
              <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} className="size-3.5" />
            </Link>
          )}
          {focus.next && nextHere && (
            <span className="rounded-lg bg-success/10 px-2.5 py-1 text-xs font-medium text-success">
              Next step is on this screen: {focus.next.label}
            </span>
          )}
          <Button variant="ghost" size="icon-sm" onClick={() => setFocus(null)} title="Stop following">
            <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
            <span className="sr-only">Stop following</span>
          </Button>
        </div>
      </div>
      {open && (
        <div className="grid gap-2 border-t bg-muted/40 px-4 py-3 sm:grid-cols-2 xl:grid-cols-3">
          {focus.assists.map((a) => (
            <AssistRow key={a.uc} a={a} presenter={presenter} />
          ))}
        </div>
      )}
      </div>
    </section>
  )
}

function AssistRow({ a, presenter }: { a: Assist; presenter: boolean }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border bg-card px-3 py-2">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border bg-muted text-[10px] font-bold text-foreground">
        {presenter ? a.uc : <HugeiconsIcon icon={SparklesIcon} strokeWidth={2} className="size-3.5" />}
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-semibold">{a.title}</span>
        <span className="block text-xs text-muted-foreground">{a.outcome}</span>
        {a.review && <span className="mt-0.5 block text-[11px] font-medium text-warning">Advisor review needed</span>}
      </span>
    </div>
  )
}

/** "Follow" button for any vehicle row: puts it in focus so its journey follows across screens. */
export function FollowButton({ vehicleId, className }: { vehicleId: number; className?: string }) {
  const { focusId, setFocus } = useJourney()
  const on = focusId === vehicleId
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setFocus(on ? null : vehicleId)
      }}
      className={cn(
        "rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors",
        on ? "border-foreground bg-foreground text-background" : "border-transparent text-muted-foreground hover:border-border hover:bg-card hover:text-foreground",
        className
      )}
    >
      {on ? "Following" : "Follow"}
    </button>
  )
}

// ------------------------------------------------------------------ presenter guide

function PresenterGuide() {
  const { guideOpen, setGuideOpen, setFocus, presenter, setPresenter } = useJourney()
  const router = useRouter()
  const [items, setItems] = React.useState<GuideItem[] | null>(null)
  React.useEffect(() => {
    if (!guideOpen) return
    erp.demoGuide().then(setItems).catch(() => setItems([]))
  }, [guideOpen])
  return (
    <Sheet open={guideOpen} onOpenChange={setGuideOpen}>
      <SheetContent side="right" className="w-full p-0 sm:max-w-md">
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle className="flex items-center gap-2">
            <HugeiconsIcon icon={Presentation01Icon} strokeWidth={2} className="size-4 text-primary" />
            Demo guide · 12 use cases
          </SheetTitle>
          <p className="text-xs text-muted-foreground">
            Each use case opens on a live vehicle in today&apos;s outlet. The vehicle is followed, so its journey
            carries on across the screens.
          </p>
          <label className="mt-2 flex items-center gap-2 text-xs font-medium">
            <input type="checkbox" checked={presenter} onChange={(e) => setPresenter(e.target.checked)} />
            Show use-case numbers on screen
          </label>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto px-3 py-3">
          {STEPS.map((s) => {
            const rows = (items ?? []).filter((i) => i.step === s.key)
            if (!rows.length) return null
            return (
              <div key={s.key} className="mb-3">
                <p className="mb-1.5 flex items-center gap-2 px-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                  <span className="flex size-4 items-center justify-center rounded-full bg-muted text-[9px]">{s.n}</span>
                  {s.label}
                </p>
                {rows.map((r) => (
                  <button
                    key={`${r.uc}-${r.title}`}
                    type="button"
                    onClick={() => {
                      if (r.vehicle_id) setFocus(r.vehicle_id)
                      setGuideOpen(false)
                      router.push(r.href)
                    }}
                    className="group mb-1 flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left hover:bg-muted"
                  >
                    <span
                      className={cn(
                        "num mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border text-[11px]",
                        r.uc ? "bg-card text-foreground" : "bg-success/10 text-success"
                      )}
                    >
                      {r.uc ?? "✓"}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{r.title}</span>
                      <span className="block text-xs text-muted-foreground">{r.what}</span>
                      {r.reg_display && <Plate reg={r.reg_display} size="sm" className="mt-1" />}
                    </span>
                    <HugeiconsIcon
                      icon={ArrowRight01Icon}
                      strokeWidth={2}
                      className="mt-1 size-4 shrink-0 text-muted-foreground group-hover:text-foreground"
                    />
                  </button>
                ))}
              </div>
            )
          })}
          {items === null && <p className="p-4 text-sm text-muted-foreground">Loading…</p>}
        </div>
      </SheetContent>
    </Sheet>
  )
}
