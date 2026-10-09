"use client"

// Screen tour: drives one car through the real screens. For every step it opens the
// role's screen, moves a visible cursor to the real button and presses it. When a
// screen needs input a demo can't type (camera photos, the customer's OTP, a typed
// plate), it points at the button and runs that step on the backend instead; the
// screen then updates in place. Mounted once in the root layout so it survives navigation.

import * as React from "react"
import { usePathname, useRouter } from "next/navigation"

import { erp, type DemoCtx, type DemoStep } from "@/lib/erp-api"
import { followVehicle } from "@/lib/demo-sync"
import { cn } from "@/lib/utils"

type Spec = {
  url: (c: DemoCtx) => string
  button: RegExp
  /** false = the button needs input the tour can't provide; point at it only */
  click: boolean
  /** tab or toggle to press first */
  pre?: RegExp
  /** match the button inside this car's card */
  scoped?: boolean
}

const SPEC: Record<string, Spec> = {
  book: { url: () => "/m/book", button: /^(Confirm|Choose a time)/, click: false },
  dispatch: { url: (c) => `/m/driver?v=${c.vehicle_id}`, button: /^Start trip$/, click: true },
  arrive: { url: (c) => `/m/driver?v=${c.vehicle_id}`, button: /Simulate/, click: false },
  handover: { url: (c) => `/m/driver?v=${c.vehicle_id}`, button: /Confirm handover/, click: false },
  drive: { url: (c) => `/m/driver?v=${c.vehicle_id}`, button: /Simulate/, click: false },
  check_in: { url: () => "/m/gate", button: /Gate-in/, click: false },
  job_card: { url: (c) => `/job-cards?visit=${c.visit_id}`, button: /Draft job card/, click: true },
  approve: { url: () => "/m/my-car", button: /^Approve estimate$/, click: true },
  release: { url: (c) => `/job-cards?jc=${c.job_card_id}`, button: /^Release to workshop$/, click: true },
  bay: { url: () => "/m/tech", button: /^Pull to next bay$/, click: true, scoped: true },
  qc: { url: () => "/m/tech", button: /^Mark for QC$/, click: true, scoped: true },
  qc_pass: { url: () => "/m/tech", pre: /Quality check/, button: /^QC passed$/, click: true, scoped: true },
  deliver: { url: (c) => `/billing?v=${c.vehicle_id}`, button: /invoice & deliver/, click: true },
  gate_out: { url: () => "/m/gate", button: /Gate-out/, click: false },
}

const ROLE_LABEL: Record<string, string> = {
  customer: "🙋 Customer", driver: "🚗 Chauffeur", gate: "🛡️ Security",
  advisor: "🧑‍💼 Service advisor", technician: "🔧 Technician", cashier: "💳 Cashier",
}

const START_EVENT = "dms.demo-tour-start"
export function startDemoTour() {
  window.dispatchEvent(new Event(START_EVENT))
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms))
const norm = (s: string) => s.replace(/[^a-z0-9]/gi, "").toUpperCase()

function findButton(re: RegExp, reg?: string): HTMLButtonElement | null {
  const all = Array.from(document.querySelectorAll<HTMLButtonElement>("button, a")) as HTMLButtonElement[]
  const hits = all.filter((b) => re.test((b.textContent ?? "").trim()) && b.offsetParent !== null && !b.closest("[data-demo-tour]"))
  if (!reg) return hits[0] ?? null
  const key = norm(reg)
  return (
    hits.find((b) => {
      let el: HTMLElement | null = b
      for (let i = 0; i < 8 && el; i++, el = el.parentElement) if (norm(el.textContent ?? "").includes(key)) return true
      return false
    }) ?? null
  )
}

async function waitFor<T>(fn: () => T | null, ms: number): Promise<T | null> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = fn()
    if (v) return v
    await sleep(250)
  }
  return null
}

