"""Use cases 11 and 12: AI draft Job Card, parts sourcing, bay and technician allocation.

The draft is assembled from booking, vehicle, history and pre-arrival concerns. The
advisor edits it, the customer approves, and only then are parts reserved and the
technician/bay booked, so a draft never moves stock.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from app import vehicles
from app.service import concerns as cc
from app.service import store
from app.service.catalog import BAY_TYPES, DEMAND_CODES, PARTS, STOCK_LOCATIONS


# ------------------------------------------------------------ parts (use case 12)

def availability(conn, part_no: str, qty: int) -> dict[str, Any]:
    stock = {r["location"]: r["qty"] for r in store.many(conn, "SELECT * FROM stock WHERE part_no = ?", part_no)}
    by_loc = [{"location": k, "label": v["label"], "qty": stock.get(k, 0), "eta_hours": v["eta_hours"]}
              for k, v in STOCK_LOCATIONS.items()]
    if stock.get("own", 0) >= qty:
        return {"status": "available", "source": "own", "eta_hours": 0, "locations": by_loc}
    for alt in PARTS[part_no]["alt"]:
        alt_qty = store.one(conn, "SELECT qty FROM stock WHERE part_no = ? AND location = 'own'", alt)
        if alt_qty and alt_qty["qty"] >= qty:
            return {"status": "alternative", "source": "own", "alternative": alt, "eta_hours": 0,
                    "locations": by_loc,
                    "note": f"{PARTS[part_no]['name']} out of stock; OEM-approved alternative in stock"}
    for loc in ("dealer_b", "warehouse"):
        if stock.get(loc, 0) >= qty:
            kind = "transfer" if loc == "dealer_b" else "order"
            return {"status": kind, "source": loc, "eta_hours": STOCK_LOCATIONS[loc]["eta_hours"],
                    "locations": by_loc, "note": f"Raise {kind} request to {STOCK_LOCATIONS[loc]['label']}"}
    return {"status": "unavailable", "source": None, "eta_hours": None, "locations": by_loc,
            "note": "Not in network stock: back-order and inform customer"}


# ------------------------------------------------------ allocation (use case 12)

def _busy_until(conn, column: str, key: int, after: datetime) -> datetime:
    r = conn.execute(f"SELECT MAX(end) FROM allocations WHERE {column} = ? AND end > ?",
                     (key, after.isoformat())).fetchone()[0]
    return datetime.fromisoformat(r) if r else after


def _load_today(conn, tech_id: int, now: datetime) -> float:
    total = 0.0
    for a in store.many(conn, "SELECT start, end FROM allocations WHERE technician_id = ? AND substr(start,1,10) = ?",
                        tech_id, now.date().isoformat()):
        total += (datetime.fromisoformat(a["end"]) - datetime.fromisoformat(a["start"])).total_seconds() / 3600
    return total


def allocate(conn, lines: list[dict[str, Any]], fuel: str, parts_eta_hours: float | None,
             now: datetime | None = None) -> dict[str, Any]:
    now = now or store.now()
    labour = [ln for ln in lines if ln["type"] == "labour"]
    hours = sum(ln.get("hours", 0) for ln in labour) or 0.5
    skills = sorted({ln.get("skill", "general") for ln in labour}) or ["general"]
    primary = next((s for s in skills if s != "general"), "general")

    techs = []
    for t in store.many(conn, "SELECT * FROM technicians WHERE on_duty = 1"):
        covered = [s for s in skills if s in t["skills"]]
        if primary not in t["skills"]:
            continue
        free = _busy_until(conn, "technician_id", t["id"], now)
        load = _load_today(conn, t["id"], now)
        # skill fit, a little for seniority, less for a heavy day, and the wait until they are free:
        # a job goes to a qualified technician who can start soonest, not to one who is booked for hours
        wait_h = min(8.0, max(0.0, (free - now).total_seconds() / 3600))
        score = len(covered) / len(skills) - 0.08 * load + 0.05 * t["level"] - 0.15 * wait_h
        if fuel == "hybrid" and "Hybrid" in t["certifications"]:
            score += 0.3
        elif fuel == "hybrid":
            score -= 0.3
        techs.append({"technician_id": t["id"], "name": t["name"], "skills": t["skills"],
                      "certifications": t["certifications"], "level": t["level"],
                      "covers": covered, "load_hours_today": round(load, 1),
                      "free_at": free.isoformat(), "score": round(score, 2)})
    techs.sort(key=lambda t: t["score"], reverse=True)

    bay_kind = "body" if primary == "body" else ("express" if hours <= 1.5 and skills == ["general"] else "general")
    bays = []
    for b in store.many(conn, "SELECT * FROM bays WHERE active = 1"):
        if primary not in BAY_TYPES[b["type"]] or (bay_kind != "express" and b["type"] == "express"):
            continue
        if b["type"] == "wash":
            continue
        free = _busy_until(conn, "bay_id", b["id"], now)
        bays.append({"bay_id": b["id"], "name": b["name"], "type": b["type"], "free_at": free.isoformat(),
                     "preferred": b["type"] == bay_kind})
    bays.sort(key=lambda b: (not b["preferred"], b["free_at"]))

    if not techs or not bays:
        return {"feasible": False, "reason": "no qualified technician or suitable bay on duty",
                "technicians": techs, "bays": bays, "hours": hours, "skills": skills}
    tech, bay = techs[0], bays[0]
    parts_ready = now + timedelta(hours=parts_eta_hours or 0)
    start = max(now, datetime.fromisoformat(tech["free_at"]), datetime.fromisoformat(bay["free_at"]), parts_ready)
    end = start + timedelta(hours=hours * 1.15)  # 15% for road test and QC
    ready = end + timedelta(minutes=30)  # wash + delivery prep
    return {"feasible": True, "technician": tech, "bay": bay, "technicians": techs[:5], "bays": bays,
            "hours": round(hours, 1), "skills": skills, "start": start.isoformat(),
            "end": end.isoformat(), "promised_delivery": ready.isoformat()}


# -------------------------------------------------------- draft JC (use case 11)

def _context(conn, appointment_id: int | None, visit_id: int | None) -> dict[str, Any]:
    visit = store.one(conn, "SELECT * FROM visits WHERE id = ?", visit_id) if visit_id else None
    if visit and not appointment_id:
        appointment_id = visit["appointment_id"]
    appt = store.one(conn, "SELECT * FROM appointments WHERE id = ?", appointment_id) if appointment_id else None
    if visit is None and appt is not None:
        visit = store.one(conn, "SELECT * FROM visits WHERE appointment_id = ? ORDER BY id DESC LIMIT 1", appt["id"])
    vehicle_id = (visit or appt or {}).get("vehicle_id")
    if vehicle_id is None:
        raise KeyError("appointment or visit not found")
    vehicle = vehicles.get(conn, vehicle_id)
    customer = {"id": vehicle["customer_id"], "name": vehicle["customer_name"],
                "phone": vehicle["phone"], "language": vehicle["language"]}
    return {"visit": visit, "appointment": appt, "vehicle": vehicle, "customer": customer}


def build(conn, ctx: dict[str, Any], text: str, codes: list[str] | None = None,
          removed: list[str] | None = None, use_llm: bool = True) -> dict[str, Any]:
    vehicle = ctx["vehicle"]
    interp = cc.interpret(text, vehicle, use_llm=use_llm)
    if codes is None:
        codes = [c["demand_code"] for c in interp["concerns"]]
    est = cc.estimate(codes, vehicle, availability=lambda p, q: availability(conn, p, q))
    removed = removed or []
    est["lines"] = [ln for ln in est["lines"] if ln["id"] not in removed]
    est = _retotal(est)
    part_etas = [ln["availability"]["eta_hours"] for ln in est["lines"]
                 if ln["type"] == "part" and ln.get("availability")]
    blocking = [e for e in part_etas if e is None]
    parts_eta = None if blocking else max(part_etas or [0])
    plan = allocate(conn, est["lines"], vehicle["fuel"], parts_eta)
    hist = store.many(conn, "SELECT * FROM service_history WHERE vehicle_id = ? ORDER BY date DESC LIMIT 3", vehicle["id"])
    visit = ctx["visit"] or {}
    return {
        "vehicle": {k: vehicle[k] for k in ("id", "reg_no", "vin", "model", "fuel", "sale_date", "odometer")}
        | {"odometer_at_arrival": visit.get("odometer") or vehicle["odometer"]},
        "customer": {k: ctx["customer"][k] for k in ("id", "name", "phone", "language")},
        "appointment": ctx["appointment"], "visit_id": visit.get("id"),
        "condition": visit.get("condition"), "history": hist, "telemetry": vehicle.get("telemetry"),
        "gate_checks": visit.get("gate_checks") or [],
        "concern_text": text, "interpretation": interp, "demand_codes": codes, "removed": removed,
        "estimate": est, "allocation": plan, "parts_blocking": bool(blocking),
    }


def _retotal(est: dict[str, Any]) -> dict[str, Any]:
    cust = [ln for ln in est["lines"] if ln["payer"] == "customer"]
    labour = sum(ln["amount"] for ln in cust if ln["type"] == "labour")
    parts = sum(ln["amount"] for ln in cust if ln["type"] == "part")
    tax = round((labour + parts) * cc.GST)
    est["labour_hours"] = round(sum(ln.get("hours", 0) for ln in est["lines"]), 1)
    est["totals"].update(labour=labour, parts=parts, gst=tax, customer_payable=labour + parts + tax,
                         warranty_value=sum(ln["amount"] for ln in est["lines"] if ln["payer"] == "warranty"),
                         campaign_value=sum(ln["amount"] for ln in est["lines"] if ln["payer"] == "campaign"))
    return est


def create_draft(conn, appointment_id: int | None, visit_id: int | None, text: str | None,
                 use_llm: bool = True) -> dict[str, Any]:
    ctx = _context(conn, appointment_id, visit_id)
    text = text if text is not None else ((ctx["appointment"] or {}).get("concerns") or "")
    payload = build(conn, ctx, text, use_llm=use_llm)
    ts = store.now().isoformat()
    cur = conn.execute(
        "INSERT INTO job_cards (visit_id, vehicle_id, status, payload, created_at, updated_at) VALUES (?,?,?,?,?,?)",
        (payload["visit_id"], ctx["vehicle"]["id"], "draft", store.dumps(payload), ts, ts),
    )
    return get(conn, cur.lastrowid)  # type: ignore[arg-type]


def get(conn, jc_id: int) -> dict[str, Any] | None:
    jc = store.one(conn, "SELECT * FROM job_cards WHERE id = ?", jc_id)
    if jc and jc["payload"].get("visit_id"):
        # the condition assessment may finish after the draft was built; show the live one
        v = store.one(conn, "SELECT condition, gate_checks FROM visits WHERE id = ?", jc["payload"]["visit_id"])
        if v:
            jc["payload"]["condition"] = v["condition"]
            jc["payload"]["gate_checks"] = v["gate_checks"] or []
    return jc


def listing(conn, limit: int = 250) -> list[dict[str, Any]]:
    out = []
    for jc in store.many(conn, "SELECT * FROM job_cards ORDER BY id DESC LIMIT ?", limit):
        p = jc.pop("payload")
        out.append({**jc, "reg_no": p["vehicle"]["reg_no"], "model": p["vehicle"]["model"],
                    "customer_name": p["customer"]["name"],
                    "customer_payable": p["estimate"]["totals"]["customer_payable"]})
    return out


def revise(conn, jc_id: int, text: str | None, codes: list[str] | None, removed: list[str] | None,
           override_reason: str | None) -> dict[str, Any]:
    jc = get(conn, jc_id)
    if jc is None:
        raise KeyError("job card not found")
    if jc["status"] != "draft":
        raise ValueError(f"job card is {jc['status']}; only drafts can be revised")
    old = jc["payload"]
    ctx = _context(conn, (old.get("appointment") or {}).get("id"), old.get("visit_id"))
    unknown = [c for c in codes or [] if c not in DEMAND_CODES]
    if unknown:
        raise ValueError(f"unknown demand codes: {', '.join(unknown)}")
    payload = build(conn, ctx, text if text is not None else old["concern_text"],
                    codes if codes is not None else old["demand_codes"],
                    removed if removed is not None else old["removed"], use_llm=False)
    payload["interpretation"] = old["interpretation"] if text is None else payload["interpretation"]
    payload["overrides"] = old.get("overrides", []) + ([{"at": store.now().isoformat(), "reason": override_reason}]
                                                      if override_reason else [])
    conn.execute("UPDATE job_cards SET payload = ?, updated_at = ? WHERE id = ?",
                 (store.dumps(payload), store.now().isoformat(), jc_id))
    return get(conn, jc_id)  # type: ignore[return-value]


def approve(conn, jc_id: int) -> dict[str, Any]:
    """Customer approved: reserve parts, book technician and bay, fix the promised time."""
    jc = get(conn, jc_id)
    if jc is None:
        raise KeyError("job card not found")
    if jc["status"] != "draft":
        raise ValueError(f"job card is already {jc['status']}")
    p = jc["payload"]
    if not p["interpretation"]["sufficient"] and not p.get("overrides"):
        raise ValueError("unmatched or uncertain concerns require advisor review and an override reason")
    plan = p["allocation"]
    if not plan.get("feasible"):
        raise ValueError(plan.get("reason") or "no feasible allocation")
    if p.get("parts_blocking"):
        raise ValueError("a part is unavailable across the network; revise the estimate first")
    reserved = []
    for ln in p["estimate"]["lines"]:
        if ln["type"] != "part":
            continue
        src = ln["availability"]["source"]
        conn.execute("UPDATE stock SET qty = qty - ? WHERE part_no = ? AND location = ? AND qty >= ?",
                     (ln["qty"], ln["code"], src, ln["qty"]))
        conn.execute("INSERT INTO reservations (job_card_id, part_no, location, qty) VALUES (?,?,?,?)",
                     (jc_id, ln["code"], src, ln["qty"]))
        reserved.append({"part_no": ln["code"], "location": src, "qty": ln["qty"]})
    conn.execute("INSERT INTO allocations (job_card_id, technician_id, bay_id, start, end) VALUES (?,?,?,?,?)",
                 (jc_id, plan["technician"]["technician_id"], plan["bay"]["bay_id"], plan["start"], plan["end"]))
    p["reserved"] = reserved
    p["approved_at"] = store.now().isoformat()
    conn.execute("UPDATE job_cards SET status = 'approved', payload = ?, updated_at = ? WHERE id = ?",
                 (store.dumps(p), store.now().isoformat(), jc_id))
    return get(conn, jc_id)  # type: ignore[return-value]


def release(conn, jc_id: int) -> dict[str, Any]:
    jc = get(conn, jc_id)
    if jc is None:
        raise KeyError("job card not found")
    if jc["status"] != "approved":
        raise ValueError("approve the job card before releasing it")
    p = jc["payload"]
    t = p["estimate"]["totals"]
    msg = (f"Job card JC-{jc_id} for {p['vehicle']['reg_no']} released. Estimate Rs {t['customer_payable']:,} "
           f"(incl. GST). Promised delivery {datetime.fromisoformat(p['allocation']['promised_delivery']):%d %b %H:%M}.")
    conn.execute("INSERT INTO outreach (vehicle_id, action, channel, offer, message, status, created_at) VALUES (?,?,?,?,?,?,?)",
                 (p["vehicle"]["id"], "jc_summary", "app", None, msg, "queued", store.now().isoformat()))
    p["released_at"] = store.now().isoformat()
    conn.execute("UPDATE job_cards SET status = 'released', payload = ?, updated_at = ? WHERE id = ?",
                 (store.dumps(p), store.now().isoformat(), jc_id))
    if p.get("visit_id"):
        conn.execute("UPDATE visits SET status = 'in_workshop' WHERE id = ?", (p["visit_id"],))
    return get(conn, jc_id)  # type: ignore[return-value]
