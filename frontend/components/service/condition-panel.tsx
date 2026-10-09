import type { ConditionReport } from "@/lib/service-api"
import { humanize } from "@/lib/format"
import { Badge } from "@/components/ui/badge"
import { ClassDot } from "@/components/common/damage-findings"

const DECISION: Record<
  ConditionReport["images"][number]["decision"],
  { label: string; variant: "secondary" | "outline" | "destructive" }
> = {
  no_damage_detected: { label: "No damage", variant: "secondary" },
  damage_detected: { label: "Damage found", variant: "destructive" },
  manual_review_required: { label: "Check manually", variant: "outline" },
  recapture_required: { label: "Retake photo", variant: "outline" },
}

function plural(n: number, word: string) {
  const w = humanize(word).toLowerCase()
  return `${n} ${w}${n === 1 ? "" : w.endsWith("s") ? "es" : "s"}`
}

/** Condition record for the walk-around photos of a visit. */
export function ConditionPanel({
  condition,
  labels,
}: {
  condition: ConditionReport | null
  /** Optional names for each photo, e.g. Front / Rear. */
  labels?: string[]
}) {
  if (!condition)
    return (
      <p className="text-sm text-muted-foreground">
        No walk-around photos recorded.
      </p>
    )
  if (condition.status === "pending") {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-dashed bg-muted/30 px-4 py-3">
        <span className="size-4 shrink-0 animate-spin rounded-full border-2 border-primary/25 border-t-primary" />
        <span className="text-sm">
          <span className="font-medium">Checking walk-around photos for damage…</span>
          <span className="block text-xs text-muted-foreground">
            Runs in the background (about a minute). You can carry on with the
            advisor and job card.
          </span>
        </span>
      </div>
    )
  }
  if (!condition.available) {
    return (
      <p className="text-sm text-amber-600 dark:text-amber-400">
        Damage check unavailable. Please inspect the vehicle manually.
      </p>
    )
  }
  const counts = new Map<string, number>()
  const where: string[] = []
  condition.images.forEach((im, i) => {
    if (im.detections.length) where.push(labels?.[i] ?? `photo ${i + 1}`)
    for (const d of im.detections)
      counts.set(d.class_name, (counts.get(d.class_name) ?? 0) + 1)
  })
  const summary = counts.size
    ? `${[...counts].map(([k, n]) => plural(n, k)).join(", ")} found — ${where.join(", ")}`
    : "No damage found"
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">{summary}</p>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {condition.images.map((im, i) => (
          <div key={i} className="space-y-2 rounded-lg border p-2">
            <div className="flex items-center justify-between text-xs">
              <span>{labels?.[i] ?? `Photo ${i + 1}`}</span>
              <Badge variant={DECISION[im.decision]?.variant ?? "outline"}>
                {DECISION[im.decision]?.label ?? humanize(im.decision)}
              </Badge>
            </div>
            {im.annotated_url || im.photo_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={im.annotated_url ?? im.photo_url}
                alt={labels?.[i] ?? `Walk-around ${i + 1}`}
                className="w-full rounded-md"
              />
            ) : null}
            {im.detections.length ? (
              <div className="flex flex-wrap gap-1.5">
                {im.detections.map((d, j) => (
                  <Badge
                    key={j}
                    variant="outline"
                    className="gap-1.5 capitalize"
                  >
                    <ClassDot detection={d} />
                    {humanize(d.class_name)}
                  </Badge>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  )
}
