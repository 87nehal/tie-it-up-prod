"use client"

import * as React from "react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Calendar03Icon,
  Car01Icon,
  DashboardSquare01Icon,
  Invoice01Icon,
  KanbanIcon,
  Location01Icon,
  Megaphone01Icon,
  Menu01Icon,
  Moon02Icon,
  Notification01Icon,
  PackageIcon,
  Presentation01Icon,
  Search01Icon,
  Settings01Icon,
  SmartPhone01Icon,
  Store01Icon,
  Sun01Icon,
  TaskEdit01Icon,
  UnfoldMoreIcon,
  UserMultipleIcon,
} from "@hugeicons/core-free-icons"
import { useTheme } from "next-themes"

import { erp, type ErpContext, type JourneyStep, type SearchHit } from "@/lib/erp-api"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  FocusStrip,
  JourneyBar,
  JourneyProvider,
  STEPS,
  stepForPath,
  useJourney,
} from "@/components/erp/journey"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"

type NavItem = {
  href: string
  label: string
  title: string
  icon: typeof Car01Icon
  step?: JourneyStep
  n?: number
}

const JOURNEY_ICONS: Record<JourneyStep, typeof Car01Icon> = {
  follow_up: Megaphone01Icon,
  appointment: Calendar03Icon,
  pickup: Location01Icon,
  arrival: UserMultipleIcon,
  job_card: TaskEdit01Icon,
  workshop: KanbanIcon,
  delivery: Invoice01Icon,
}

