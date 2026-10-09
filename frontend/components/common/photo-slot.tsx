"use client"

import * as React from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { Camera01Icon, Delete02Icon } from "@hugeicons/core-free-icons"

/** One camera/upload tile with preview; used by every gate and walk-around capture. */
export function PhotoSlot({
  label,
  hint,
  file,
  onChange,
  disabled,
}: {
  label: string
  hint: string
  file: File | null
  onChange: (f: File | null) => void
  disabled?: boolean
}) {
  const ref = React.useRef<HTMLInputElement>(null)
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

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        disabled={disabled}
        onClick={() => ref.current?.click()}
        className="relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-xl border border-dashed border-border bg-muted/30 text-center transition-colors hover:bg-muted/60"
      >
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={label} className="size-full object-cover" />
        ) : (
          <span className="flex flex-col items-center gap-1 px-2">
            <HugeiconsIcon
              icon={Camera01Icon}
              strokeWidth={2}
              className="size-5 text-muted-foreground"
            />
            <span className="text-xs text-muted-foreground">{hint}</span>
          </span>
        )}
      </button>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">{label}</span>
        {file ? (
          <button
            type="button"
            aria-label={`Remove ${label} photo`}
            onClick={() => {
              onChange(null)
              if (ref.current) ref.current.value = ""
            }}
            className="text-muted-foreground hover:text-foreground"
          >
            <HugeiconsIcon
              icon={Delete02Icon}
              strokeWidth={2}
              className="size-3.5"
            />
          </button>
        ) : null}
      </div>
      <input
        ref={ref}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        className="hidden"
        onChange={(e) => onChange(e.target.files?.[0] ?? null)}
      />
    </div>
  )
}

/** Fetch an image URL (demo photo, bundled sample) as a File for a PhotoSlot. */
export async function urlToFile(url: string, name: string) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Could not load ${name}`)
  return new File([await res.blob()], name, { type: "image/jpeg" })
}
