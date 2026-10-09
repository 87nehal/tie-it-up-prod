"use client"

import * as React from "react"

export function SignaturePad({
  onChange,
  value = null,
}: {
  onChange: (dataUrl: string | null) => void
  value?: string | null
}) {
  const ref = React.useRef<HTMLCanvasElement>(null)
  const drawing = React.useRef(false)
  const [signed, setSigned] = React.useState(!!value)

  React.useEffect(() => {
    const c = ref.current
    if (!c) return
    const ratio = window.devicePixelRatio || 1
    c.width = c.offsetWidth * ratio
    c.height = c.offsetHeight * ratio
    const ctx = c.getContext("2d")
    if (!ctx) return
    ctx.scale(ratio, ratio)
    ctx.lineWidth = 2.2
    ctx.lineCap = "round"
    ctx.lineJoin = "round"
    ctx.strokeStyle = "#0f172a"
    if (value) {
      const image = new Image()
      image.onload = () =>
        ctx.drawImage(image, 0, 0, c.offsetWidth, c.offsetHeight)
      image.src = value
    }
    // Restore the saved signature when returning to this step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  const clear = () => {
    const c = ref.current
    const ctx = c?.getContext("2d")
    if (!c || !ctx) return
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, c.width, c.height)
    ctx.restore()
    setSigned(false)
    onChange(null)
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="relative">
        <canvas
          ref={ref}
          className="h-40 w-full touch-none rounded-xl border bg-white"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            drawing.current = true
            const ctx = e.currentTarget.getContext("2d")
            const p = point(e)
            ctx?.beginPath()
            ctx?.moveTo(p.x, p.y)
          }}
          onPointerMove={(e) => {
            if (!drawing.current) return
            const ctx = e.currentTarget.getContext("2d")
            const p = point(e)
            ctx?.lineTo(p.x, p.y)
            ctx?.stroke()
          }}
          onPointerUp={(e) => {
            if (!drawing.current) return
            drawing.current = false
            setSigned(true)
            onChange(e.currentTarget.toDataURL("image/png"))
          }}
          onPointerCancel={() => {
            drawing.current = false
          }}
        />
        {!signed && (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-slate-400">
            Customer signs here
          </span>
        )}
        <div className="pointer-events-none absolute inset-x-6 bottom-8 border-b border-dashed border-slate-300" />
      </div>
      <div className="flex justify-between px-1 text-xs text-muted-foreground">
        <span>I confirm the vehicle condition recorded above.</span>
        <button
          type="button"
          className="min-h-11 shrink-0 px-3 font-medium text-primary"
          onClick={clear}
        >
          Clear
        </button>
      </div>
    </div>
  )
}
