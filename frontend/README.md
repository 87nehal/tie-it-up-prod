# Car Health Platform — frontend

Next.js 16 App Router UI (shadcn/ui + Tailwind CSS 4) for the merged backend in
[../backend](../backend): DINOv2 damage segmentation and OBD-II telemetry
diagnosis behind a single API.

```powershell
cd ..\backend
python -m venv .venv; .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt

cd ..\frontend
npm install
npm run dev
```

Open http://localhost:3000.

`npm run dev` starts the hash-verified backend API on port 8000 (or reuses an
already healthy instance), waits for the selected checkpoint to load, and then
starts Next.js. `next.config.ts` rewrites `/api/:path*` to
`http://127.0.0.1:8000/api/:path*`. The API never accepts a user-defined
threshold. Use `npm run dev:web` only when you intentionally manage the API in
a separate terminal with `..\backend\run_backend.ps1`.

| Route   | Page                                                                 |
| ------- | -------------------------------------------------------------------- |
| `/`     | Damage upload, segmentation overlay, and fail-closed safety decision |
| `/logs` | Telemetry workspace: CSV upload/paste/sample diagnosis               |

The selected checkpoint is development-only and not production approved. The
UI preserves that warning and exposes manual-review and recapture outcomes.
