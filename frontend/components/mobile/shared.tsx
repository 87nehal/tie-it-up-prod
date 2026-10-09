"use client"

import * as React from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Camera01Icon,
  Car01Icon,
  CheckmarkCircle02Icon,
  Shield01Icon,
  SteeringIcon,
  UserIcon,
  Wrench01Icon,
} from "@hugeicons/core-free-icons"

import { cn } from "@/lib/utils"
import { subscribeDataChange } from "@/lib/demo-sync"

// ------------------------------------------------------------------ roles

export type Role = "advisor" | "security" | "driver" | "tech" | "customer"

export const ROLES: {
  key: Role
  label: string
  desc: string
  href: string
  icon: typeof UserIcon
}[] = [
  {
    key: "advisor",
    label: "Service Advisor",
    desc: "Receive vehicles, walk-around, concerns",
    href: "/m/arrival",
    icon: UserIcon,
  },
  {
    key: "security",
    label: "Security (Gate)",
    desc: "Scan plates, gate-in and gate-out",
    href: "/m/gate",
    icon: Shield01Icon,
  },
  {
    key: "driver",
    label: "Driver",
    desc: "Pickup trips and handover",
    href: "/m/driver",
    icon: SteeringIcon,
  },
  {
    key: "tech",
    label: "Technician",
    desc: "Workshop jobs, start work and quality checks",
    href: "/m/tech",
    icon: Wrench01Icon,
  },
  {
    key: "customer",
    label: "Customer",
    desc: "Book service, track your car",
    href: "/m/customer",
    icon: Car01Icon,
  },
]

const ROLE_KEY = "dlr-mobile-role"
const ROLE_EVENT = "dlr-mobile-role-change"

function subscribeRole(cb: () => void) {
  window.addEventListener("storage", cb)
  window.addEventListener(ROLE_EVENT, cb)
  return () => {
    window.removeEventListener("storage", cb)
    window.removeEventListener(ROLE_EVENT, cb)
  }
}

export function useRole(): Role | null {
  return React.useSyncExternalStore(
    subscribeRole,
    () => {
      const saved = localStorage.getItem(ROLE_KEY)
      return ROLES.find((role) => role.key === saved)?.key ?? null
    },
    () => null
  )
}

export function setRole(role: Role | null) {
  if (role) localStorage.setItem(ROLE_KEY, role)
  else localStorage.removeItem(ROLE_KEY)
  window.dispatchEvent(new Event(ROLE_EVENT))
}

export function roleLabel(role: Role | null) {
  return ROLES.find((r) => r.key === role)?.label ?? "Choose role"
}

// ------------------------------------------------------------------ data

export function useLoad<T>(
  fn: () => Promise<T>,
  deps: React.DependencyList,
  pollMs = 0
) {
  const [state, setState] = React.useState<{
    data: T | null
    error: string | null
    loading: boolean
  }>({ data: null, error: null, loading: true })
  const refresh = React.useRef<(() => void) | null>(null)
  const reload = React.useCallback(() => refresh.current?.(), [])
  React.useEffect(() => {
    let alive = true
    let inFlight = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    async function load() {
      if (!alive || inFlight) return
      inFlight = true
      try {
        const data = await Promise.race([
          Promise.resolve().then(fn),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () =>
                reject(
                  new Error(
                    "This is taking longer than expected. Check your connection and try again."
                  )
                ),
              15000
            )
          }),
        ])
        if (alive) setState({ data, error: null, loading: false })
      } catch (e) {
        if (alive)
          setState((previous) => ({
            ...previous,
            error: errMsg(e),
            loading: false,
          }))
      } finally {
        clearTimeout(timeout)
        inFlight = false
      }
    }
    refresh.current = () => {
      void load()
    }
    void Promise.resolve().then(() => {
      if (alive) {
        setState({ data: null, error: null, loading: true })
        void load()
      }
    })
    const unsubscribe = subscribeDataChange(reload)
    const timer = pollMs
      ? window.setInterval(() => {
          void load()
        }, pollMs)
      : null
    return () => {
      alive = false
      refresh.current = null
      clearTimeout(timeout)
      unsubscribe()
      if (timer) window.clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, pollMs, reload])
  return { ...state, reload }
}

export async function fileFromUrl(url: string, name: string) {
  const res = await fetch(url)
  if (!res.ok) throw new Error("Demo photo not available")
  const blob = await res.blob()
  return new File([blob], name, { type: blob.type || "image/jpeg" })
}

export function demoPhoto(
  vehicleId: number,
  kind: "plate" | "vin" | "odometer"
) {
  return fileFromUrl(
    `/api/service/demo/photos/${vehicleId}/${kind}`,
    `${kind}-${vehicleId}.jpg`
  )
}

export function errMsg(e: unknown) {
  return e instanceof Error ? e.message : String(e)
}

export const normPlate = (s: string) =>
  s.replace(/[^A-Z0-9]/gi, "").toUpperCase()

export function fmtTime(iso?: string | null) {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })
}

export function fmtDate(iso?: string | null) {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
  })
}

export const inr = (n?: number | null) =>
  n == null ? "—" : "₹" + Math.round(n).toLocaleString("en-IN")

export const km = (n?: number | null) =>
  n == null ? "—" : `${Math.round(n).toLocaleString("en-IN")} km`

// ------------------------------------------------------------------ UI bits

