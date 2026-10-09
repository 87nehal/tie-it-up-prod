import type { DamageDetection, DamageReport } from "@/lib/api"
import { humanize } from "@/lib/format"
import { Badge } from "@/components/ui/badge"
import { TableCell, TableRow } from "@/components/ui/table"

export const CLASS_COLORS: Record<string, string> = {
  dent: "#ea580c",
  scratch: "#0284c7",
  crack_or_breakage: "#dc2626",
  paint_damage: "#ca8a04",
  deformation_or_detachment: "#9333ea",
}

export const DECISION_LABELS: Record<DamageReport["decision"], string> = {
  damage_detected: "Damage detected",
  no_damage_detected: "No damage detected",
  manual_review_required: "Manual review required",
  recapture_required: "Recapture required",
}

export function decisionTone(
  decision: DamageReport["decision"]
): "ok" | "bad" | "warn" {
  if (decision === "no_damage_detected") return "ok"
  if (decision === "manual_review_required") return "warn"
  return "bad"
}

export function DecisionBadge({
  decision,
}: {
  decision: DamageReport["decision"]
}) {
  const tone = decisionTone(decision)
  return (
    <Badge
      variant={
        tone === "ok"
          ? "secondary"
          : tone === "warn"
            ? "outline"
            : "destructive"
      }
    >
      {DECISION_LABELS[decision] ?? humanize(decision)}
    </Badge>
  )
}

export function ClassDot({ detection }: { detection: DamageDetection }) {
  return (
    <span
      className="size-2 rounded-full"
      style={{
        background:
          detection.kind === "triage_only"
            ? "#f59e0b"
            : CLASS_COLORS[detection.class_name] || "#64748b",
      }}
    />
  )
}

export function FindingRow({ detection }: { detection: DamageDetection }) {
  return (
    <TableRow>
      <TableCell>
        <span className="inline-flex items-center gap-2 capitalize">
          <ClassDot detection={detection} />
          {humanize(detection.class_name)}
        </span>
      </TableCell>
      <TableCell>
        <Badge variant="outline">
          {detection.kind === "triage_only" ? "Review only" : "Precise mask"}
        </Badge>
      </TableCell>
      <TableCell className="font-mono tabular-nums">
        {detection.score.toFixed(3)}
      </TableCell>
      <TableCell className="font-mono tabular-nums">
        {detection.area_frac == null
          ? "-"
          : `${(detection.area_frac * 100).toFixed(2)}%`}
      </TableCell>
    </TableRow>
  )
}

/** Compact list of detections, for places that show several photos at once. */
export function FindingChips({
  detections,
}: {
  detections: DamageDetection[]
}) {
  if (!detections.length) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {detections.map((d, i) => (
        <Badge key={i} variant="outline" className="gap-1.5 capitalize">
          <ClassDot detection={d} />
          {humanize(d.class_name)} {d.score.toFixed(2)}
        </Badge>
      ))}
    </div>
  )
}
