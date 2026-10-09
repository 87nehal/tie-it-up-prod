export type HealthResponse = {
  ok: boolean
  telemetry?: {
    ok?: boolean
    model_exists?: boolean
    error?: string | null
  }
  damage?: {
    ok?: boolean
    weights_exist?: boolean
    model_loaded?: boolean
    cuda?: boolean
    device?: string
    model_status?: string
    production_approved?: boolean
    triage_threshold?: number
    segmentation_threshold?: number
    error?: string | null
  }
  ocr?: {
    ok?: boolean
    engine?: string
    loaded?: boolean
    error?: string | null
  }
  llm?: {
    ok?: boolean
    engine?: string
    model?: string
    configured?: boolean
    url?: string
    available?: boolean
    warm?: boolean
  }
  eta?: { ok?: boolean; engine?: string }
  error?: string
}

export type DamageSample = {
  id: string
  file: string
  label: string
  expected_damage: boolean
  url: string
}

export type DamageDetection = {
  class_name: string
  score: number
  bbox?: number[] | null
  area_frac?: number | null
  area_pixels?: number
  kind: "segmentation" | "triage_only"
}

export type DamageReport = {
  model_status: string
  production_approved: boolean
  decision:
    | "damage_detected"
    | "no_damage_detected"
    | "manual_review_required"
    | "recapture_required"
  automated_decision_allowed: boolean
  manual_review_required: boolean
  recapture_required: boolean
  decision_reasons: string[]
  recapture_reasons: string[]
  damage_present: boolean
  triage_alert: boolean
  high_confidence_alert: boolean
  reason: string
  n_detections: number
  detections: DamageDetection[]
  review_candidates: DamageDetection[]
  quality: {
    width: number
    height: number
    dark_fraction: number
    clipped_highlight_fraction: number
    specular_highlight_fraction: number
    sharpness: number
    review_reasons: string[]
  }
  runtime: { device: string; elapsed_ms: number }
  thresholds: { triage: number; segmentation: number }
  annotated_jpeg_b64?: string
}

export type TelemetrySample = {
  id: string
  label: string
  available: boolean
}

export type TelemetryReport = {
  has_issue: boolean
  needs_mechanic: boolean
  issue: string
  mechanic_needed: string
  issue_probability: number
  reason: string
  n_rows: number
  used_sensors: string[]
  used_sensor_labels?: string[]
  rule_hits?: string[]
  source: string
  attached_to?: number
  attached?: { codes: string[]; diagnosed_at: string }
}

async function readJson<T>(res: Response): Promise<T> {
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    const detail = data.detail ?? data.error ?? data.message ?? res.statusText
    throw new Error(
      typeof detail === "string" ? detail : JSON.stringify(detail)
    )
  }
  return data as T
}

export async function getHealth() {
  const res = await fetch("/api/health")
  return readJson<HealthResponse>(res)
}

export async function getDamageSamples() {
  const res = await fetch("/api/damage/samples")
  return readJson<DamageSample[]>(res)
}

export async function predictDamageFile(file: File) {
  const fd = new FormData()
  fd.append("file", file)
  const res = await fetch("/api/damage/predict", {
    method: "POST",
    body: fd,
  })
  return readJson<DamageReport>(res)
}

export async function getTelemetrySamples() {
  const res = await fetch("/api/telemetry/samples")
  return readJson<TelemetrySample[]>(res)
}

export async function diagnoseTelemetry(input: {
  sample?: string
  csvText?: string
  file?: File
  /** Also store the result as this vehicle's current telemetry. */
  vehicleId?: number | null
}) {
  if (input.file) {
    const fd = new FormData()
    fd.append("file", input.file)
    if (input.vehicleId) fd.append("vehicle_id", String(input.vehicleId))
    const res = await fetch("/api/telemetry/diagnose", {
      method: "POST",
      body: fd,
    })
    return readJson<TelemetryReport>(res)
  }
  const res = await fetch("/api/telemetry/diagnose", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sample: input.sample,
      csv_text: input.csvText,
      vehicle_id: input.vehicleId ?? undefined,
    }),
  })
  return readJson<TelemetryReport>(res)
}

