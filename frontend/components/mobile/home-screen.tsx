"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowRight01Icon,
  CheckmarkCircle02Icon,
} from "@hugeicons/core-free-icons"

import { service } from "@/lib/service-api"
import { erp } from "@/lib/erp-api"
import { cn } from "@/lib/utils"
import {
  MCard,
  ErrorNote,
  ROLES,
  SectionTitle,
  setRole,
  useLoad,
  useRole,
} from "@/components/mobile/shared"

export function HomeScreen() {
  const role = useRole()
  const router = useRouter()
  const summary = useLoad(() => service.summary(), [])
  const board = useLoad(() => erp.board(), [])

  const count = (keys: string[]) =>
    board.data?.stages
      .filter((s) => keys.includes(s.key))
      .reduce((n, s) => n + s.cards.length, 0) ?? null

  const s = summary.data
  const cards = [
    { label: "Expected at gate", value: s?.expected_at_gate },
    { label: "Arrived today", value: s?.arrived_today },
    { label: "Pickups live", value: s?.pickups_live },
    { label: "In workshop", value: count(["in_progress", "qc"]) },
    { label: "Ready for delivery", value: count(["ready"]) },
    { label: "Delivered", value: count(["delivered"]) },
  ]
  const current = ROLES.find((r) => r.key === role)
  const today = new Date().toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
  })

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold">Your workday</h1>
        <p className="text-sm text-muted-foreground">{today}</p>
      </div>

      <Link href="/m/demo">
        <MCard className="flex items-center gap-3 border-emerald-500/30 bg-emerald-500/5">
          <span className="flex size-11 items-center justify-center rounded-xl bg-emerald-600 text-xl text-white">▶</span>
          <div className="min-w-0 flex-1">
            <div className="font-semibold">Run the full journey demo</div>
            <div className="mt-1 text-sm text-muted-foreground">
              One car through customer, chauffeur, gate, advisor, technician and cashier
            </div>
          </div>
          <HugeiconsIcon icon={ArrowRight01Icon} className="size-5 text-muted-foreground" />
        </MCard>
      </Link>

      {current && (
        <Link href={current.href}>
          <MCard className="flex items-center gap-3 border-primary/30 bg-primary/5">
            <span className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <HugeiconsIcon icon={current.icon} className="size-6" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="font-semibold">
                {role === "advisor"
                  ? "Receive a vehicle"
                  : role === "security"
                    ? "Open the gate queue"
                    : role === "driver"
                      ? "View pickup trips"
                      : role === "tech"
                        ? "View workshop jobs"
                        : "Track your service"}
              </div>
              <div className="mt-1 text-sm text-muted-foreground">
                {current.desc}
              </div>
            </div>
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              className="size-5 text-muted-foreground"
            />
          </MCard>
        </Link>
      )}

      <section className="order-2">
        <SectionTitle>Today at the outlet</SectionTitle>
        <ErrorNote
          onRetry={() => {
            summary.reload()
            board.reload()
          }}
        >
          {summary.error ?? board.error}
        </ErrorNote>
        <div className="mt-2 grid grid-cols-2 gap-3">
          {cards.map((c) => (
            <MCard key={c.label} className="p-3">
              <div className="text-2xl font-semibold tabular-nums">
                {c.value ??
                  (summary.error || board.error ? (
                    "—"
                  ) : (
                    <span className="inline-block h-7 w-8 animate-pulse rounded bg-muted" />
                  ))}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {c.label}
              </div>
            </MCard>
          ))}
        </div>
      </section>

      <details
        open={!role}
        className={cn(
          "rounded-2xl border bg-card p-4",
          role ? "order-3" : "order-1"
        )}
      >
        <summary className="min-h-11 cursor-pointer text-sm font-semibold">
          {role
            ? "Choose another workspace"
            : "Choose your workspace to get started"}
        </summary>
        <div className="mt-3 flex flex-col gap-2">
          {ROLES.map((r) => {
            const active = r.key === role
            return (
              <button
                key={r.key}
                type="button"
                onClick={() => {
                  setRole(r.key)
                  router.push(r.href)
                }}
                className={cn(
                  "flex min-h-16 items-center gap-3 rounded-2xl border bg-card p-3 text-left active:scale-[0.99]",
                  active && "border-primary ring-2 ring-primary/20"
                )}
              >
                <span className="flex size-11 items-center justify-center rounded-xl bg-muted">
                  <HugeiconsIcon icon={r.icon} className="size-6" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">{r.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {r.desc}
                  </span>
                </span>
                <HugeiconsIcon
                  icon={active ? CheckmarkCircle02Icon : ArrowRight01Icon}
                  className="size-5 shrink-0 text-primary"
                />
              </button>
            )
          })}
        </div>
      </details>
    </div>
  )
}
