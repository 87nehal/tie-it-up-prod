import { HugeiconsIcon } from "@hugeicons/react"
import { Alert02Icon, CheckmarkCircle02Icon } from "@hugeicons/core-free-icons"

import type { GateCheck as Check } from "@/lib/api"
import { cn } from "@/lib/utils"

export type { Check }

/** Validation results from the gate (or any rule set): ok / warning / error. */
export function CheckList({ checks }: { checks: Check[] }) {
  if (!checks.length) return null
  return (
    <ul className="space-y-2 text-sm">
      {checks.map((c, i) => (
        <li key={`${c.code}-${i}`} className="flex gap-2">
          <HugeiconsIcon
            icon={c.level === "ok" ? CheckmarkCircle02Icon : Alert02Icon}
            strokeWidth={2}
            className={cn(
              "mt-0.5 size-4 shrink-0",
              c.level === "ok" && "text-emerald-600 dark:text-emerald-400",
              c.level === "warning" && "text-amber-600 dark:text-amber-400",
              c.level === "error" && "text-destructive"
            )}
          />
          <span>{c.message}</span>
        </li>
      ))}
    </ul>
  )
}
