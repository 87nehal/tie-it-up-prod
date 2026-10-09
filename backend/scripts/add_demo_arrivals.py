"""Add walk-in arrivals with no job card yet, so the Job card screen's "To open" queue has
vehicles to demo job card creation on.

    python -m scripts.add_demo_arrivals [count]     (run from backend/)
"""

from __future__ import annotations

import sys
from datetime import timedelta

from app.service import store

CONCERNS = [
    "Periodic service due, also AC cooling weak hai",
    "Brake lagane par awaaz aati hai, front side",
    "Gaadi subah start nahi hoti, battery weak lagti hai",
    "Car pulling to the left, wheel alignment and wash",
    "Check engine light on, mileage drop ho gaya hai",
    "Clutch hard ho gaya hai, gear shifting difficult",
]
WAITING_MINS = [42, 31, 24, 15, 9, 4]


def main(count: int) -> None:
    with store.connect() as conn:
        now = store.now()
        busy = {r[0] for r in conn.execute(
            "SELECT vehicle_id FROM visits WHERE substr(arrived_at, 1, 10) = ?", (now.date().isoformat(),))}
        busy |= {r[0] for r in conn.execute("SELECT vehicle_id FROM job_cards WHERE status != 'released'")}
        free = [r for r in conn.execute("SELECT id, odometer FROM vehicles ORDER BY id") if r[0] not in busy]
        advisors = conn.execute("SELECT COUNT(*) FROM advisors").fetchone()[0]
        for n, (vid, odo) in enumerate(free[:count]):
            arrived = (now - timedelta(minutes=WAITING_MINS[n % len(WAITING_MINS)])).isoformat()
            a = conn.execute(
                "INSERT INTO appointments (vehicle_id, slot_start, mode, status, concerns, qr_token, created_at) "
                "VALUES (?,?,?,?,?,?,?)",
                (vid, arrived, "walkin", "arrived", CONCERNS[n % len(CONCERNS)], f"DSP-{20_000_000 + vid}", arrived))
            conn.execute(
                "INSERT INTO visits (appointment_id, vehicle_id, arrived_at, odometer, gate_checks, condition, "
                "advisor_id, status) VALUES (?,?,?,?,?,?,?,?)",
                (a.lastrowid, vid, arrived, odo + 12, "[]", None, n % advisors + 1, "with_advisor"))
            print(f"added arrival for vehicle {vid}")


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 5)
