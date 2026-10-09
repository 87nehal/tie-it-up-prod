// Client for /api/service/* — the dealer service journey (DBP use cases 1-12).
// Gate, damage and telemetry types come from the platform client (./api): the
// journey is built on those engines, not on copies of them.

import { notifyDataChange } from "@/lib/demo-sync"
import {
  GateValidationError,
  type DamageDetection,
  type DamageReport,
  type GateCheck,
  type GateEntry,
  type GateValidation,
  type Trip,
} from "@/lib/api"

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/service${path}`, init)
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    const detail = data.detail as
      { validation?: GateValidation } | string | undefined
    if (
      res.status === 409 &&
      typeof detail === "object" &&
      detail?.validation
    ) {
      throw new GateValidationError(detail.validation)
    }
    throw new Error(
      typeof detail === "string"
        ? detail
        : JSON.stringify(detail ?? res.statusText)
    )
  }
  if (init?.method && init.method !== "GET") notifyDataChange()
  return data as T
}

function post<T>(path: string, body?: unknown, method = "POST") {
  return call<T>(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

// ---------------------------------------------------------------- shared

export type Telemetry = {
  has_issue: boolean
  issue_probability: number
  reason: string
  rule_hits: string[]
  used_sensors: string[]
  n_rows: number
  codes: string[]
  source: string
  diagnosed_at: string
}

export type VehicleOption = {
  id: number
  reg_no: string
  reg_display: string
  vin: string
  model: string
  fuel: string
  odometer: number
  customer_name: string
  phone: string
  language: string
  persona: string
  locality: string
  lat: number
  lng: number
  telemetry: Telemetry | null
}

export type JourneySummary = {
  appointments_today: number
  expected_at_gate: number
  pickups_live: number
  arrived_today: number
  job_cards: { draft: number; approved: number; released: number }
  queued_messages: number
  telemetry_flags: number
  seeded_at: string | null
}

// ------------------------------------------------------------ outreach (1, 2)

export type DueScore = {
  vehicle_id: number
  reg_no: string
  model: string
  customer_name: string
  persona: string
  language: string
  booked: boolean
  days_since: number
  km_since: number
  interval_ratio: number
  due_in_days: number
  due_date: string
  loyalty: number
  tele_flags: string[]
  telemetry: Telemetry | null
  due_probability: number
  retention_risk: number
  priority: number
  contributions: Record<string, number>
  reasons: string[]
}

export type DueList = {
  generated_at: string
  horizon_days: number
  model_note: string
  customers: DueScore[]
}

export type NextBestAction = {
  vehicle_id: number
  customer_name: string
  persona: string
  action: string
  channel: "app" | "call" | "in_dealer"
  offer: string | null
  send_at: string
  preferred_time: string
  language: string
  message: string
  message_engine: "template" | "ollama"
  score: DueScore
}

export type OutboxItem = {
  id: number
  vehicle_id: number
  reg_no: string
  customer_name: string
  action: string
  channel: string
  offer: string | null
  message: string
  status: string
  created_at: string
}

// ---------------------------------------------------------- booking (3, 4)

export type Slot = {
  start: string
  hour: number
  booked: number
  expected_load: number
  capacity: number
  utilisation: number
  feasible: boolean
  score: number
  off_peak: boolean
  offer: string | null
  reasons: string[]
  recommended_rank?: number
}

export type SlotDay = {
  date: string
  capacity_per_hour: number
  preferred_time: string | null
  slots: Slot[]
}

export type DriverRank = {
  driver_id: number
  name: string
  status: string
  distance_km: number
  eta_to_customer_min: number
  trip_to_dealer_min: number
  trips_today: number
  rating: number
  acceptance_rate: number
  eligible: boolean
  blockers: string[]
  score: number
  breakdown: Record<string, number>
}

export type DriverRanking = {
  feasible: boolean
  slot_start: string
  drivers: DriverRank[]
}

export type Appointment = {
  id: number
  vehicle_id: number
  slot_start: string
  mode: "walkin" | "pickup"
  status: string
  driver_id: number | null
  driver_name: string | null
  concerns: string
  qr_token: string
  reg_no: string
  model: string
  customer_name: string
}

// --------------------------------------------------------------- pickups (5)

export type PickupStatus = {
  appointment_id: number
  vehicle_id: number
  reg_no: string
  customer_name: string
  driver_id: number | null
  driver_name: string | null
  status:
    "booked" | "en_route" | "at_customer" | "collected" | "at_gate" | string
  promised_pickup: string
  leg?: "to_customer" | "handover" | "to_dealership" | "at_gate"
  position: { lat: number; lng: number } | null
  last_ping: string | null
  eta: string | null
  deadline?: string
  remaining_km: number | null
  buffer_min: number | null
  risk: "not_started" | "on_time" | "at_risk" | "late" | "no_signal"
  interventions: string[]
}

export type PickupBoard = {
  generated_at: string
  dealership: { name: string; lat: number; lng: number }
  model: string
  pickups: PickupStatus[]
}

// ------------------------------------------------------- reception (6, 7, 8)

export type ExpectedArrival = {
  id: number
  vehicle_id: number
  slot_start: string
  mode: string
  status: string
  qr_token: string
  reg_no: string
  reg_display: string
  model: string
  customer_name: string
  trip_id: number | null
}

export type ConditionImage = {
  decision: DamageReport["decision"]
  reason?: string
  n_detections?: number
  detections: DamageDetection[]
  photo_url?: string
  annotated_url?: string | null
}

export type ConditionReport = {
  status: "pending" | "done"
  available?: boolean
  error?: string
  summary?: string
  images: ConditionImage[]
}

export type Visit = {
  id: number
  appointment_id: number | null
  vehicle_id: number
  trip_id: number | null
  arrived_at: string
  odometer: number | null
  reg_no: string
  model: string
  customer_name: string
  language: string
  advisor_id: number | null
  advisor_name: string | null
  concerns: string | null
  status: string
  gate_checks: GateCheck[] | null
  condition: ConditionReport | null
  job_card?: { id: number; status: string } | null
}

export type AdvisorRank = {
  advisor_id: number
  name: string
  languages: string[]
  skills: string[]
  load_today: number
  max_load: number
  prior_visits: number
  available: boolean
  score: number
  breakdown: Record<string, number>
}

export type AdvisorRanking = {
  visit_id: number
  needs: string[]
  customer_language: string
  advisors: AdvisorRank[]
}

export type CheckInResult = {
  visit: Visit
  trip: Trip | null
  validation: GateValidation
  appointment: Appointment | null
  walk_in: boolean
  advisors: AdvisorRanking
}

// ------------------------------------------------- job card (9, 10, 11, 12)

export type Concern = {
  explanation?: string
  customer_words: string
  demand_code: string
  label: string
  system: string
  cause: string
  correction: string
  confidence: number
  source: string
}

export type Interpretation = {
  text: string
  engine: string
  llm_available: boolean
  concerns: Concern[]
  unmatched: string[]
  sufficient: boolean
  decision: "auto" | "manual_review"
  note: string | null
}

export type PartAvailability = {
  status: "available" | "alternative" | "transfer" | "order" | "unavailable"
  source: string | null
  eta_hours: number | null
  alternative?: string
  note?: string
  locations: {
    location: string
    label: string
    qty: number
    eta_hours: number
  }[]
}

export type EstimateLine = {
  id: string
  type: "labour" | "part"
  demand_code: string
  code: string
  desc: string
  qty: number
  unit_price: number
  amount: number
  payer: "customer" | "warranty" | "campaign"
  hours?: number
  skill?: string
  availability?: PartAvailability
  substituted_for?: string
}

type TechnicianPlan = {
  technician_id: number
  name: string
  skills: string[]
  certifications: string[]
  level: number
  load_hours_today: number
  free_at: string
  score: number
}

export type Allocation = {
  feasible: boolean
  reason?: string
  hours: number
  skills: string[]
  technician?: TechnicianPlan
  bay?: { bay_id: number; name: string; type: string; free_at: string }
  technicians?: TechnicianPlan[]
  start?: string
  end?: string
  promised_delivery?: string
}

export type JobCardPayload = {
  vehicle: {
    id: number
    reg_no: string
    vin: string
    model: string
    fuel: string
    sale_date: string
    odometer: number
    odometer_at_arrival: number
  }
  customer: { id: number; name: string; phone: string; language: string }
  appointment: Appointment | null
  visit_id: number | null
  condition: ConditionReport | null
  telemetry: Telemetry | null
  gate_checks: GateCheck[]
  history: {
    date: string
    km: number
    kind: string
    amount: number
    demand_codes: string[]
  }[]
  concern_text: string
  interpretation: Interpretation
  demand_codes: string[]
  removed: string[]
  estimate: {
    note?: string | null
    lines: EstimateLine[]
    warranty: {
      active: boolean
      age_years: number
      odometer: number
      limit: string
    }
    campaigns: { code: string; title: string }[]
    labour_hours: number
    totals: {
      labour: number
      parts: number
      gst: number
      customer_payable: number
      warranty_value: number
      campaign_value: number
    }
  }
  allocation: Allocation
  parts_blocking: boolean
  overrides?: { at: string; reason: string }[]
  reserved?: { part_no: string; location: string; qty: number }[]
  approved_at?: string
  released_at?: string
}

export type JobCard = {
  id: number
  visit_id: number | null
  vehicle_id: number
  status: "draft" | "approved" | "released"
  payload: JobCardPayload
  created_at: string
  updated_at: string
}

export type JobCardSummary = {
  id: number
  status: JobCard["status"]
  reg_no: string
  model: string
  customer_name: string
  customer_payable: number
  created_at: string
}

export type DemandCode = { code: string; label: string; system: string }

// ------------------------------------------------------------------ calls

export const service = {
  summary: () => call<JourneySummary>("/summary"),
  resetDemo: () => post<JourneySummary>("/demo/reset"),
  vehicles: (q = "") =>
    call<VehicleOption[]>(`/vehicles?q=${encodeURIComponent(q)}`),
  vehicle: (id: number) => call<VehicleOption>(`/vehicles/${id}`),

  due: (horizon = 30) => call<DueList>(`/outreach/due?horizon=${horizon}`),
  nba: (vehicleId: number, llm = false) =>
    call<NextBestAction>(`/outreach/${vehicleId}/nba?llm_rewrite=${llm}`),
  send: (
    body: Pick<
      NextBestAction,
      "vehicle_id" | "action" | "channel" | "offer" | "message"
    >
  ) => post<OutboxItem>("/outreach/send", body),
  outbox: () => call<OutboxItem[]>("/outreach/outbox"),

  slots: (date: string, vehicleId?: number, mode = "walkin") =>
    call<SlotDay>(
      `/slots?date=${date}&mode=${mode}${vehicleId ? `&vehicle_id=${vehicleId}` : ""}`
    ),
  rankDrivers: (vehicleId: number, slotStart: string) =>
    post<DriverRanking>("/drivers/rank", {
      vehicle_id: vehicleId,
      slot_start: slotStart,
    }),
  book: (body: {
    vehicle_id: number
    slot_start: string
    mode: "walkin" | "pickup"
    concerns: string
    driver_id?: number | null
  }) => post<Appointment>("/appointments", body),
  appointments: (date: string) =>
    call<Appointment[]>(`/appointments?date=${date}`),

  pickups: () => call<PickupBoard>("/pickups"),
  dispatch: (id: number) => post<PickupBoard>(`/pickups/${id}/dispatch`),
  handover: (id: number, entry: GateEntry & { service_pass?: string }) =>
    post<{ trip: Trip; validation: GateValidation; board: PickupBoard }>(
      `/pickups/${id}/handover`,
      entry
    ),
  simulate: (minutes: number) =>
    post<PickupBoard>(`/pickups/simulate?minutes=${minutes}`),

  expected: () => call<ExpectedArrival[]>("/reception/expected"),
  visits: () => call<Visit[]>("/reception/visits"),
  lookupQr: (token: string) =>
    call<VehicleOption & { appointment: Appointment }>(
      `/reception/qr/${encodeURIComponent(token)}`
    ),
  checkIn: (entry: GateEntry, files: File[]) => {
    const fd = new FormData()
    fd.append("plate", entry.plate)
    if (entry.vin) fd.append("vin", entry.vin)
    if (entry.odometer != null) fd.append("odometer", String(entry.odometer))
    if (entry.capture_id) fd.append("capture_id", entry.capture_id)
    for (const t of entry.photo_times ?? []) if (t) fd.append("photo_times", t)
    for (const f of files) fd.append("files", f)
    return call<CheckInResult>("/reception/check-in", {
      method: "POST",
      body: fd,
    })
  },
  visit: (visitId: number) => call<Visit>(`/visits/${visitId}`),
  advisors: (visitId: number) =>
    call<AdvisorRanking>(`/visits/${visitId}/advisors`),
  assign: (visitId: number, advisorId: number) =>
    post<Visit>(`/visits/${visitId}/assign`, { advisor_id: advisorId }),

  demandCodes: () => call<DemandCode[]>("/demand-codes"),
  interpret: (text: string, vehicleId?: number, useLlm = true) =>
    post<Interpretation>("/concerns/interpret", {
      text,
      vehicle_id: vehicleId,
      use_llm: useLlm,
    }),
  createJobCard: (body: {
    appointment_id?: number
    visit_id?: number
    text?: string
    use_llm?: boolean
  }) => post<JobCard>("/job-cards", body),
  jobCards: () => call<JobCardSummary[]>("/job-cards"),
  jobCard: (id: number) => call<JobCard>(`/job-cards/${id}`),
  revise: (
    id: number,
    body: {
      text?: string
      demand_codes?: string[]
      removed?: string[]
      override_reason?: string
    }
  ) => post<JobCard>(`/job-cards/${id}`, body, "PATCH"),
  approve: (id: number) => post<JobCard>(`/job-cards/${id}/approve`),
  release: (id: number) => post<JobCard>(`/job-cards/${id}/release`),
}
