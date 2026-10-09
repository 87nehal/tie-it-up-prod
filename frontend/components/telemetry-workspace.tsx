"use client"

import * as React from "react"
import { HugeiconsIcon } from "@hugeicons/react"
import { File01Icon, Upload01Icon } from "@hugeicons/core-free-icons"
import { toast } from "sonner"

import {
  diagnoseTelemetry,
  getTelemetrySamples,
  type TelemetryReport,
  type TelemetrySample,
} from "@/lib/api"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from "@/components/ui/progress"
import { Textarea } from "@/components/ui/textarea"
import { service, type VehicleOption } from "@/lib/service-api"

export function TelemetryWorkspace() {
  const [samples, setSamples] = React.useState<TelemetrySample[]>([])
  const [csvText, setCsvText] = React.useState("")
  const [file, setFile] = React.useState<File | null>(null)
  const [result, setResult] = React.useState<TelemetryReport | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [drag, setDrag] = React.useState(false)
  const [error, setError] = React.useState("")
  const fileRef = React.useRef<HTMLInputElement>(null)
  const [vehicles, setVehicles] = React.useState<VehicleOption[]>([])
  const [vehicleId, setVehicleId] = React.useState<number | null>(null)

  React.useEffect(() => {
    getTelemetrySamples()
      .then(setSamples)
      .catch((err: Error) => setError(err.message))
    service
      .vehicles()
      .then(setVehicles)
      .catch(() => setVehicles([]))
  }, [])

  async function run(input: { sample?: string; csv?: string; upload?: File }) {
    setBusy(true)
    setError("")
    try {
      const data = await diagnoseTelemetry({
        sample: input.sample,
        csvText: input.csv,
        file: input.upload,
        vehicleId,
      })
      setResult(data)
      const v = vehicles.find((x) => x.id === data.attached_to)
      toast.success(
        v ? `Log scored and attached to ${v.reg_display}` : "Log scored"
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : "Scoring failed"
      setResult(null)
      setError(message)
      toast.error(message)
    } finally {
      setBusy(false)
    }
  }

  function clearAll() {
    setCsvText("")
    setFile(null)
    setResult(null)
    setError("")
    if (fileRef.current) fileRef.current.value = ""
  }

  const probability = result ? Number(result.issue_probability) : 0

  return (
    <div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
      <Card>
        <CardHeader>
          <CardTitle>Telemetry log</CardTitle>
          <CardDescription>
            Score a CSV against the engine-health classifier and safety rules
            (overheat, voltage, MIL).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <button
            type="button"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault()
              setDrag(true)
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDrag(false)
              const next = e.dataTransfer.files[0]
              if (next) setFile(next)
            }}
            className={`flex min-h-32 w-full flex-col items-center justify-center rounded-xl border border-dashed px-4 py-6 text-center transition-colors ${
              drag
                ? "border-foreground bg-muted/60"
                : "border-border bg-muted/30"
            }`}
          >
            <HugeiconsIcon
              icon={Upload01Icon}
              strokeWidth={2}
              className="mb-2 size-5 text-muted-foreground"
            />
            <p className="text-sm font-medium">Drop a CSV or click to browse</p>
            <p className="mt-1 text-xs text-muted-foreground">
              .csv, .txt, .log
            </p>
            {file ? (
              <p className="mt-3 font-mono text-xs break-all text-foreground">
                {file.name}
              </p>
            ) : null}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.txt,.log,text/csv"
            className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />

          <div>
            <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Built-in logs
            </p>
            <div className="flex flex-wrap gap-2">
              {samples.map((sample) => (
                <Button
                  key={sample.id}
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!sample.available || busy}
                  onClick={() => run({ sample: sample.id })}
                >
                  {sample.label}
                </Button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="attach">Attach result to vehicle (optional)</Label>
            <select
              id="attach"
              value={vehicleId ?? ""}
              onChange={(e) =>
                setVehicleId(e.target.value ? Number(e.target.value) : null)
              }
              className="h-9 w-full rounded-4xl border bg-background px-3 text-sm"
            >
              <option value="">Don&apos;t attach — just analyse</option>
              {vehicles.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.reg_display} · {v.model} · {v.customer_name}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              Attached findings feed service-due outreach and the vehicle&apos;s
              next Job Card.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="csv-text">Paste CSV</Label>
            <Textarea
              id="csv-text"
              rows={8}
              spellCheck={false}
              placeholder={"ENGINE_RPM,COOLANT_TEMPERATURE,\n800,82,"}
              value={csvText}
              onChange={(e) => setCsvText(e.target.value)}
              className="min-h-32 font-mono text-xs"
            />
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              className="flex-1"
              disabled={busy}
              onClick={() => {
                if (file) return run({ upload: file })
                if (csvText.trim()) return run({ csv: csvText })
                setError("Provide a CSV file, pasted text, or a sample log.")
              }}
            >
              {busy ? "Scoring…" : "Run analysis"}
            </Button>
            <Button variant="outline" disabled={busy} onClick={clearAll}>
              Reset
            </Button>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Column aliases include RPM, coolant/oil temperature,
            oil/fuel/coolant pressure, voltage, load, speed, and MIL fields.
          </p>
          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Unable to score log</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Assessment</CardTitle>
          <CardDescription>
            Issue probability is the mean classifier score across scored rows.
            Safety rules can raise a workshop recommendation independently.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {!result ? (
            <div className="flex h-56 flex-col items-center justify-center gap-2 text-muted-foreground">
              <HugeiconsIcon
                icon={File01Icon}
                strokeWidth={2}
                className="size-6"
              />
              <p className="text-sm">No log scored yet</p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl border bg-muted/20 p-4">
                  <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    Workshop visit
                  </p>
                  <p className="mt-1 text-lg font-semibold tracking-tight">
                    {result.needs_mechanic ? "Recommended" : "Not indicated"}
                  </p>
                  <Badge
                    variant={
                      result.needs_mechanic ? "destructive" : "secondary"
                    }
                    className="mt-2"
                  >
                    {result.mechanic_needed}
                  </Badge>
                </div>
                <div className="rounded-xl border bg-muted/20 p-4">
                  <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    Issue detected
                  </p>
                  <p className="mt-1 text-lg font-semibold tracking-tight">
                    {result.has_issue ? "Yes" : "No"}
                  </p>
                  <Badge
                    variant={result.has_issue ? "destructive" : "secondary"}
                    className="mt-2"
                  >
                    {result.issue}
                  </Badge>
                </div>
              </div>

              <Progress value={Math.round(probability * 100)}>
                <div className="flex w-full items-center">
                  <ProgressLabel>Issue probability</ProgressLabel>
                  <ProgressValue />
                </div>
              </Progress>

              <p className="text-sm leading-relaxed">{result.reason}</p>

              {result.rule_hits?.length ? (
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {result.rule_hits.map((h) => (
                    <li key={h}>{h}</li>
                  ))}
                </ul>
              ) : null}

              {result.attached ? (
                <Alert>
                  <AlertTitle>
                    Attached to{" "}
                    {
                      vehicles.find((v) => v.id === result.attached_to)
                        ?.reg_display
                    }
                  </AlertTitle>
                  <AlertDescription>
                    {result.attached.codes.length
                      ? `Mapped to demand codes ${result.attached.codes.join(", ")}; they will appear in Outreach and on the next Job Card.`
                      : "No workshop demand raised."}
                  </AlertDescription>
                </Alert>
              ) : null}

              <dl className="grid gap-4 sm:grid-cols-2">
                <div>
                  <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    Rows scored
                  </dt>
                  <dd className="mt-1 font-mono text-sm">{result.n_rows}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    Source
                  </dt>
                  <dd className="mt-1 font-mono text-sm break-all">
                    {result.source}
                  </dd>
                </div>
                <div className="sm:col-span-2">
                  <dt className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    Sensors used
                  </dt>
                  <dd className="mt-1 text-sm">
                    {(
                      result.used_sensor_labels ||
                      result.used_sensors ||
                      []
                    ).join(", ") || "—"}
                  </dd>
                </div>
              </dl>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
