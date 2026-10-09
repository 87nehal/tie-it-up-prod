// Client for /api/erp/* — outlet context, dashboard, workshop board, Vehicle 360,
// parts and billing. Work orders are the service journey's Job Cards.

import type { JobCard, Telemetry, VehicleOption } from "@/lib/service-api"
import { notifyDataChange } from "@/lib/demo-sync"

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/erp${path}`, init)
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    const detail = data.detail
    throw new Error(
      typeof detail === "string" ? detail : JSON.stringify(detail ?? res.statusText)
    )
  }
  if (init?.method && init.method !== "GET") notifyDataChange()
  return data as T
}

function post<T>(path: string, body?: unknown) {
  return call<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  })
}

export type Outlet = {
  id: number
  code: string
  name: string
  channel: "ARENA" | "NEXA"
  city: string
  region: string
  kind: string
  active: number
}

export type ErpContext = {
  dealer: { name: string; code: string; oem: string }
  outlet: Outlet
  outlets: Outlet[]
  user: { name: string; role: string; initials: string }
  business_date: string
}

export type Stage =
  | "expected"
  | "arrived"
  | "estimate"
  | "approved"
  | "in_progress"
  | "qc"
  | "ready"
  | "delivered"

export type BoardCard = {
  key: string
  stage: Stage
  vehicle_id: number
  reg_no: string
  reg_display: string
  model: string
  customer_name: string
  time: string
  detail: string
  mode?: "walkin" | "pickup"
  appointment_id?: number
  visit_id?: number
  advisor_name?: string | null
  job_card_id?: number
  amount?: number
  promised?: string | null
  technician?: string | null
  bay?: string | null
}

export type Board = {
  stages: { key: Stage; label: string; cards: BoardCard[] }[]
}

export type Dashboard = {
  kpis: {
    appointments_today: number
    expected: number
    in_workshop: number
    ready: number
    delivered: number
    revenue_today: number
    open_pipeline_value: number
    bay_utilisation: number
    technician_hours_booked: number
    technician_hours_available: number
    follow_ups_due: number
    pickups_live: number
    pickups_scheduled: number
  }
  pipeline: { key: Stage; label: string; count: number }[]
  alerts: { level: "error" | "warning" | "info"; text: string; vehicle_id: number }[]
  tomorrow: number
  /** what the intelligent assists did for the outlet today (use cases 1-12) */
  assists?: Record<string, number>
}

export type SearchHit = {
  kind: "vehicle" | "job_card"
  label: string
  sub?: string
  vehicle_id: number
  job_card_id?: number
}

export type CustomerRow = {
  id: number
  reg_no: string
  reg_display: string
  vin: string
  model: string
  fuel: string
  odometer: number
  customer_name: string
  phone: string
  locality: string
  last_service_date: string
  telemetry: Telemetry | null
  open_job_card: { id: number; status: string; stage: string | null } | null
}

export type Invoice = {
  id: number
  job_card_id: number
  vehicle_id: number
  number: string
  labour: number
  parts: number
  gst: number
  total: number
  paid: number
  payment_mode: string
  created_at: string
  reg_no?: string
  reg_display?: string
  model?: string
  customer_name?: string
}

export type Vehicle360 = {
  vehicle: VehicleOption & {
    sale_date: string
    last_service_date: string
    last_service_km: number
    avg_km_day: number
    preferred_channel: string
    preferred_time: string
  }
  job_cards: {
    id: number
    status: string
    stage: string
    amount: number
    demands: string[]
    promised: string | null
    created_at: string
    visit_id: number | null
  }[]
  open_job_card: Vehicle360["job_cards"][number] | null
  history: {
    id: number
    date: string
    km: number
    kind: string
    amount: number
    advisor_name: string | null
    demand_codes: string[]
  }[]
  appointments: {
    id: number
    qr_token: string
    slot_start: string
    mode: string
    status: string
    driver_name: string | null
    concerns: string
  }[]
  visits: {
    id: number
    arrived_at: string
    odometer: number
    advisor_name: string | null
    status: string
    inspection: {
      fuel: string | null
      checklist: Record<string, boolean>
      signature: string | null
      concerns: string | null
    } | null
  }[]
  invoices: Invoice[]
  inspections: DamageInspection[]
  messages: { id: number; channel: string; message: string; status: string; created_at: string }[]
  timeline: { at: string; kind: string; text: string }[]
  lifetime_value: number
}

export type WorkOrder = {
  job_card: JobCard
  wip: { stage: Stage; updated_at: string; history: { stage: Stage; at: string }[] } | null
  invoice: Invoice | null
}

export type PartsView = {
  locations: { key: string; label: string; eta_hours: number }[]
  items: {
    part_no: string
    name: string
    price: number
    stock: Record<string, number>
    reserved: number
    alt: string[]
  }[]
  reservations: {
    id: number
    job_card_id: number
    part_no: string
    name: string
    location: string
    qty: number
    vehicle_id: number
    reg_display: string
  }[]
}

export type DemoRole = "customer" | "driver" | "gate" | "advisor" | "technician" | "cashier"
export type DemoStep = { key: string; role: DemoRole; title: string; hint: string }
export type DemoCtx = {
  vehicle_id?: number
  reg?: string
  model?: string
  customer?: string
  driver?: string
  appointment_id?: number
  visit_id?: number
  job_card_id?: number
  [k: string]: unknown
}

export type StaffView = {
  advisors: { id: number; name: string; languages: string[]; skills: string[]; certifications: string[]; max_load: number; on_duty: number }[]
  technicians: { id: number; name: string; skills: string[]; certifications: string[]; level: number; on_duty: number }[]
  drivers: { id: number; name: string; status: string; rating: number; trips_today: number; max_trips: number; shift_end: string }[]
  bays: { id: number; name: string; type: string; active: number }[]
  others: { id: number; name: string; role: string }[]
}

export const STAGE_LABEL: Record<Stage, string> = {
  expected: "Expected",
  arrived: "Arrived",
  estimate: "Estimate",
  approved: "Approved",
  in_progress: "In bay",
  qc: "Quality check",
  ready: "Ready for delivery",
  delivered: "Delivered",
}

export const erp = {
  context: () => call<ErpContext>("/context"),
  dashboard: () => call<Dashboard>("/dashboard"),
  board: () => call<Board>("/board"),
  search: (q: string) => call<SearchHit[]>(`/search?q=${encodeURIComponent(q)}`),
  customers: (q = "") => call<CustomerRow[]>(`/customers?q=${encodeURIComponent(q)}`),
  vehicle: (id: number) => call<Vehicle360>(`/vehicles/${id}`),
  workOrder: (id: number) => call<WorkOrder>(`/work-orders/${id}`),
  advance: (id: number) => post<WorkOrder>(`/work-orders/${id}/advance`),
  /** Move to a bay; omit bayId to pull into the next free bay. */
  moveBay: (id: number, bayId?: number) => post<WorkOrder>(`/work-orders/${id}/bay`, { bay_id: bayId ?? null }),
  deliver: (id: number, payment_mode = "UPI") =>
    post<WorkOrder>(`/work-orders/${id}/deliver`, { payment_mode }),
  parts: () => call<PartsView>("/parts"),
  invoices: () => call<{ invoices: Invoice[]; ready_to_bill: BoardCard[]; gst_rate: number }>("/invoices"),
  staff: () => call<StaffView>("/staff"),
  saveInspection: (
    visitId: number,
    body: { fuel?: string | null; checklist?: Record<string, boolean>; signature?: string | null; concerns?: string | null }
  ) => post<{ visit_id: number }>(`/visits/${visitId}/inspection`, body),
  gateOut: (
    vehicleId: number,
    capture: { plate?: string | null; vin?: string | null; odometer?: number | null; by?: string } = {}
  ) =>
    post<{
      vehicle_id: number
      job_card_id: number
      at: string
      checks: { level: "ok" | "warning"; message: string }[]
    }>(`/vehicles/${vehicleId}/gate-out`, { by: "Security", ...capture }),
  gateOutsToday: () => call<{ vehicle_id: number; job_card_id: number; at: string; odometer: number | null }[]>("/gate-outs/today"),
  journey: (vehicleId: number) => call<Journey>(`/vehicles/${vehicleId}/journey`),
  journeyCounts: () => call<JourneyCounts>("/journey/counts"),
  demoGuide: () => call<GuideItem[]>("/demo/guide"),
  demoSteps: () => call<DemoStep[]>("/demo/journey"),
  demoProgress: (ctx: DemoCtx) => post<{ ctx: DemoCtx; done: string[] }>("/demo/journey/progress", { step: "", ctx }),
  demoRun: (step: string, ctx: DemoCtx) => post<{ ctx: DemoCtx; note: string }>("/demo/journey", { step, ctx }),
}

// ------------------------------------------------------------ service journey

export type JourneyStep =
  | "follow_up"
  | "appointment"
  | "pickup"
  | "arrival"
  | "job_card"
  | "workshop"
  | "delivery"

export type JourneyCounts = Record<JourneyStep, number>

/** An intelligent assist (use case 1-12) that has worked on a vehicle, and its outcome. */
export type Assist = {
  uc: number
  title: string
  outcome: string
  confidence?: number | null
  decision_id?: number | null
  review?: boolean
}

export type Journey = {
  vehicle: {
    id: number
    reg_no: string
    reg_display: string
    model: string
    fuel: string
    customer_name: string
    phone: string
    odometer: number
  }
  step: JourneyStep
  step_n: number
  status: string
  next: { label: string; href: string } | null
  appointment_id: number | null
  visit_id: number | null
  job_card_id: number | null
  invoice: string | null
  advisor: string | null
  driver: string | null
  promised: string | null
  assists: Assist[]
}

export type GuideItem = {
  uc: number | null
  title: string
  step: JourneyStep
  what: string
  href: string
  vehicle_id: number | null
  reg_display: string | null
}

// ------------------------------------------------------------ AI decisions

export type Candidate = {
  id: number
  name: string
  eligible: boolean
  blockers: string[]
  p_good: number
  features: Record<string, number>
  contributions: Record<string, number>
  for: string[]
  against: string[]
  facts: string[]
  eta_to_customer_min?: number
  distance_km?: number
}

export type DiagnosisFinding = {
  complaint: string
  likely_cause: string
  why: string
  check_first: string
  demand_code?: string
}

export type AiDecision = {
  id: number
  kind: "advisor" | "chauffeur" | "diagnosis" | "inspection"
  vehicle_id: number
  appointment_id: number | null
  visit_id: number | null
  chosen_id: number | null
  chosen_name: string | null
  confidence: number | null
  summary: string
  reasons: string[]
  alternatives: Candidate[]
  evidence: Record<string, unknown> & {
    findings?: DiagnosisFinding[]
    llm_findings?: DiagnosisFinding[]
    model?: ModelCard
  }
  narrative: string | null
  engine: string
  status: "pending" | "done"
  created_at: string
  reg_no?: string
  reg_display?: string
  model?: string
  customer_name?: string
}

export type ModelCard = {
  kind: string
  algorithm: string
  trained_on: string
  holdout_auc: number
  weights: Record<string, number>
}

export type ServiceDueRow = {
  vehicle_id: number
  reg_no: string
  model: string
  customer_name: string
  due_date: string
  due_in_days: number
  priority: "High" | "Medium" | "Low"
  due_probability: number
  retention_risk: number
  reasons: string[]
  booked: boolean
  contributions: Record<string, number>
}

export type SlotOption = {
  start: string
  hour: number
  booked: number
  capacity: number
  feasible: boolean
  offer: string | null
  reasons: string[]
  recommended_rank?: number
}

export type BookingResult = {
  appointment: {
    id: number
    slot_start: string
    mode: "walkin" | "pickup"
    qr_token: string
    reg_no: string
    model: string
    customer_name: string
    driver_name: string | null
  }
  advisor: AiDecision | null
  chauffeur: AiDecision | null
  diagnosis: AiDecision | null
}

export const ai = {
  decisions: (kind?: AiDecision["kind"]) =>
    call<AiDecision[]>(`/ai/decisions${kind ? `?kind=${kind}` : ""}`),
  serviceDue: () => call<ServiceDueRow[]>("/ai/service-due"),
  models: () => call<ModelCard[]>("/ai/models"),
  diagnose: (vehicleId: number, text: string) => post<AiDecision>(`/ai/diagnose/${vehicleId}`, { text }),
  inspection: (visitId: number) => post<AiDecision>(`/ai/inspection/${visitId}`),
  slots: (vehicleId: number, date: string, mode: "walkin" | "pickup") =>
    call<{ date: string; slots: SlotOption[] }>(`/vehicles/${vehicleId}/slots?date=${date}&mode=${mode}`),
  book: (body: { vehicle_id: number; slot_start: string; mode: "walkin" | "pickup"; concerns: string }) =>
    post<BookingResult>("/bookings", body),
  booking: (appointmentId: number) =>
    call<Omit<BookingResult, "appointment">>(`/bookings/${appointmentId}`),
}

// ------------------------------------------------------- damage inspection

export type InspectionPhoto = {
  index: number
  angle: string
  status: "queued" | "assessing" | "done"
  decision?: "damage_detected" | "no_damage_detected" | "manual_review_required" | "recapture_required"
  result?: string
  reason?: string
  damage?: { type: string; size_pct: number }[]
  photo_url: string
  annotated_url?: string | null
  seconds?: number
}

export type DamageInspection = {
  id: number
  vehicle_id: number | null
  visit_id: number | null
  status: "running" | "done"
  photos: InspectionPhoto[]
  progress: { done: number; total: number }
  summary: string
  note: {
    summary: string
    findings: { area: string; damage: string; action: string }[]
    customer_note: string
  } | null
  engine: string | null
  reg_no: string | null
  model: string | null
  customer_name: string | null
  created_at: string
}

export const inspections = {
  create: (opts: { vehicleId?: number | null; visitId?: number | null }, photos: { angle: string; file: File }[]) => {
    const fd = new FormData()
    if (opts.vehicleId) fd.append("vehicle_id", String(opts.vehicleId))
    if (opts.visitId) fd.append("visit_id", String(opts.visitId))
    for (const p of photos) {
      fd.append("angles", p.angle)
      fd.append("files", p.file)
    }
    return call<DamageInspection>("/inspections", { method: "POST", body: fd })
  },
  get: (id: number) => call<DamageInspection>(`/inspections/${id}`),
}