// ------------------------------------------------------------ Hub gate (OCR)

export type GateDirection = "checkout" | "checkin"

export type OcrField<T> = {
  value: T
  confidence: number
  image: number
  display?: string
  check_digit_ok?: boolean
  read_length?: number
  source_text?: string
} | null

export type GateExtract = {
  capture_id: string
  processed_at: string
  fields: {
    vin: OcrField<string>
    plate: OcrField<string>
    odometer: OcrField<number>
  }
  images: {
    index: number
    name: string
    taken_at: string | null
    lines: { text: string; confidence: number }[]
  }[]
}

export type GateCheck = {
  code: string
  level: "ok" | "warning" | "error"
  message: string
}

export type GateValidation = {
  direction: GateDirection
  ok: boolean
  checked_at: string
  checks: GateCheck[]
  distance_km: number | null
}

export type GateEntry = {
  plate: string
  vin?: string | null
  odometer?: number | null
  capture_id?: string | null
  photo_times?: (string | null)[]
  confidences?: Record<string, number | null>
}

export type Trip = {
  id: number
  plate: string
  plate_display: string
  vin: string | null
  checkout_at: string
  checkout_odo: number
  checkout_capture: string | null
  checkin_at: string | null
  checkin_odo: number | null
  checkin_capture: string | null
  distance_km: number | null
  status: "out" | "returned"
  purpose: "fleet" | "pickup"
  appointment_id: number | null
  flags: GateCheck[]
}

export type TripDay = {
  date: string
  trips: Trip[]
  summary: {
    out: number
    returned: number
    distance_km: number
    flagged: number
  }
}

export class GateValidationError extends Error {
  validation: GateValidation
  constructor(validation: GateValidation) {
    super("Validation failed")
    this.validation = validation
  }
}

export async function extractGate(files: File[]) {
  const fd = new FormData()
  for (const f of files) fd.append("files", f)
  const res = await fetch("/api/fleet/extract", { method: "POST", body: fd })
  return readJson<GateExtract>(res)
}

export async function validateGate(
  direction: GateDirection,
  entry: GateEntry,
  walkIn = false
) {
  const res = await fetch(
    `/api/fleet/validate/${direction}?walk_in=${walkIn}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    }
  )
  return readJson<GateValidation>(res)
}

export async function commitGate(direction: GateDirection, entry: GateEntry) {
  const res = await fetch(`/api/fleet/${direction}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(entry),
  })
  if (res.status === 409) {
    const data = await res.json()
    throw new GateValidationError(data.detail.validation)
  }
  return readJson<{ trip: Trip; validation: GateValidation }>(res)
}

export async function getTrips(date?: string) {
  const res = await fetch(`/api/fleet/trips${date ? `?date=${date}` : ""}`)
  return readJson<TripDay>(res)
}

// ------------------------------------------------------------ ETA (offline)

export type Place = { name: string; lat: number; lng: number }

export type EtaMode = "DRIVE" | "TWO_WHEELER" | "BICYCLE" | "WALK"

export type EtaEstimate = {
  origin: Place
  destination: Place
  mode: EtaMode
  distance_km: number
  duration_min: number
  free_flow_min: number
  traffic_delay_min: number
  depart_at: string
  arrive_at: string
  speed_profile: "time-of-day" | "constant"
  model: string
}

export async function searchPlaces(q: string) {
  const res = await fetch(`/api/eta/places?q=${encodeURIComponent(q)}`)
  return readJson<Place[]>(res)
}

export async function estimateEta(body: {
  origin: string
  destination: string
  mode: EtaMode
  depart_at?: string
}) {
  const res = await fetch("/api/eta/estimate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  return readJson<EtaEstimate>(res)
}
