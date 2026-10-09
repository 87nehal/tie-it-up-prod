# Dealer Service Platform (offline POC)

One FastAPI service and one Next.js UI that run the Maruti Suzuki DBP service
journey (twelve AI/ML use cases, outreach to Job Card) entirely on this machine.
It grew out of merging two systems, which remain the platform's core engines:

- the **OBD-II telemetry diagnosis backend** from `car-health-platform-main`, and
- the **vehicle dent/damage segmentation model** from `Port/vehicle-damage-segmentation`,

joined by the Hub Gate OCR, an offline ETA engine and the local Laya LLM.

```
prod/
  backend/    FastAPI app (app/) + vendored vehicle_damage package (src/) + models
  frontend/   Next.js 16 UI: dealer DMS modules (see "ERP structure") and the
              staff mobile app (/m)
  DEMO.md     presenter script for the customer demo
```

## Quick start (Windows PowerShell)

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
.\run_backend.ps1            # http://127.0.0.1:8000
```

In a second terminal:

```powershell
cd frontend
npm install
npm run dev:web              # http://localhost:3000
```

`npm run dev` alone will start the backend for you and wait until the pinned
checkpoint has loaded.

## What changed in the merge

- The old YOLOv8 damage path (`app/damage/infer.py`, `decide.py`, `annotate.py`,
  `models/damage/car_damage_yolo.pt`) is replaced by the DINOv2 ViT-S/14
  role-split segmentation model with its frozen calibration profile and
  SHA-256-pinned artifacts under `backend/runs/`.
- `app/routers/damage.py` now serves the segmentation report shape
  (`decision`, `quality`, `review_candidates`, `thresholds`, `runtime`) and keeps
  the bundled sample-image endpoints from the telemetry platform.
- The damage model no longer accepts a caller-supplied confidence threshold;
  thresholds come only from the frozen profile.
- Telemetry (`/api/telemetry/*`) is unchanged and shares the same process,
  port, and health endpoint as damage.

## Status

The damage checkpoint is development-only and not production approved; see
[backend/MODEL_CARD.md](backend/MODEL_CARD.md). Responses always carry
`model_status` and `production_approved: false`, and uncertain or low-quality
images are routed to `manual_review_required` / `recapture_required`.

## Cost comparison: local engines vs OpenAI and Anthropic

Local inference is not free: device depreciation, electricity, maintenance and
operating support must be included. The following is an **illustrative planning
estimate, not measured production costs or an accuracy benchmark**. API pricing
was checked on 2026-10-06. Neither frontier model has been benchmarked against
these workflows for equivalent output quality.

### Local infrastructure assumptions

| Local cost component | Assumption | Monthly cost |
|---|---|---:|
| Device depreciation | INR 120,000 device over 36 months, with no residual value | INR 3,333 |
| Electricity | 250 W average total draw, running 720 hours/month, INR 10/kWh | INR 1,800 |
| Maintenance reserve | Repairs and infrastructure upkeep | INR 1,500 |
| Operating support | Allocated support budget | INR 3,000 |
| **Total** | **240 productive processing hours/month** | **INR 9,633, approximately INR 40/hour** |

All amounts below are INR. The API conversion assumes **INR 90/USD** for planning;
it is not a live exchange-rate quote. Local task cost is allocated as
`INR 40 x processing seconds / 3,600`, including the idle-power and fixed-cost
allowance above. Task times are assumptions to replace with measurements on the
deployment device; allocating 240 hours does not establish that the device can
deliver any particular monthly throughput.

### Estimated cost per workflow execution

Text token counts are hypothetical input/output sizes for one standalone request.
Every photo is **1024 x 1024 pixels**; in photo rows the input count is additional
text, with image tokens charged separately. GPT-5.4 uses high image detail.
Costs include the assumed response, using standard uncached API rates without
batch discounts, tool fees, retries or additional reasoning tokens.

| Workflow / local engine | Assumed API input -> output tokens | OpenAI GPT-5.4 per task | Anthropic Claude Opus 5.5 per task | Local allocated cost per task |
|---|---|---:|---:|---|
| Damage detection - DINOv2 damage heads | 1 photo + 200 -> 250 | INR 0.659 | INR 1.015 | INR 0.33-1.33; 30-120 seconds |
| Image/damage categorisation - damage-type heads | 1 photo + 100 -> 100 | INR 0.434 | INR 0.709 | Included when produced by the same damage pass; do not charge it twice |
| Plate/VIN reading - local OCR and validation | 1 photo + 100 -> 100 | INR 0.434 | INR 0.709 | INR 0.011-0.033; 1-3 seconds |
| Odometer reading - OCR and candidate ranker | 1 photo + 100 -> 100 | INR 0.434 | INR 0.709 | INR 0.011-0.033; 1-3 seconds |
| Driver matching - small ranking model and eligibility rules | 2,000 -> 250 | INR 0.788 | INR 1.170 | Below INR 0.002; assumed under 0.1 seconds for ranking only |
| Advisor matching - small ranking model and eligibility rules | 2,000 -> 250 | INR 0.788 | INR 1.170 | Below INR 0.002; assumed under 0.1 seconds for ranking only |
| Concern interpretation - rules and local language model | 1,500 -> 500 | INR 1.012 | INR 1.440 | INR 0.056-0.222; 5-20 seconds |
| Job-card generation - structured builder and optional local language model | 3,000 -> 1,000 | INR 2.025 | INR 2.880 | INR 0.056-0.333; 5-30 seconds |
| Estimate calculation - catalogue, labour, tax and warranty rules | 2,000 -> 500 | INR 1.125 | INR 1.620 | Below INR 0.002; assumed under 0.1 seconds |
| Technician/bay allocation - skills and capacity rules | 2,000 -> 300 | INR 0.855 | INR 1.260 | Below INR 0.002; assumed under 0.1 seconds |
| Booking/slot selection - capacity and preference rules | 1,500 -> 200 | INR 0.608 | INR 0.900 | Below INR 0.002; assumed under 0.1 seconds |
| ETA calculation - offline distance/speed heuristic | 800 -> 100 | INR 0.315 | INR 0.468 | Below INR 0.002; assumed under 0.1 seconds |
| Telemetry assessment - classifier and sensor rules | 1,000 -> 200 | INR 0.495 | INR 0.720 | Below INR 0.002; assumed under 0.1 seconds |
| Service reminder/outreach - rules/templates and optional local wording | 1,000 -> 250 | INR 0.563 | INR 0.810 | INR 0.033-0.167; 3-15 seconds |

The local language model is Laya/Qwen3-4B. The cheapest local rows represent
rules or small-model scoring, not language-model generation. Optional generated
allocation explanations add local language-model time. Cold starts and model
switching can also add processing time. A frontier model can call the same
business tools; its token spend depends on how that integration is designed.

### Calculation and sources

- GPT-5.4: USD 2.50 per million input tokens and USD 15 per million output tokens.
  A 1024 x 1024 high-detail image uses approximately 1,229 input tokens.
  Sources: [OpenAI model pricing](https://developers.openai.com/api/docs/models/gpt-5.4)
  and [OpenAI image token calculation](https://developers.openai.com/api/docs/guides/images-vision).
- Claude Opus 5.5: USD 4 per million input tokens and USD 20 per million output
  tokens. A 1024 x 1024 image uses approximately 1,369 visual tokens.
  Sources: [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing)
  and [Anthropic image token calculation](https://platform.claude.com/docs/en/build-with-claude/vision).
- Example, one damage photo with 200 text input tokens and 250 output tokens:
  GPT-5.4 costs `((1,229 + 200) x 2.50 + 250 x 15) / 1,000,000 x 90`,
  approximately INR 0.659. Opus 5.5 costs
  `((1,369 + 200) x 4 + 250 x 20) / 1,000,000 x 90`, approximately INR 1.015.

### Interpreting the comparison

- **Utilisation matters:** at only 60 productive hours/month with the same monthly
  infrastructure cost, the local hourly rate and task costs are approximately 4x
  higher. Device price, power draw, support budget and task times are assumptions,
  not measurements from the current workstation.
- **Local is not always cheaper:** at the slower assumed damage-inference time,
  the allocated local cost exceeds GPT-5.4's illustrative API cost. Small-model
  matching and rule-based scheduling have much lower assumed compute costs.
- **Do not sum all rows for a visit:** concern interpretation, OCR and job-card
  generation may reuse results. Calculate a visit from the actual executed calls,
  photo count, retries, recaptures and shared passes.
- **Additional costs remain:** initial engineering/training, major retraining,
  backups, storage, shared application infrastructure, taxes, financing and human
  review are outside this illustrative inference comparison. Add the relevant
  costs to both deployment options for a full total-cost-of-ownership analysis.
  Cloud fallback, if enabled, adds its provider charges to the local option.
- **Cost does not establish quality:** damage remains development-only, matching
  models use synthetic training outcomes, and offline ETA has no live traffic.
  Measure workflow accuracy, latency and end-to-end cost before making a verified
  percentage-savings claim.

## Service journey (DBP use cases 1-12)

The platform's engines each exist once, and the dealer service journey is built on
top of them. Everything runs on this machine against one SQLite file
(`backend/data/dealer.db`); no cloud or third-party service is called.

| Engine (module) | Standalone screen | Used in the journey by |
|---|---|---|
| Telemetry model (`app/car_health`) | `/logs` | Outreach due scoring (UC1-2), Job Card concerns (UC9-11) |
| Damage model (`app/damage`, `src/vehicle_damage`) | `/inspection` | Reception walk-around (UC7), Job Card arrival record |
| Gate OCR + validation + trip log (`app/fleet`) | `/fleet` (Hub Gate) | Pickup handover (UC5), Reception gate-in (UC6) |
| Offline ETA (`app/eta`) | `/eta` | Booking chauffeur ranking (UC4), Pickup ETA (UC5) |
| Local LLM (`app/llm.py` -> `../laya`) | — | Concern interpretation (UC9), reminder wording (UC2) |

ERP structure (`frontend/components/erp`, `backend/app/erp.py`, `/api/erp/*`). The UI is
organised by DMS module around one record per vehicle and one work order pipeline per
outlet; ML runs behind the screens and only its outcomes are shown.

| Module | Route | Notes |
|---|---|---|
| Dashboard | `/` | outlet KPIs, pipeline, alerts, vehicles in workshop |
| Workshop board | `/workshop` | Expected → Arrived → Estimate → Approved → In bay → QC → Ready → Delivered |
| Appointments | `/appointments` | diary of customer bookings with AI-assigned advisor and chauffeur (UC3-4) |
| AI decisions | `/ai` | advisor/chauffeur matches, issue diagnosis, inspections, service due, models |
| Pickup & drop | `/pickups` | live pickup schedule and handover (UC5) |
| Reception | `/reception` | gate-in OCR, walk-around, advisor auto-assigned (UC6-8) |
| Job cards | `/job-cards` | suggested jobs, estimate, parts, bay/technician (UC9-12) |
| Customers & vehicles | `/vehicles`, `/vehicles/<id>` | Vehicle 360: history, job cards, invoices, activity |
| Service follow-up | `/crm` | service-due call list and next action (UC1-2) |
| Parts / Billing | `/parts`, `/billing` | stock & reservations; invoice & deliver |
| Masters & staff | `/admin` | advisors, technicians, drivers, bays, system services, utilities |
| Customer & staff app | `/m` | customer booking and car tracker; advisor arrival flow (plate/VIN/odometer/walk-around/signature), gate, driver, technician |

Booking is customer-facing: customers book in the mobile app (`/m` → Customer). The AI
engine (`backend/app/ai.py`) then assigns the chauffeur and the service advisor and
diagnoses the complaint. Every decision is stored with its evidence and shown on the
desktop **AI decisions** page (`/ai`): chosen candidate, reasons, all candidates with
predicted good-outcome probability, and a rationale written by Laya. Matching uses two
scikit-learn logistic-regression models (advisor fit, chauffeur fit) behind hard
eligibility rules. They are trained at start-up on a **synthetic** outcome history; for
production, retrain on logged assignments with CSAT and on-time outcomes.

`app/llm.py` calls the local Laya engine (`../laya`, :8100, `LAYA_URL`) first and only
falls back to Ollama Cloud when Laya is down. The first Laya call loads the 4B model
(~25 s); after that a call takes ~5 s and runs in the background.

The header carries the dealer/outlet context (outlet switcher), global search (reg no,
VIN, mobile, JC-n), notifications and the logged-in user. Only outlet DLR-0412 has demo
data. Old `/service/*` URLs redirect. Set `API_URL` to point the UI at another backend.

Shared building blocks: `app/db.py` (one database), `app/vehicles.py` (vehicle
master, also checked by the gate), `app/fleet/gate.py` (check-out/check-in used by
every gate), and on the frontend `components/common/` (`GateCapture`, `PhotoSlot`,
`CheckList`, damage findings, `RouteMap`) and `lib/format.ts`.

### Running the demo

`npm run dev` in `frontend/` starts the local LLM (if `../laya` exists), the backend
and the UI. Open http://localhost:3000; the Dashboard has **Reset demo day**, which
re-seeds the dealership relative to the current time. See [DEMO.md](DEMO.md) for the
presenter script.

Demo aids, all running through the real engines: generated gate photos
(`/api/service/demo/photos/...`) for the OCR, the bundled damage samples for the
walk-around, and demo OBD logs (`low_battery`, `mil_on`, `overheat`) on the
Telemetry page.

## Driver Allocation

Driver allocation is handled by `backend/app/service/scheduling.py` (`rank_drivers`, `book`) and exposed via `POST /drivers/rank` and `POST /appointments` in `backend/app/routers/service.py`.

### Eligibility (hard blockers)

A driver is excluded if any of the following apply:

| Condition | Rule |
|---|---|
| Off duty | `status == "off_duty"` |
| Already on a trip | `status == "on_trip"` |
| Daily trip limit reached | `trips_today >= max_trips` |
| Shift would overrun | Projected `trip_end > shift_end` |
| Blocked time window | `slot_start` falls inside driver's `blocked` JSON slots |

### Scoring (eligible drivers only)

Eligible drivers receive a weighted composite score (0–1):

| Factor | Weight | Formula |
|---|---|---|
| Proximity | 40% | `max(0, 1 - distance_km / 25)` |
| Acceptance rate | 25% | Historical acceptance rate |
| Workload | 20% | `1 - trips_today / max_trips` |
| Rating | 15% | `(rating - 3) / 2` (normalised 3–5 scale) |

### Assignment

- Eligible drivers are sorted by score, highest first.
- If no `driver_id` is provided → the top-ranked driver is auto-assigned.
- If `driver_id` is provided → it is validated against the eligible list.
- `trips_today` is incremented atomically at booking time to prevent double-booking.
- If no eligible driver exists, booking raises an error.

### Post-assignment lifecycle (`backend/app/service/eta.py`)

`dispatch()` sets the driver to `on_trip` and starts GPS tracking. `ping()` stores live coordinates. `_assess()` computes real-time ETA risk (`on_time` / `at_risk` / `late` / `no_signal`) and generates intervention hints (e.g. "Consider reassigning a closer chauffeur" if >10 min late). `handover()` validates the vehicle plate on arrival and closes the pickup leg.

The allocation is a **greedy single-pass rank-and-pick** — no LP solver or Hungarian method — designed for the single-dealership chauffeur pickup use case.

### Limits to state honestly

- Service-due, retention and ranking weights are hand-set priors; refit them on
  real outcomes. Labour times, parts and campaigns in `app/service/catalog.py`
  stand in for the DMS/EPC export.
- ETA has no live traffic: straight-line distance x road factor x an hourly speed
  profile. Messages go to a local outbox for the Suzuki app / CCE dialler rather
  than WhatsApp/SMS. Voice input needs an on-device speech-to-text model that is
  not bundled.
- On a CPU-only box the damage model takes 30 s-2 min per photo, so reception
  runs it in the background and the screen fills in when it finishes.
- The damage checkpoint remains development-only (see `backend/MODEL_CARD.md`).