const TODAY: NavItem = { href: "/", label: "Dashboard", title: "Overview", icon: DashboardSquare01Icon }
const JOURNEY: NavItem[] = STEPS.map((s) => ({
  href: s.href,
  label: s.label,
  title: s.label,
  icon: JOURNEY_ICONS[s.key],
  step: s.key,
  n: s.n,
}))
const RECORDS: NavItem[] = [
  { href: "/vehicles", label: "Customers & vehicles", title: "Customers & vehicles", icon: Car01Icon },
  { href: "/parts", label: "Parts inventory", title: "Parts inventory", icon: PackageIcon },
  { href: "/admin", label: "Outlet setup", title: "Outlet setup", icon: Settings01Icon },
]
const NAV = [TODAY, ...JOURNEY, ...RECORDS]

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`)
}

function currentItem(pathname: string) {
  return [...NAV].reverse().find((item) => isActive(pathname, item.href))
}

// ------------------------------------------------------------------ sidebar

function NavLink({ item, onNavigate, count }: { item: NavItem; onNavigate?: () => void; count?: number }) {
  const pathname = usePathname()
  const active = isActive(pathname, item.href)
  const { focus } = useJourney()
  const here = item.step && focus?.step === item.step
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex h-8 w-full items-center gap-2.5 rounded-lg border px-2 text-[13px] transition-colors",
        active
          ? "border-border bg-card font-medium text-foreground shadow-[0_1px_2px_rgba(0,0,0,.05)]"
          : "border-transparent text-muted-foreground hover:bg-card/70 hover:text-foreground"
      )}
    >
      {item.n ? (
        <span
          className={cn(
            "num flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border text-[10px]",
            active ? "border-foreground bg-foreground text-background" : "border-border bg-card text-muted-foreground"
          )}
        >
          {item.n}
        </span>
      ) : (
        <HugeiconsIcon icon={item.icon} strokeWidth={1.7} className="size-4 shrink-0" />
      )}
      <span className="flex-1 truncate">{item.label}</span>
      {here && <span className="size-1.5 rounded-full bg-brand-red" title="Followed vehicle is at this step" />}
      {count != null && <span className="num min-w-5 text-right text-[11px] text-muted-foreground">{count}</span>}
    </Link>
  )
}

function NavGroup({ label, extra, children }: { label: string; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="border-t border-sidebar-border py-3 first:border-t-0 first:pt-0">
      <p className="mb-1.5 flex items-center justify-between px-2 text-xs font-medium text-foreground/80">
        {label}
        {extra}
      </p>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  )
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const { counts } = useJourney()
  return (
    <nav className="flex flex-col" aria-label="Main navigation">
      <NavGroup label="Main menu">
        <NavLink item={TODAY} onNavigate={onNavigate} />
      </NavGroup>
      <NavGroup
        label="Service journey"
        extra={
          <span className="flex items-center gap-1.5 text-[11px] font-normal text-muted-foreground">
            <span className="live-dot size-1.5 rounded-full bg-success" />
            Live
          </span>
        }
      >
        {JOURNEY.map((item) => (
          <NavLink key={item.href} item={item} onNavigate={onNavigate} count={item.step ? counts?.[item.step] : undefined} />
        ))}
      </NavGroup>
      <NavGroup label="Records">
        {RECORDS.map((item) => (
          <NavLink key={item.href} item={item} onNavigate={onNavigate} />
        ))}
      </NavGroup>
    </nav>
  )
}

function Logo() {
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-card text-[12px] font-bold tracking-tight text-foreground shadow-[0_1px_2px_rgba(0,0,0,.06)]">
      MS
    </span>
  )
}

function ChannelBadge({ channel }: { channel: string }) {
  return (
    <span
      className={cn(
        "num rounded-[4px] px-1 py-px text-[9px] tracking-[.08em]",
        channel === "NEXA" ? "bg-foreground text-background" : "border bg-card text-foreground"
      )}
    >
      {channel}
    </span>
  )
}

/** The showroom account the user is signed in to. Every screen works on this outlet's records. */
function ShowroomAccount({ ctx }: { ctx: ErpContext | null }) {
  if (!ctx) return <div className="h-[56px] animate-pulse rounded-xl border bg-card" />
  const o = ctx.outlet
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className="flex w-full items-center gap-2.5 rounded-xl border bg-muted/70 p-2 text-left shadow-[0_1px_2px_rgba(0,0,0,.03)] transition-colors hover:bg-card"
          />
        }
      >
        <Logo />
        <span className="min-w-0 flex-1 leading-tight">
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            Maruti Suzuki <ChannelBadge channel={o.channel} />
          </span>
          <span className="mt-0.5 block truncate text-[13px] font-medium text-foreground">
            {o.name.split(" - ")[1] ?? o.name.split(" - ")[0]}
          </span>
        </span>
        <HugeiconsIcon icon={UnfoldMoreIcon} strokeWidth={2} className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            <span className="text-foreground">{ctx.dealer.name}</span>
            <span className="block text-[11px] font-normal text-muted-foreground">
              Dealer {ctx.dealer.code} · {o.region} region
            </span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {ctx.outlets.map((x) => (
            <DropdownMenuItem key={x.id} disabled={!x.active} className="items-start">
              <HugeiconsIcon icon={Store01Icon} strokeWidth={2} className="mt-0.5" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{x.name}</span>
                <span className="block text-[11px] text-muted-foreground">
                  {x.channel} · {x.code} · {x.kind}
                  {!x.active && " · not in this demo"}
                </span>
              </span>
              {x.id === o.id && <span className="text-[11px] font-medium text-success">Signed in</span>}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <p className="px-2.5 py-1.5 text-[11px] text-muted-foreground">
            Each of the network&apos;s ~6,000 outlets signs in to its own account and works only on its own vehicles.
          </p>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function Avatar({ initials, className }: { initials?: string; className?: string }) {
  return (
    <span
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-full border bg-gradient-to-b from-zinc-50 to-zinc-200 text-[11px] font-semibold text-zinc-700 dark:from-zinc-700 dark:to-zinc-800 dark:text-zinc-100",
        className
      )}
    >
      {initials ?? "··"}
    </span>
  )
}

function UserCard({ ctx }: { ctx: ErpContext | null }) {
  const { resolvedTheme, setTheme } = useTheme()
  const dark = resolvedTheme === "dark"
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className="flex w-full items-center gap-2.5 rounded-xl border bg-card p-2 text-left shadow-[0_1px_2px_rgba(0,0,0,.04)] transition-colors hover:bg-muted/50"
          />
        }
      >
        <span className="relative">
          <Avatar initials={ctx?.user.initials} className="size-9" />
          <span className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-card bg-success" />
        </span>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-[13px] font-medium text-foreground">{ctx?.user.name ?? "—"}</span>
          <span className="block truncate text-[11px] text-muted-foreground">{ctx?.user.role}</span>
        </span>
        <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} className="size-4 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={() => window.open("/m", "_blank")}>
            <HugeiconsIcon icon={SmartPhone01Icon} strokeWidth={2} />
            Open staff mobile app
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setTheme(dark ? "light" : "dark")}>
            <HugeiconsIcon icon={dark ? Sun01Icon : Moon02Icon} strokeWidth={2} />
            {dark ? "Light theme" : "Dark theme"}
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ------------------------------------------------------------------ header

function Breadcrumb({ pathname }: { pathname: string }) {
  const item = currentItem(pathname)
  const step = STEPS.find((x) => x.key === stepForPath(pathname))
  const section = item?.href === "/" ? "Dashboard" : step ? "Service journey" : "Records"
  return (
    <nav aria-label="Breadcrumb" className="hidden min-w-0 items-center gap-1.5 text-[13px] md:flex">
      <span className="text-muted-foreground">{section}</span>
      <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} className="size-3.5 text-muted-foreground/70" />
      {step && <span className="num text-[11px] text-muted-foreground">{String(step.n).padStart(2, "0")}</span>}
      <span className="truncate font-medium text-foreground">{item?.title ?? "Vehicle record"}</span>
    </nav>
  )
}

function GuideButton() {
  const { setGuideOpen, presenter } = useJourney()
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => setGuideOpen(true)}
      className={cn("hidden gap-1.5 sm:inline-flex", presenter && "border-foreground/30 bg-muted")}
    >
      <HugeiconsIcon icon={Presentation01Icon} strokeWidth={2} className="size-4" />
      Demo guide
    </Button>
  )
}

function GlobalSearch() {
  const router = useRouter()
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [q, setQ] = React.useState("")
  const [hits, setHits] = React.useState<SearchHit[]>([])
  const [open, setOpen] = React.useState(false)

  React.useEffect(() => {
    if (!q.trim()) return
    const t = window.setTimeout(() => {
      erp.search(q).then(setHits).catch(() => setHits([]))
    }, 200)
    return () => window.clearTimeout(t)
  }, [q])

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  function go(hit: SearchHit) {
    setOpen(false)
    setQ("")
    router.push(hit.kind === "job_card" ? `/job-cards?jc=${hit.job_card_id}` : `/vehicles/${hit.vehicle_id}`)
  }

  return (
    <div className="relative w-full max-w-xs">
      <HugeiconsIcon
        icon={Search01Icon}
        strokeWidth={2}
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        ref={inputRef}
        value={q}
        onChange={(e) => {
          setQ(e.target.value)
          setOpen(true)
          if (!e.target.value.trim()) setHits([])
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && hits[0]) go(hits[0])
        }}
        placeholder="Search reg no, VIN, mobile…"
        className="h-8 bg-muted/60 pr-16 pl-9 shadow-none focus-visible:bg-card"
      />
      <kbd className="num pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2 rounded-[5px] border bg-card px-1.5 py-px text-[10px] text-muted-foreground">
        Ctrl K
      </kbd>
      {open && q.trim() && (
        <div className="absolute inset-x-0 top-full z-40 mt-1.5 overflow-hidden rounded-xl border bg-popover p-1 shadow-[0_12px_32px_-12px_rgba(0,0,0,.18)]">
          {hits.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">No matches</p>
          ) : (
            hits.map((h) => (
              <button
                key={`${h.kind}-${h.job_card_id ?? h.vehicle_id}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => go(h)}
                className="flex w-full flex-col items-start rounded-lg px-3 py-2 text-left hover:bg-muted"
              >
                <span className="text-sm font-medium">
                  {h.kind === "job_card" ? "Job card " : ""}
                  {h.label}
                </span>
                {h.sub && <span className="text-xs text-muted-foreground">{h.sub}</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

function Notifications() {
  const [alerts, setAlerts] = React.useState<{ level: string; text: string; vehicle_id: number }[]>([])
  const router = useRouter()
  React.useEffect(() => {
    let live = true
    const load = () =>
      erp
        .dashboard()
        .then((d) => live && setAlerts(d.alerts))
        .catch(() => undefined)
    void load()
    const t = window.setInterval(load, 30_000)
    return () => {
      live = false
      window.clearInterval(t)
    }
  }, [])
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="icon-sm" className="relative" />}>
        <HugeiconsIcon icon={Notification01Icon} strokeWidth={1.8} />
        {alerts.length > 0 && (
          <span className="num absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-foreground px-1 text-[9px] text-background ring-2 ring-background">
            {alerts.length}
          </span>
        )}
        <span className="sr-only">Notifications</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Needs attention</DropdownMenuLabel>
          {alerts.length === 0 && <DropdownMenuItem disabled>Nothing pending</DropdownMenuItem>}
          {alerts.map((a, i) => (
            <DropdownMenuItem key={i} onClick={() => router.push(`/vehicles/${a.vehicle_id}`)}>
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  a.level === "error" ? "bg-destructive" : a.level === "warning" ? "bg-warning" : "bg-info"
                )}
              />
              {a.text}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function HeaderAvatar({ ctx }: { ctx: ErpContext | null }) {
  return (
    <Link href="/m" target="_blank" title="Open staff & customer mobile app" className="rounded-lg">
      <Avatar initials={ctx?.user.initials} className="rounded-lg" />
    </Link>
  )
}

// ------------------------------------------------------------------ shell

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const mobileApp = pathname === "/m" || pathname.startsWith("/m/")
  return (
    <JourneyProvider>
      {mobileApp ? children : <DesktopShell pathname={pathname}>{children}</DesktopShell>}
    </JourneyProvider>
  )
}

function DesktopShell({ pathname, children }: { pathname: string; children: React.ReactNode }) {
  const [ctx, setCtx] = React.useState<ErpContext | null>(null)
  const [open, setOpen] = React.useState(false)

  React.useEffect(() => {
    erp.context().then(setCtx).catch(() => undefined)
  }, [])

  const onJourney = stepForPath(pathname) !== null
  const sidebar = (onNavigate?: () => void) => (
    <>
      <div className="p-3">
        <ShowroomAccount ctx={ctx} />
      </div>
      <div className="flex-1 overflow-y-auto px-3 pt-1 pb-3">
        <NavLinks onNavigate={onNavigate} />
      </div>
      <div className="p-3">
        <UserCard ctx={ctx} />
      </div>
    </>
  )

  return (
    <div className="min-h-svh bg-sidebar">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col bg-sidebar md:flex">{sidebar()}</aside>

      <div className="md:py-2 md:pr-2 md:pl-60">
        <div className="min-h-[calc(100svh-1rem)] bg-background md:rounded-xl md:border md:shadow-[0_1px_3px_rgba(0,0,0,.04)]">
          <header className="sticky top-0 z-20 border-b bg-background/85 backdrop-blur-md md:rounded-t-xl">
            <div className="flex h-14 items-center gap-2 px-4 md:px-6">
              <Sheet open={open} onOpenChange={setOpen}>
                <SheetTrigger render={<Button variant="ghost" size="icon" className="md:hidden" />}>
                  <HugeiconsIcon icon={Menu01Icon} strokeWidth={2} />
                  <span className="sr-only">Open menu</span>
                </SheetTrigger>
                <SheetContent side="left" className="flex w-72 flex-col border-0 bg-sidebar p-0">
                  <SheetHeader className="sr-only">
                    <SheetTitle>Navigation</SheetTitle>
                  </SheetHeader>
                  {sidebar(() => setOpen(false))}
                </SheetContent>
              </Sheet>
              <Breadcrumb pathname={pathname} />
              <div className="flex flex-1 justify-end">
                <GlobalSearch />
              </div>
              <GuideButton />
              <Notifications />
              <HeaderAvatar ctx={ctx} />
            </div>
          </header>
          <main className="mx-auto w-full max-w-[1680px] px-4 py-6 md:px-6">
            {onJourney && <JourneyBar />}
            {pathname !== "/" && <FocusStrip />}
            {children}
          </main>
        </div>
      </div>
    </div>
  )
}
