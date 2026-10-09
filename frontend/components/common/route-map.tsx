import { cn } from "@/lib/utils"

export type MapPoint = {
  id: string
  lat: number
  lng: number
  label: string
  kind?: "anchor" | "start" | "end" | "vehicle" | "customer"
  tone?: "ok" | "warn" | "bad" | "idle"
}

const TONE: Record<string, string> = {
  ok: "fill-emerald-500",
  warn: "fill-amber-500",
  bad: "fill-destructive",
  idle: "fill-muted-foreground",
}

/**
 * Offline schematic map: points projected on a local grid with dashed legs.
 * No map tiles or geocoding are fetched, so it works on an air-gapped box.
 * Optional selection: the selected point (and legs touching it) are emphasised.
 */
export function RouteMap({
  points,
  legs = [],
  className,
  selectedId,
  onSelect,
}: {
  points: MapPoint[]
  legs?: [string, string][]
  className?: string
  selectedId?: string | null
  onSelect?: (id: string) => void
}) {
  if (!points.length) return null
  const pad = 0.012
  const minLat = Math.min(...points.map((p) => p.lat)) - pad
  const maxLat = Math.max(...points.map((p) => p.lat)) + pad
  const minLng = Math.min(...points.map((p) => p.lng)) - pad
  const maxLng = Math.max(...points.map((p) => p.lng)) + pad
  const span = Math.max(maxLat - minLat, maxLng - minLng)
  const x = (lng: number) => ((lng - minLng) / span) * 100
  const y = (lat: number) => 100 - ((lat - minLat) / span) * 100
  const byId = Object.fromEntries(points.map((p) => [p.id, p]))
  const kmPerUnit = (span * 111) / 100
  const dim = selectedId != null

  return (
    <svg
      viewBox="-6 -6 112 112"
      className={cn(
        "aspect-square w-full rounded-xl border bg-muted/30",
        className
      )}
      role="img"
      aria-label="Schematic route map"
    >
      {[20, 40, 60, 80].map((g) => (
        <g key={g} className="stroke-border" strokeWidth={0.2}>
          <line x1={g} y1={0} x2={g} y2={100} />
          <line x1={0} y1={g} x2={100} y2={g} />
        </g>
      ))}
      {legs.map(([a, b]) => {
        if (!byId[a] || !byId[b]) return null
        const hot = selectedId === a || selectedId === b
        return (
          <line
            key={`${a}-${b}`}
            x1={x(byId[a].lng)}
            y1={y(byId[a].lat)}
            x2={x(byId[b].lng)}
            y2={y(byId[b].lat)}
            className={
              hot
                ? "stroke-primary"
                : dim
                  ? "stroke-primary/25"
                  : "stroke-primary/60"
            }
            strokeWidth={hot ? 0.9 : 0.6}
            strokeDasharray="1.8 1.2"
          />
        )
      })}
      {points.map((p) => {
        const px = x(p.lng)
        const py = y(p.lat)
        const sel = selectedId === p.id
        const faded = dim && !sel && p.kind !== "anchor"
        return (
          <g
            key={p.id}
            opacity={faded ? 0.45 : 1}
            className={onSelect && p.kind !== "anchor" ? "cursor-pointer" : undefined}
            onClick={onSelect && p.kind !== "anchor" ? () => onSelect(p.id) : undefined}
          >
            {sel ? (
              <circle cx={px} cy={py} r={4.6} className="fill-primary/15" />
            ) : null}
            {p.kind === "anchor" ? (
              <rect
                x={px - 2.5}
                y={py - 2.5}
                width={5}
                height={5}
                rx={1}
                className="fill-primary"
              />
            ) : p.kind === "customer" ? (
              <circle
                cx={px}
                cy={py}
                r={1.8}
                strokeWidth={0.6}
                className="fill-card stroke-foreground/70"
              />
            ) : p.kind === "start" || p.kind === "end" ? (
              <circle
                cx={px}
                cy={py}
                r={2.4}
                className={
                  p.kind === "start" ? "fill-primary" : "fill-foreground"
                }
              />
            ) : (
              <circle
                cx={px}
                cy={py}
                r={2.2}
                strokeWidth={0.6}
                className={cn(TONE[p.tone ?? "idle"], "stroke-card")}
              />
            )}
            <text
              x={px + 3.5}
              y={py + 1.2}
              fontSize={p.kind === "customer" ? 2.7 : 3.2}
              fontWeight={sel || p.kind === "anchor" ? 600 : 400}
              className={
                p.kind === "customer" ? "fill-muted-foreground" : "fill-foreground"
              }
              style={{ paintOrder: "stroke" }}
              stroke="var(--card)"
              strokeWidth={0.8}
            >
              {p.label}
            </text>
          </g>
        )
      })}
      <g className="fill-muted-foreground" fontSize={2.6}>
        <line
          x1={2}
          y1={104}
          x2={22}
          y2={104}
          className="stroke-muted-foreground"
          strokeWidth={0.4}
        />
        <text x={24} y={105}>
          {(kmPerUnit * 20).toFixed(1)} km
        </text>
      </g>
    </svg>
  )
}
