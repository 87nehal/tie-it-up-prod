# Car Health Platform — backend

One FastAPI service that merges two models:

- **Telemetry diagnosis** (`app/car_health`, `models/telemetry/car_health.joblib`) — OBD-II
  CSV in, issue/mechanic verdict out. Imputer → RobustScaler → RandomForest plus
  deterministic safety rules (overheat, battery/charging voltage, MIL).
- **Damage segmentation** (`src/vehicle_damage`, `runs/`) — DINOv2 ViT-S/14 role-split
  segmenter with a frozen calibration profile, tiled multi-scale inference, quality
  gating, and fail-closed routing.

## Run

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
.\run_backend.ps1            # http://127.0.0.1:8000
```

Equivalent: `python -m app.main`, or
`python -m uvicorn app.main:app --host 127.0.0.1 --port 8000` with
`PYTHONPATH=src`.

## Environment

| Variable                  | Default     | Meaning                                       |
| ------------------------- | ----------- | --------------------------------------------- |
| `CAR_HEALTH_API_HOST`     | `127.0.0.1` | Bind host                                     |
| `CAR_HEALTH_API_PORT`     | `8000`      | Bind port                                     |
| `VEHICLE_DAMAGE_BACKEND`  | `auto`      | `auto`, `torch` (CUDA FP16), or `onnx`        |
| `VEHICLE_DAMAGE_DEVICE`   | `auto`      | `cuda`, `gpu`, `npu`, `cpu`                   |

| `OLLAMA_API_KEY`          | —           | Ollama Cloud key; without it the LLM is off   |
| `OLLAMA_MODEL`            | `gpt-oss:120b` | Cloud model for concerns and outreach      |
| `OLLAMA_URL`              | `https://ollama.com/api` | Ollama API base                  |
| `LLM_DISABLED`            | —           | `1` forces the rules / template paths         |

`auto` uses the calibrated PyTorch FP16 path on CUDA and ONNX Runtime elsewhere.

The `OLLAMA_*` values can also go in `backend/.env` (`KEY=value` lines, git-ignored);
real environment variables take precedence. The LLM is optional: concern interpretation
and outreach messages fall back to rules and templates when it is unset or unreachable.

## API

| Endpoint                                  | Method | Purpose                                      |
| ----------------------------------------- | ------ | -------------------------------------------- |
| `/api/health`                             | GET    | Combined telemetry + damage status           |
| `/api/damage/health`                      | GET    | Checkpoint hashes, backend, thresholds       |
| `/api/damage/samples`                     | GET    | Bundled inspection images                    |
| `/api/damage/file/sample/{id}`            | GET    | Download a sample image                      |
| `/api/damage/predict`                     | POST   | Multipart `file` (JPEG/PNG/WebP, ≤20 MB)     |
| `/api/damage/predict/sample/{id}`         | GET    | Run inference on a bundled sample            |
| `/api/telemetry/health`                   | GET    | Telemetry model status                       |
| `/api/telemetry/samples`                  | GET    | Bundled telemetry CSVs                       |
| `/api/telemetry/samples/{id}/download`    | GET    | Download a sample CSV                        |
| `/api/telemetry/template`                 | GET    | Empty CSV column template                    |
| `/api/telemetry/diagnose`                 | POST   | CSV upload, pasted text, or sample id        |

If `../frontend/out` exists (a static `next build` export) it is mounted at `/`.

## Layout

```
app/                  FastAPI layer
  car_health/         telemetry feature mapping + diagnosis
  damage/service.py   lazy, hash-verified damage predictor
  routers/            /api/telemetry and /api/damage
src/vehicle_damage/   segmentation model, inference, calibration, ONNX backend
runs/                 pinned checkpoint, calibration profile, exported ONNX
models/telemetry/     sklearn bundle + training metrics
samples/              telemetry CSVs and damage images
```

## Odometer reading (hub gate)

A cluster photo shows many numbers (dial scale, trip, clock, range, temperature), so
the odometer is found by two trained models on top of RapidOCR:

- `models/odometer/cluster_reader.onnx` — CRNN that re-reads each OCR box; trained on
  rendered seven-segment / LCD / TFT text (`scripts/train_reader.py`).
- `models/odometer/odometer_ranker.joblib` — gradient-boosted ranker that scores every
  number on size, LCD background, nearby words, dial-scale pattern and both engines'
  reads (`scripts/train_odometer.py`, data from `scripts/odometer_synth.py`).

Without these files the gate falls back to the rule-based picker in `app/fleet/extract.py`.
Metrics are in `models/odometer/metrics.json` and `reader_metrics.json`.

The models are trained on synthetic clusters; real photos are the best way to improve
them. Add them to `data/odometer/real/` with a row in `labels.csv` (`file,odometer`),
then retrain:

```
python scripts/train_odometer.py --synth 1800 --train-real
```

## Model status

The damage checkpoint is pinned by SHA-256 in `runs/SELECTED_DEVELOPMENT_MODEL.json`
and is **development-only, not production approved** (4/17 release gates). See
[MODEL_CARD.md](MODEL_CARD.md). Every damage response carries `model_status` and
`production_approved: false`.
