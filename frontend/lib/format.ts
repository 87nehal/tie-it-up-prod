// Display formatting shared by every screen.

export function todayIso(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86_400_000)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10)
}

export function clock(iso?: string | null) {
  if (!iso) return "—"
  return new Date(iso).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  })
}

export function dayTime(iso?: string | null) {
  if (!iso) return "—"
  return new Date(iso).toLocaleString([], {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  })
}

export function inr(n: number) {
  return `₹${Math.round(n).toLocaleString("en-IN")}`
}

export function pct(n: number) {
  return `${Math.round(n * 100)}%`
}

export function humanize(value: string) {
  return value.replaceAll("_", " ").replaceAll(":", ": ")
}
