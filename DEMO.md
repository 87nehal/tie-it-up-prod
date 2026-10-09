# Maruti Suzuki DMS POC: presenter runbook

The desktop is one showroom's account (Sharma Motors · Sector 18, ARENA, DLR-0412). Every screen works on the same vehicle record. The seven numbered steps in the sidebar are the service journey, and each step shows a live count of work waiting there.

## Prepare (2 minutes)

1. `cd frontend` → `npm run prod` (or `npm run dev`), then open `http://localhost:3000`.
2. Bookings and work persist across days. To start a fresh rehearsal, click **Reset demo day** on **Today**; this clears the previous demo, including customer bookings. You get a fresh outlet day: about 160 visits, 120 already checked in, 35 delivered, and about 210 customers due for follow-up.
3. Click **Demo guide** (header). Tick **Show use-case numbers on screen** if the audience wants the UC mapping. Inline assists then show `UC n`.
4. Optional: open `/m` on a phone for the staff and customer app.

## The story (about 15 minutes)

**Today (command centre).** The outlet at a glance: today's visits, the journey funnel (1→7) with counts, the live floor of every vehicle with its next action, and capacity. Point out **Done for you today**: the use cases as operating numbers, not as AI features.

From here, each step is one click in the **Demo guide**. The guide opens a live vehicle and *follows* it. The **Following** strip at the top then carries that car across screens, with a **Next: …** button for the following step.

| Step | Screen | Use cases shown in place |
|---|---|---|
| 1 | Service follow-up | UC1 who is due and why · UC2 channel, offer, timing and message in the customer's language |
| 2 | Appointments | UC3 slots ranked against workshop load · on booking, UC4 chauffeur and UC8 advisor are assigned automatically |
| 3 | Pickup & drop | UC4 assigned driver (outcome only) · UC5 live position and ETA |
| 4 | Vehicle arrival | UC6 plate/VIN/odometer OCR checked against records · UC7 walk-around damage capture · UC8 advisor |
| 5 | Job cards | UC9 customer words → demand codes (vague wording goes to the advisor) · UC10 estimate · UC11 parts sourcing |
| 6 | Workshop floor | UC12 technician and bay with a promised time |
| 7 | Billing & delivery | invoice, delivery, then gate-out in the security app (`/m/gate`) |

Close on **Customers & vehicles → the vehicle record**. The appointment, gate-in, job card, invoice and every decision taken on the visit sit on one record.

## One car from mobile booking to delivery

1. Open `/m/customer`, select a car without an existing visit, and book pickup. Keep the customer tracker open beside the desktop.
2. The booking appears immediately in **Pickup & drop**, including future dates. The dashboard pickup queue and **Following** strip update to the same car.
3. Use **Demo views** in the mobile header to switch to **Driver**. Open that car's trip, start it, and simulate travel until the driver reaches the customer. Enter the customer's `DSP-` service pass and capture the plate and odometer to confirm handover.
4. Simulate the return to the workshop. Switch to **Service Advisor**: the same car is selected for arrival, even when demonstrating a future booking today. Capture the arrival and open its job card through **Desktop workspace**.
5. Review and approve the estimate in the customer's tracker. Release the job to the workshop, then use the technician view for work and QC. Customer progress updates without reopening the screen.
6. Invoice and deliver through the desktop, then capture gate-out in the security view. The customer sees the completed journey and invoice in **My car**.

Tabs on the same browser origin refresh immediately after changes. Devices on separate browsers refresh their live screens by polling.

## Explaining the intelligence

Matching (driver, advisor, technician) works like a ride-hailing match: staff see the result, and the reasons sit behind **Why?**. Concerns the car raised (telemetry) or its history raised are labelled separately from what the customer said. Symptom complaints are quoted as *inspection first*: no replacement part until the advisor confirms it. Wording outside the taxonomy (for example "sunroof leaks") is never guessed. The advisor codes it and records why.

## Boundaries to state

This is an offline, single-outlet POC with seeded data at a realistic volume for one outlet, not a tested 6,000-outlet rollout. Labour rates, parts and campaigns are example tables until DMS/EPC sources are connected. Damage analysis takes 30 s to 2 min per photo on a CPU.