export function MCard({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-2xl border bg-card p-4 text-card-foreground shadow-[0_2px_8px_-4px_rgba(0,0,0,.12)]",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="px-1 pt-2 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
      {children}
    </h2>
  )
}

const TONES = {
  neutral: "bg-muted text-muted-foreground",
  info: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  ok: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  warn: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  bad: "bg-red-500/10 text-red-700 dark:text-red-300",
}

export function Pill({
  tone = "neutral",
  children,
  className,
}: {
  tone?: keyof typeof TONES
  children: React.ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        TONES[tone],
        className
      )}
    >
      {children}
    </span>
  )
}

export function ErrorNote({
  children,
  onRetry,
}: {
  children: React.ReactNode
  onRetry?: () => void
}) {
  if (!children) return null
  return (
    <div
      role="alert"
      className="rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-700 dark:text-red-300"
    >
      <p>{children}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-2 min-h-11 rounded-lg border border-current px-4 font-semibold"
        >
          Try again
        </button>
      )}
    </div>
  )
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-20 animate-pulse rounded-2xl bg-muted" />
      ))}
      <span className="py-2 text-center text-sm text-muted-foreground">
        {label}
      </span>
    </div>
  )
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}

/** Sticky footer above the bottom tab bar for primary actions. */
export function StickyActions({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-mobile-actions
      className="fixed inset-x-0 bottom-[calc(4.25rem+env(safe-area-inset-bottom))] z-20 mx-auto flex w-full max-w-md gap-3 border-t bg-card/95 px-4 py-3 shadow-[0_-4px_16px_-12px_rgba(0,0,0,.25)] backdrop-blur"
    >
      {children}
    </div>
  )
}

export function usePreview(file: File | null) {
  const url = React.useMemo(
    () => (file ? URL.createObjectURL(file) : null),
    [file]
  )
  React.useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url)
    },
    [url]
  )
  return url
}

/** Big camera capture button with thumbnail + optional demo-photo link. */
export function PhotoCapture({
  label,
  hint,
  file,
  onFile,
  onDemo,
  busy,
  done,
}: {
  label: string
  hint?: string
  file: File | null
  onFile: (f: File) => void
  onDemo?: () => void
  busy?: boolean
  done?: boolean
}) {
  const ref = React.useRef<HTMLInputElement>(null)
  const preview = usePreview(file)
  return (
    <div className="flex flex-col gap-2">
      <input
        ref={ref}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onFile(f)
          e.target.value = ""
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => ref.current?.click()}
        className={cn(
          "relative flex aspect-[16/10] w-full flex-col items-center justify-center gap-2 overflow-hidden rounded-2xl border-2 border-dashed bg-muted/40 text-muted-foreground transition active:scale-[0.99] disabled:cursor-wait",
          preview && "border-solid"
        )}
      >
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={preview}
            alt={label}
            className="absolute inset-0 size-full object-cover"
          />
        ) : (
          <>
            <span className="flex size-16 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <HugeiconsIcon icon={Camera01Icon} className="size-8" />
            </span>
            <span className="text-base font-medium text-foreground">
              {label}
            </span>
            {hint && <span className="px-6 text-center text-xs">{hint}</span>}
          </>
        )}
        {busy && (
          <span className="absolute inset-x-0 bottom-0 bg-black/60 py-2 text-center text-sm text-white">
            Reading photo…
          </span>
        )}
        {done && !busy && (
          <span className="absolute top-2 right-2 rounded-full bg-emerald-600 p-1 text-white">
            <HugeiconsIcon icon={CheckmarkCircle02Icon} className="size-5" />
          </span>
        )}
      </button>
      <div className="flex items-center justify-between px-1 text-sm">
        {preview ? (
          <button
            type="button"
            disabled={busy}
            className="min-h-11 font-medium text-primary"
            onClick={() => ref.current?.click()}
          >
            Retake photo
          </button>
        ) : (
          <span className="text-muted-foreground">Tap to open camera</span>
        )}
        {onDemo && (
          <button
            type="button"
            disabled={busy}
            className="min-h-11 font-medium text-primary underline-offset-4 hover:underline"
            onClick={onDemo}
          >
            Use demo photo
          </button>
        )}
      </div>
    </div>
  )
}

/** Small square camera tile for multi-angle capture. */
export function PhotoTile({
  label,
  file,
  onFile,
}: {
  label: string
  file: File | null
  onFile: (f: File) => void
}) {
  const ref = React.useRef<HTMLInputElement>(null)
  const preview = usePreview(file)
  return (
    <button
      type="button"
      onClick={() => ref.current?.click()}
      className={cn(
        "relative flex aspect-square flex-col items-center justify-center gap-1 overflow-hidden rounded-xl border-2 border-dashed bg-muted/40 text-xs text-muted-foreground active:scale-[0.98]",
        preview && "border-solid border-emerald-500"
      )}
    >
      <input
        ref={ref}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onClick={(event) => event.stopPropagation()}
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onFile(f)
          e.target.value = ""
        }}
      />
      {preview ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={preview}
            alt={label}
            className="absolute inset-0 size-full object-cover"
          />
          <span className="absolute inset-x-0 bottom-0 bg-black/60 px-1 py-1 text-center text-[11px] text-white">
            {label}
          </span>
        </>
      ) : (
        <>
          <HugeiconsIcon icon={Camera01Icon} className="size-7" />
          <span className="px-1 text-center leading-tight font-medium text-foreground">
            {label}
          </span>
        </>
      )}
    </button>
  )
}