export function DemoTour() {
  const router = useRouter()
  const pathname = usePathname()
  const pathRef = React.useRef(pathname)
  React.useEffect(() => {
    pathRef.current = pathname
  }, [pathname])

  const [active, setActive] = React.useState(false)
  const [steps, setSteps] = React.useState<DemoStep[]>([])
  const [index, setIndex] = React.useState(0)
  const [, setCtx] = React.useState<DemoCtx>({})
  const [caption, setCaption] = React.useState("")
  const [, setBusy] = React.useState(false)
  const [auto, setAuto] = React.useState(true)
  const [cursor, setCursor] = React.useState<{ x: number; y: number; press: boolean } | null>(null)
  const [ring, setRing] = React.useState<DOMRect | null>(null)
  const ctxRef = React.useRef<DemoCtx>({})
  const autoRef = React.useRef(true)
  const stopRef = React.useRef(false)
  const runningRef = React.useRef(false)

  React.useEffect(() => {
    const start = () => {
      ctxRef.current = {}
      stopRef.current = false
      autoRef.current = true
      setCtx({})
      setIndex(0)
      setAuto(true)
      setCaption("Starting the tour…")
      setActive(true)
      void erp.demoSteps().then(setSteps)
    }
    window.addEventListener(START_EVENT, start)
    return () => window.removeEventListener(START_EVENT, start)
  }, [])

  const point = React.useCallback(async (el: HTMLElement, press: boolean) => {
    el.scrollIntoView({ block: "center", behavior: "smooth" })
    await sleep(500)
    const r = el.getBoundingClientRect()
    setRing(r)
    setCursor((cur) => cur ?? { x: window.innerWidth / 2, y: window.innerHeight - 120, press: false })
    await sleep(50)
    setCursor({ x: r.left + r.width / 2, y: r.top + r.height / 2, press: false })
    await sleep(900)
    if (press) {
      setCursor({ x: r.left + r.width / 2, y: r.top + r.height / 2, press: true })
      await sleep(180)
      el.click()
      await sleep(250)
      setCursor((cur) => cur && { ...cur, press: false })
    } else {
      await sleep(900)
    }
  }, [])

  const runOne = React.useCallback(
    async (step: DemoStep) => {
      const spec = SPEC[step.key]
      let c = ctxRef.current
      const url = spec.url(c)
      if (pathRef.current + window.location.search !== url) {
        setCaption(`Opening the ${ROLE_LABEL[step.role]} screen…`)
        router.push(url)
        await waitFor(() => (pathRef.current === url.split("?")[0] ? true : null), 6000)
        await sleep(1200)
      }
      setCaption(`${ROLE_LABEL[step.role]} · ${step.title}`)

      if (spec.pre) {
        const tab = await waitFor(() => findButton(spec.pre!), 3000)
        if (tab) {
          await point(tab, true)
          await sleep(800)
        }
      }
      if (step.key === "bay") c = ctxRef.current = { ...c, bay_before: (c.bay as string) ?? "" }

      const btn = await waitFor(() => findButton(spec.button, spec.scoped ? c.reg : undefined), 5000)
      const canClick = spec.click && btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true"
      if (btn) await point(btn, !!canClick)

      let done = false
      if (canClick) {
        const end = Date.now() + (step.key === "job_card" ? 30_000 : 10_000)
        while (!done && Date.now() < end) {
          await sleep(700)
          const p = await erp.demoProgress(ctxRef.current)
          ctxRef.current = p.ctx
          done = p.done.includes(step.key)
        }
      }
      let note = ""
      if (!done) {
        if (btn && !canClick) setCaption(`${ROLE_LABEL[step.role]} · ${step.title} — filling in the demo capture`)
        const out = await erp.demoRun(step.key, ctxRef.current)
        ctxRef.current = out.ctx
        note = out.note
      }
      const p = await erp.demoProgress(ctxRef.current)
      ctxRef.current = { ...ctxRef.current, ...p.ctx }
      c = ctxRef.current
      setCtx(c)
      if (step.key === "book" && c.vehicle_id) {
        // the customer's app now shows this car
        localStorage.setItem(
          "dlr-mobile-my-car",
          JSON.stringify({ id: c.vehicle_id, reg_display: c.reg, model: c.model, customer_name: c.customer })
        )
        window.dispatchEvent(new Event("dlr-mobile-my-car-change"))
        followVehicle(c.vehicle_id)
      }
      setRing(null)
      setCaption(`✓ ${step.title}${note ? ` · ${note}` : ""}`)
    },
    [router, point]
  )

  const runFrom = React.useCallback(
    async (from: number, list: DemoStep[]) => {
      if (runningRef.current) return
      runningRef.current = true
      setBusy(true)
      try {
        for (let i = from; i < list.length && !stopRef.current; i++) {
          setIndex(i)
          await runOne(list[i])
          setIndex(i + 1)
          if (!autoRef.current) break
          await sleep(1800)
        }
      } catch (e) {
        setCaption(`Stopped: ${e instanceof Error ? e.message : String(e)}`)
        autoRef.current = false
        setAuto(false)
      } finally {
        runningRef.current = false
        setBusy(false)
      }
    },
    [runOne]
  )

  // kick off once steps are loaded
  React.useEffect(() => {
    if (active && steps.length && index === 0 && !runningRef.current && autoRef.current) void runFrom(0, steps)
  }, [active, steps, index, runFrom])

  if (!active) return null
  const finished = steps.length > 0 && index >= steps.length

  return (
    <div data-demo-tour>
      {ring && (
        <div
          className="pointer-events-none fixed z-[9998] rounded-xl ring-4 ring-emerald-500/80 transition-all duration-500"
          style={{ left: ring.left - 6, top: ring.top - 6, width: ring.width + 12, height: ring.height + 12 }}
        />
      )}
      {cursor && (
        <div
          className="pointer-events-none fixed z-[9999] transition-all duration-700 ease-in-out"
          style={{ left: cursor.x, top: cursor.y }}
        >
          <svg width="28" height="28" viewBox="0 0 24 24" className={cn("drop-shadow-lg transition-transform", cursor.press && "scale-75")}>
            <path d="M4 2l16 9-7 1.5L9.5 20z" fill="#111" stroke="#fff" strokeWidth="1.5" />
          </svg>
          {cursor.press && <span className="absolute -top-3 -left-3 size-8 animate-ping rounded-full bg-emerald-500/50" />}
        </div>
      )}

      {/* compact floating control: progress ring with pause/play, close */}
      <div
        className="fixed right-3 bottom-24 z-[9997] flex items-center gap-1 rounded-full border bg-background/95 p-1 shadow-xl backdrop-blur"
        title={finished ? "Journey complete" : caption}
      >
        <button
          type="button"
          aria-label={finished ? "Journey complete" : auto ? "Pause demo" : "Resume demo"}
          disabled={finished}
          onClick={() => {
            const next = !autoRef.current
            autoRef.current = next
            setAuto(next)
            stopRef.current = false
            if (next && !runningRef.current) void runFrom(index, steps)
          }}
          className="relative flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground"
        >
          <svg className="absolute inset-0 -rotate-90" viewBox="0 0 40 40">
            <circle cx="20" cy="20" r="18" fill="none" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" />
            <circle
              cx="20" cy="20" r="18" fill="none" stroke="#10b981" strokeWidth="3" strokeLinecap="round"
              strokeDasharray={113} strokeDashoffset={113 - 113 * (steps.length ? index / steps.length : 0)}
              className="transition-all duration-500"
            />
          </svg>
          <span className="text-sm leading-none">{finished ? "✓" : auto ? "❚❚" : "▶"}</span>
        </button>
        <span className="px-1 text-xs font-medium tabular-nums">
          {Math.min(index + (finished ? 0 : 1), steps.length || 14)}/{steps.length || 14}
        </span>
        <button
          type="button"
          aria-label="Exit demo"
          onClick={() => {
            stopRef.current = true
            autoRef.current = false
            setActive(false)
            setCursor(null)
            setRing(null)
          }}
          className="flex size-7 items-center justify-center rounded-full text-sm text-muted-foreground hover:bg-muted"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
