"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  Calendar03Icon,
  ArrowLeft01Icon,
  Car01Icon,
  Home01Icon,
  Search01Icon,
  Camera01Icon,
  Shield01Icon,
  SteeringIcon,
  UserIcon,
  Wrench01Icon,
} from "@hugeicons/core-free-icons"

import { erp, type ErpContext } from "@/lib/erp-api"
import { cn } from "@/lib/utils"
import {
  roleLabel,
  useRole,
  setRole,
  ROLES,
  type Role,
} from "@/components/mobile/shared"
import { useJourneyMaybe } from "@/components/erp/journey"
import { setMyCar } from "@/components/mobile/customer"

type Tab = { href: string; label: string; icon: typeof Home01Icon }
const HOME: Tab = { href: "/m", label: "Home", icon: Home01Icon }
const INSPECT: Tab = {
  href: "/m/inspect",
  label: "Inspect",
  icon: Camera01Icon,
}
const LOOKUP: Tab = { href: "/m/search", label: "Lookup", icon: Search01Icon }

const TABS: Record<Role | "none", Tab[]> = {
  none: [HOME, LOOKUP],
  advisor: [
    HOME,
    { href: "/m/arrival", label: "New arrival", icon: UserIcon },
    INSPECT,
    { href: "/m/gate", label: "Gate", icon: Shield01Icon },
    LOOKUP,
  ],
  security: [
    HOME,
    { href: "/m/gate", label: "Gate", icon: Shield01Icon },
    INSPECT,
    LOOKUP,
  ],
  driver: [
    HOME,
    { href: "/m/driver", label: "Trips", icon: SteeringIcon },
    LOOKUP,
  ],
  tech: [HOME, { href: "/m/tech", label: "Jobs", icon: Wrench01Icon }, LOOKUP],
  customer: [
    { href: "/m/customer", label: "Home", icon: Home01Icon },
    { href: "/m/book", label: "Book", icon: Calendar03Icon },
    { href: "/m/my-car", label: "My car", icon: Car01Icon },
  ],
}

export function MobileShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const savedRole = useRole()
  const hydrated = React.useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  )
  const role: Role | null = ["/m/customer", "/m/book", "/m/my-car"].includes(
    pathname
  )
    ? "customer"
    : pathname === "/m/driver"
      ? "driver"
      : pathname === "/m/tech"
        ? "tech"
        : pathname === "/m/gate"
          ? savedRole === "advisor"
            ? "advisor"
            : "security"
          : pathname === "/m/arrival"
            ? "advisor"
            : pathname === "/m/inspect"
              ? savedRole === "security"
                ? "security"
                : (savedRole ?? "advisor")
              : savedRole
  const journey = useJourneyMaybe()
  const current = journey?.focus
  const tabs = TABS[role ?? "none"]
  const [ctx, setCtx] = React.useState<ErpContext | null>(null)

  React.useEffect(() => {
    if (hydrated && role && role !== savedRole) setRole(role)
  }, [hydrated, role, savedRole])

  React.useEffect(() => {
    erp
      .context()
      .then(setCtx)
      .catch(() => undefined)
  }, [])

  return (
    <div className="mobile-workspace min-h-dvh bg-muted/60">
      <div className="mx-auto flex min-h-dvh w-full max-w-md flex-col bg-[#f7f8fa] shadow-sm dark:bg-background">
        <header className="sticky top-0 z-20 border-b bg-white pt-[env(safe-area-inset-top)] text-foreground dark:bg-card">
          <div className="flex h-14 items-center gap-3 px-4">
            {pathname.startsWith("/m/vehicle/") ? (
              <Link
                href="/m/search"
                aria-label="Back to vehicle search"
                className="flex size-11 shrink-0 items-center justify-center rounded-xl border"
              >
                <HugeiconsIcon icon={ArrowLeft01Icon} className="size-5" />
              </Link>
            ) : (
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[#181b22] text-xs font-bold text-white">
                MS
              </span>
            )}
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-sm font-semibold">
                {roleLabel(role)}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {ctx?.outlet.name ?? "Dealer service"}
              </div>
            </div>
          </div>
          <details className="group/workspaces relative border-t px-4">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between text-xs font-medium">
              <span>Switch workspace</span>
              <span className="text-muted-foreground">
                {current?.vehicle.reg_display ?? "Staff & customer views"}
              </span>
            </summary>
            <div className="absolute inset-x-2 top-full z-40 mt-1 grid gap-2 rounded-2xl border bg-card p-3 shadow-lg">
              {ROLES.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  className={cn(
                    "flex min-h-12 items-center gap-3 rounded-xl border px-3 text-left text-sm",
                    option.key === role && "bg-primary text-primary-foreground"
                  )}
                  onClick={(event) => {
                    setRole(option.key)
                    if (current)
                      setMyCar({
                        id: current.vehicle.id,
                        reg_display: current.vehicle.reg_display,
                        model: current.vehicle.model,
                        customer_name: current.vehicle.customer_name,
                      })
                    event.currentTarget
                      .closest("details")
                      ?.removeAttribute("open")
                    router.push(
                      `${option.href}${current ? `?v=${current.vehicle.id}` : ""}`
                    )
                  }}
                >
                  <HugeiconsIcon
                    icon={option.icon}
                    className="size-5 shrink-0"
                  />
                  {option.label}
                </button>
              ))}
              <Link
                href={current?.next?.href ?? "/"}
                className="flex min-h-11 items-center justify-center rounded-xl px-3 text-xs text-muted-foreground"
              >
                Desktop workspace
              </Link>
            </div>
          </details>
        </header>

        <main
          id="mobile-content"
          key={pathname}
          className="min-w-0 flex-1 px-4 pt-5 pb-[calc(5.5rem+env(safe-area-inset-bottom))]"
        >
          {children}
        </main>

        <nav
          aria-label="Mobile navigation"
          className="fixed inset-x-0 bottom-0 z-30 mx-auto w-full max-w-md border-t bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur dark:bg-card/95"
        >
          <ul className="flex h-[4.25rem]">
            {tabs.map((tab) => {
              const active =
                tab.href === "/m"
                  ? pathname === "/m"
                  : pathname.startsWith(tab.href)
              return (
                <li key={tab.href} className="flex-1">
                  <Link
                    href={tab.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex h-full flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                      active ? "text-primary" : "text-muted-foreground"
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-8 w-14 items-center justify-center rounded-full",
                        active && "bg-primary/10"
                      )}
                    >
                      <HugeiconsIcon
                        icon={tab.icon}
                        className="size-6"
                        strokeWidth={active ? 2.2 : 1.6}
                      />
                    </span>
                    {tab.label}
                  </Link>
                </li>
              )
            })}
          </ul>
        </nav>
      </div>
    </div>
  )
}
