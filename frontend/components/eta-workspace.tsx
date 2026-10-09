"use client"

import * as React from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import {
  ArrowDataTransferVerticalIcon,
  Clock01Icon,
  Location01Icon,
  MapsLocation01Icon,
  Route01Icon,
} from "@hugeicons/core-free-icons"
import { toast } from "sonner"

import {
  estimateEta,
  searchPlaces,
  type EtaEstimate,
  type EtaMode,
  type Place,
} from "@/lib/api"
import { clock } from "@/lib/format"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Separator } from "@/components/ui/separator"
import { RouteMap } from "@/components/common/route-map"

const MODES: { value: EtaMode; label: string }[] = [
  { value: "DRIVE", label: "Car" },
  { value: "TWO_WHEELER", label: "Bike" },
  { value: "BICYCLE", label: "Cycle" },
  { value: "WALK", label: "Walk" },
]

/** Place search against the local gazetteer; "lat,lng" is accepted too. */
function PlaceInput({
  id,
  value,
  onChange,
}: {
  id: string
  value: string
  onChange: (value: string) => void
}) {
  const [suggestions, setSuggestions] = React.useState<Place[]>([])
  const [open, setOpen] = React.useState(false)

  React.useEffect(() => {
    const input = value.trim()
    if (input.length < 2) return
    let active = true
    const t = window.setTimeout(() => {
      searchPlaces(input)
        .then((p) => active && setSuggestions(p))
        .catch(() => active && setSuggestions([]))
    }, 150)
    return () => {
      active = false
      window.clearTimeout(t)
    }
  }, [value])

  const shown = suggestions.filter((s) => s.name !== value)
  return (
    <div className="relative">
      <Input
        id={id}
        value={value}
        autoComplete="off"
        placeholder="Search a locality, or lat,lng"
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
      />
      {open && shown.length > 0 && value.trim().length >= 2 ? (
        <ul className="absolute z-20 mt-1 w-full overflow-hidden rounded-xl border bg-popover py-1 text-sm shadow-md">
          {shown.map((s) => (
            <li key={s.name}>
              <button
                type="button"
                className="w-full px-3 py-2 text-left hover:bg-muted"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(s.name)
                  setOpen(false)
                }}
              >
                {s.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export function EtaWorkspace() {
  const [origin, setOrigin] = React.useState(
    "Arena Workshop, Sector 18, Gurugram"
  )
  const [destination, setDestination] = React.useState("")
  const [mode, setMode] = React.useState<EtaMode>("DRIVE")
  const [departAt, setDepartAt] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [estimate, setEstimate] = React.useState<EtaEstimate | null>(null)
  const [now, setNow] = React.useState(() => Date.now())

  // Keep the "min away" countdown live.
  React.useEffect(() => {
    if (!estimate) return
    const id = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(id)
  }, [estimate])

  function swap() {
    setOrigin(destination)
    setDestination(origin)
  }

  async function getEstimate(e: React.FormEvent) {
    e.preventDefault()
    if (!origin.trim() || !destination.trim()) {
      toast.error("Enter both pickup and drop-off")
      return
    }
    setBusy(true)
    try {
      const est = await estimateEta({
        origin,
        destination,
        mode,
        depart_at: departAt
          ? new Date(departAt).toISOString().slice(0, 19)
          : undefined,
      })
      setEstimate(est)
      setNow(Date.now())
    } catch (err) {
      setEstimate(null)
      toast.error(err instanceof Error ? err.message : "Could not get estimate")
    } finally {
      setBusy(false)
    }
  }

  const arrival = estimate ? new Date(estimate.arrive_at) : null
  const remainingMin = arrival
    ? Math.max(0, Math.round((arrival.getTime() - now) / 60_000))
    : 0

  return (
    <div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <div className="space-y-6">
        <Card className="overflow-visible">
          <CardHeader>
            <CardTitle>Ride estimate</CardTitle>
            <CardDescription>
              Travel time between two points from the offline ETA engine, the
              same one that monitors chauffeur pickups. No map service is
              called.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={getEstimate} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="origin">Pickup</Label>
                <PlaceInput id="origin" value={origin} onChange={setOrigin} />
              </div>
              <div className="flex justify-center">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Swap pickup and drop-off"
                  onClick={swap}
                >
                  <HugeiconsIcon
                    icon={ArrowDataTransferVerticalIcon}
                    strokeWidth={2}
                  />
                </Button>
              </div>
              <div className="space-y-2">
                <Label htmlFor="destination">Drop-off</Label>
                <PlaceInput
                  id="destination"
                  value={destination}
                  onChange={setDestination}
                />
              </div>
              <div className="space-y-2">
                <Label>Mode</Label>
                <div className="grid grid-cols-4 gap-2">
                  {MODES.map((m) => (
                    <Button
                      key={m.value}
                      type="button"
                      variant={mode === m.value ? "secondary" : "outline"}
                      onClick={() => setMode(m.value)}
                    >
                      {m.label}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="depart">Departure (optional)</Label>
                <Input
                  id="depart"
                  type="datetime-local"
                  value={departAt}
                  onChange={(e) => setDepartAt(e.target.value)}
                />
              </div>
              <Button type="submit" className="w-full" disabled={busy}>
                <HugeiconsIcon
                  icon={Route01Icon}
                  strokeWidth={2}
                  data-icon="inline-start"
                />
                {busy ? "Estimating…" : "Get estimate"}
              </Button>
            </form>
          </CardContent>
        </Card>

        {estimate && arrival ? (
          <Card>
            <CardHeader>
              <CardDescription>Estimated arrival</CardDescription>
              <CardTitle className="text-4xl font-semibold tracking-tight">
                {clock(estimate.arrive_at)}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">
                  <HugeiconsIcon
                    icon={Clock01Icon}
                    strokeWidth={2}
                    data-icon="inline-start"
                  />
                  {remainingMin} min away
                </Badge>
                <Badge variant="outline">{estimate.distance_km} km</Badge>
                {estimate.speed_profile === "time-of-day" ? (
                  <Badge variant="outline">Time-of-day traffic</Badge>
                ) : null}
              </div>
              <Separator />
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-muted-foreground">Travel time</dt>
                  <dd className="font-medium">{estimate.duration_min} min</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Free-flow</dt>
                  <dd className="font-medium">
                    {estimate.free_flow_min} min
                    {estimate.traffic_delay_min
                      ? ` (+${estimate.traffic_delay_min} traffic)`
                      : ""}
                  </dd>
                </div>
              </dl>
              <Separator />
              <ol className="space-y-3 text-sm">
                <li className="flex gap-2">
                  <HugeiconsIcon
                    icon={Location01Icon}
                    strokeWidth={2}
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  />
                  <span>{estimate.origin.name}</span>
                </li>
                <li className="flex gap-2">
                  <HugeiconsIcon
                    icon={MapsLocation01Icon}
                    strokeWidth={2}
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  />
                  <span>{estimate.destination.name}</span>
                </li>
              </ol>
              <p className="text-xs text-muted-foreground">{estimate.model}</p>
            </CardContent>
          </Card>
        ) : null}
      </div>

      <Card className="h-fit">
        <CardHeader>
          <CardTitle>Route</CardTitle>
          <CardDescription>
            Schematic, drawn locally from coordinates.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {estimate ? (
            <RouteMap
              points={[
                {
                  id: "a",
                  kind: "start",
                  label: estimate.origin.name.split(",")[0],
                  ...estimate.origin,
                },
                {
                  id: "b",
                  kind: "end",
                  label: estimate.destination.name.split(",")[0],
                  ...estimate.destination,
                },
              ]}
              legs={[["a", "b"]]}
            />
          ) : (
            <p className="rounded-xl border border-dashed px-4 py-24 text-center text-sm text-muted-foreground">
              Choose a pickup and drop-off to draw the route.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
