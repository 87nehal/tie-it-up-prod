"""Record the platform demo video.

    python record_demo.py --dry                 # run the story without recording (fast, writes screenshots)
    python record_demo.py --dry --only booking  # one scene
    python record_demo.py                       # record video + narration -> build/demo.mp4

The story follows one customer's car through the real app: booking and chauffeur match,
pickup, gate-in, job card, technician and bay allocation, customer approval, workshop floor,
quality check, billing and gate-out.
"""

from __future__ import annotations

import argparse
import re
import sys
import time
from pathlib import Path

from playwright.sync_api import Page, expect, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib import BASE, H, HERE, OVERLAY_JS, PHONE_HTML, W, Director, Voice, api, encode, mix_audio  # noqa: E402

BUILD = HERE / "build"
CTX: dict = {}


def pick_car() -> dict:
    """An idle car with a VIN whose best chauffeur is a realistic few km away (so the ETA and the
    reasons read naturally on screen)."""
    sys.path.insert(0, str(HERE.parent / "backend"))
    from datetime import datetime, timedelta

    from app import ai, db, demo_journey, erp, vehicles  # noqa: WPS433
    from app.fleet import store as trips

    with db.connect() as conn:
        busy = {r["vehicle_id"] for r in db.many(conn, """
            SELECT vehicle_id FROM appointments WHERE status NOT IN ('arrived','cancelled','no_show')
            UNION SELECT vehicle_id FROM visits WHERE status != 'delivered'
            UNION SELECT vehicle_id FROM job_cards WHERE status IN ('draft','approved')""")}
        for jc in db.many(conn, "SELECT id, vehicle_id FROM job_cards WHERE status = 'released'"):
            w = erp._wip(conn, jc["id"])
            if not w or w["stage"] != "delivered":
                busy.add(jc["vehicle_id"])
        slot = (datetime.now() + timedelta(days=1)).replace(hour=13, minute=0, second=0, microsecond=0)
        fallback = None
        for row in db.many(conn, "SELECT id FROM vehicles ORDER BY id"):
            if row["id"] in busy:
                continue
            v = vehicles.get(conn, row["id"])
            if not (v and v.get("vin")) or trips.open_trip(conn, v["reg_no"]):
                continue
            fallback = fallback or v
            top = [c for c in ai.rank_drivers(conn, v["id"], slot)["candidates"] if c["eligible"]][:1]
            if top and 3.0 <= top[0]["distance_km"] <= 9.0 and 8 <= top[0]["eta_to_customer_min"] <= 25:
                return v
        if fallback:
            return fallback
    raise RuntimeError("no idle car; reset the demo day first")


# ----------------------------------------------------------------------------- scenes
def intro(d: Director, page: Page) -> None:
    d.goto("/", wait=1.0)
    d.card("Maruti Suzuki dealer workshop platform", "One car, one record, from booking to gate-out",
           "A guided walkthrough of how jobs are created, who is allocated to them and why.",
           [("1", "Booking: slot picked by workshop load, chauffeur and advisor matched automatically"),
            ("2", "Pickup: live position and ETA, handover captured at the customer's door"),
            ("3", "Arrival and job card: customer words become demand codes, parts and an estimate"),
            ("4", "Technician and bay: allocated on skills, load and free time, with a promised time"),
            ("5", "Workshop floor, quality check, billing and gate-out")],
           narrate="This is the Maruti Suzuki dealer workshop platform. In the next few minutes we follow one customer's car "
                   "from booking to gate out, and see how jobs are created, how a chauffeur is chosen for the pickup, "
                   "and how a technician and bay are allocated, and on what basis.")


def overview(d: Director, page: Page) -> None:
    d.step("Command centre")
    d.goto("/", wait=3.5)
    d.say("This is the command centre for the Sharma Motors Sector 18 outlet. Every number is live, for today.", wait=False)
    d.pause(2.5)
    d.ring(page.get_by_text("Vehicles today").first, "Visits booked for today", side="below", key="v")
    d.pause(2.5)
    d.unring()
    j = page.get_by_text("TODAY'S SERVICE JOURNEY", exact=False).first
    d.scroll_to(j)
    d.say("The service journey has seven steps: follow-up, appointment, pickup, arrival, job card, workshop and delivery. "
          "Each step shows how many cars are waiting there right now.")
    d.ring(j, "The seven steps of the journey", side="below", key="j")
    d.pause(1.5)
    d.unring()


def workshop_floor(d: Director, page: Page, closing: bool = False) -> None:
    d.step("Workshop floor")
    d.goto("/workshop", wait=3.5)
    d.shot("workshop")


def booking(d: Director, page: Page) -> None:
    car = pick_car()
    CTX.update(vehicle_id=car["id"], reg=car["reg_display"], reg_no=car["reg_no"], customer=car.get("customer_name"),
               model=car.get("model"))
    d.step("Step 1 · Booking")
    d.goto("/appointments", wait=3.0)
    d.say(f"A customer, {CTX['customer']}, wants a service for their {CTX['model']}, and asks us to pick the car up from home. "
          "The advisor opens a new booking.", wait=False)
    d.pause(1.5)
    d.click(page.get_by_role("button", name="New booking").first)
    d.type(page.get_by_placeholder("Registration, customer or phone"), car["reg_no"])
    d.pause(1.5)
    d.shot("book1")
    d.click(page.get_by_role("button", name="Book →").first)
    d.pause(2.5)
    d.shot("book2")
    d.say("The platform ranks the best hours for this visit. It weighs how many cars the workshop can take in each hour, "
          "the customer's preferred time of day, and whether the hour is off-peak. The bar shows how full each hour already is.",
          caption="Best hours: ranked by workshop load, preferred time of day and off-peak", wait=False)
    d.ring(page.get_by_text("Best hours").first, "Ranked by workshop load and the customer's preference", side="left")
    d.pause(7)
    d.unring()
    d.type(page.get_by_placeholder("e.g. AC not cooling, noise from front wheel when braking"),
           "Periodic service due. AC not cooling enough and a squeal from the front brakes.", delay_ms=35)
    d.say("The customer's own words are captured now, so the advisor gets a pre-read of likely causes before the car arrives.", wait=False)
    d.pause(3)
    d.click(page.get_by_role("button", name="Confirm").first)
    d.pause(3.0)
    d.shot("book3")
    why = page.locator("summary", has_text="Why?")
    panel = page.locator("li", has_text="Driver auto-assigned")
    d.say("Booked. Two matches happen automatically at this moment: a service advisor for the visit, and a chauffeur for the pickup.",
          wait=False)
    d.pause(1.0)
    d.scroll_to(page.get_by_text("Booking confirmed").first)
    d.pause(3.5)
    d.step("Step 1 · Who is the advisor, and why")
    d.say("The advisor is chosen the way a ride-hailing app picks a driver. A model scores every advisor on language match, "
          "skill for the job, whether they handled this car before, and how much capacity they have today.",
          caption="Advisor match: language, skills, history with this car, capacity today", wait=False)
    d.click(why.nth(0))
    d.ring(page.locator("li", has_text="Advisor auto-assigned"), key="adv")
    d.pause(7.5)
    d.unring()
    d.step("Step 1 · How the chauffeur is chosen")
    d.say("Now the chauffeur. Every driver is scored on four things: how close they are to the customer's home, how light their trip load is today, "
          "how rarely they decline trips, and their customer rating. Time left in the shift is also checked.",
          caption="Chauffeur match: distance, trips today, acceptance, rating, shift time", wait=False)
    d.click(why.nth(1))
    d.ring(panel, key="drv")
    d.pause(9)
    d.say("Drivers who are off duty, already on a trip, over their daily limit, or whose trip would end after their shift are skipped, "
          "and the reason is shown.", caption="Hard rules first: off duty, on a trip, trip limit, shift end", wait=True)
    d.shot("book4")
    d.unring()


def known_odometer(vehicle_id: int) -> int:
    sys.path.insert(0, str(HERE.parent / "backend"))
    from app import db, vehicles
    from app.service.demo import odometer_for

    with db.connect() as conn:
        return odometer_for(conn, vehicles.get(conn, vehicle_id))


def step_api(page: Page, key: str) -> str:
    """Run a demo step on the backend (for captures a screen cannot type, e.g. camera photos)."""
    out = api(page, "POST", "/api/erp/demo/journey", {"step": key, "ctx": CTX})
    CTX.update(out["ctx"])
    return out.get("note", "")


def sync_ctx(page: Page) -> None:
    out = api(page, "POST", "/api/erp/demo/journey/progress", {"step": "", "ctx": CTX})
    CTX.update(out["ctx"])
    CTX["done"] = out["done"]


def pickup(d: Director, page: Page) -> None:
    v = CTX["vehicle_id"]
    sync_ctx(page)
    CTX.setdefault("appointment_id", None)
    d.step("Step 3 · Pickup and drop")
    d.goto(f"/pickups?v={v}", wait=3.5)
    d.say("Pickup and drop. This is the dispatcher's view of every trip today. Our car is selected, with its chauffeur already assigned.",
          wait=False)
    d.ring(page.get_by_text("CHAUFFEUR").first, key="c")
    d.pause(4)
    d.unring()
    d.say("The basis is one click away. The match favours the driver who is closest, has the lightest day, rarely declines, and is rated best, "
          "after ruling out anyone who is unavailable.", caption="Assigned on distance, load, acceptance and rating", wait=False)
    d.click(page.get_by_role("button", name="Why?").first)
    d.shot("pick1")
    d.pause(6)
    d.say("When it is time, the dispatcher sends the chauffeur on the way.", wait=False)
    d.click(page.get_by_role("button", name=re.compile(r"^Dispatch")).first)
    d.pause(3)
    d.shot("pick2")
    d.say("Live tracking starts. The platform predicts the arrival time from the driver's own GPS pings and flags a delay risk early, "
          "so the customer and the advisor can be told before the car is late.",
          caption="Live ETA from the driver's GPS, with delay-risk alerts", wait=False)
    d.pause(8)
    d.shot("pick3")


def driver_phone(d: Director, page: Page) -> None:
    v = CTX["vehicle_id"]
    d.step("Step 3 · The chauffeur's app")
    d.phone(f"/m/driver%3Fv={v}", "Chauffeur", "The driver's trip",
            "The chauffeur sees only what they need: the customer, the route and the next action.", wait=4.0)
    d.say("On the chauffeur's phone the trip is already waiting. Route, customer, and the time the customer expects the car.", wait=False)
    d.pause(4.5)
    d.shot("drv1")
    sim = d.app.get_by_role("button", name=re.compile("Simulate"))
    d.say("For this demo we move time forward, and the driver's position moves along the road to the customer. "
          "The dispatcher's screen follows the same positions.", caption="Demo clock moves the driver towards the customer", wait=False)
    d.click(sim, soft=True)
    d.pause(2.0)
    d.click(sim, soft=True)
    d.pause(2.0)
    d.shot("drv2")
    d.say("At the customer's door, the chauffeur confirms the service pass the customer shows, then photographs the number plate and the odometer. "
          "The platform reads them and checks them against the car's record.",
          caption="Handover at the door: service pass, number plate and odometer photo", wait=False)
    note = step_api(page, "arrive") if "arrive" not in CTX.get("done", []) else ""
    d.pause(1.0)
    note = step_api(page, "handover") if "handover" not in CTX.get("done", []) else ""
    d.goto(f"/__phone?src=/m/driver%3Fv={v}&role=Chauffeur&title=Handover%20done&text=Photos%20read%20and%20matched%20to%20the%20booked%20car.", wait=3.5)
    d.shot("drv3")
    d.pause(4.5)
    d.say("The car is now on its way to the workshop with the driver, and the odometer reading at pickup is on record.", wait=True)
    step_api(page, "drive")


def arrival(d: Director, page: Page) -> None:
    v = CTX["vehicle_id"]
    d.step("Step 4 · Vehicle arrival")
    d.goto(f"/reception?v={v}", wait=4.0)
    d.say("Vehicle arrival. The car is at the workshop gate. Security photographs the number plate, the VIN plate and the odometer.",
          wait=False)
    d.pause(3.5)
    d.click(page.get_by_role("button", name="Use demo photos").first)
    d.pause(2.0)
    d.shot("arr1")
    d.say("The platform reads the three photos. This runs on the local machine, so it takes a few seconds.",
          caption="Reading plate, VIN and odometer from photos", wait=False)
    d.click(page.get_by_role("button", name="Read photos").first)
    page.get_by_role("button", name="Read photos").first.wait_for(state="visible", timeout=240000)
    d.pause(6)
    d.shot("arr2")
    d.ring(page.get_by_text("CHECKED AGAINST VEHICLE MASTER").first, key="chk")
    d.say("Every reading is checked against the vehicle master: the registration format, the VIN check digit, the owner on record, "
          "and the odometer against the km the chauffeur recorded at pickup. A mismatch is flagged before the car goes any further.",
          caption="Registration, VIN check digit, owner and odometer all cross-checked", wait=True)
    d.unring()
    checkin = page.get_by_role("button", name="Check in vehicle").first
    if not checkin.is_enabled():
        # the reader slipped on a character and the checks refused the check-in: the guard corrects it by hand
        d.scroll_to(page.get_by_text("Identify vehicle").first)
        d.say("Here the photo reader slipped on a character, and the checks caught it. Check-in stays locked until the plate and the odometer agree with the "
              "record, so the guard corrects the reading by hand.", caption="Mismatch caught: check-in stays locked until corrected", wait=False)
        reg = page.get_by_label("Registration number")
        odo = page.get_by_label("Odometer (km)")
        d.click(reg)
        reg.fill(CTX.get("reg_no") or CTX["reg"].replace(" ", ""))
        d.pause(0.8)
        d.click(odo)
        odo.fill(str(CTX.get("odo_out") or known_odometer(CTX["vehicle_id"])))
        d.pause(3.0)
    d.scroll_to(page.get_by_text("Walk-around").first)
    d.say("The walk-around photos are screened for damage in the background, so any scratch or dent is on record before work starts.",
          caption="Walk-around damage capture", wait=True)
    d.click(page.get_by_role("button", name="Check in vehicle").first)
    d.pause(3.5)
    d.shot("arr3")
    d.say("Checked in. The advisor was matched in advance from the booking: language, skills for this job and today's queue.",
          caption="Advisor assigned from the booking", wait=True)


SCENES = {
    "intro": intro,
    "overview": overview,
    "workshop": workshop_floor,
    "booking": booking,
    "pickup": pickup,
    "driver": driver_phone,
    "arrival": arrival,
}
ORDER = ["intro", "overview", "booking", "pickup", "driver", "arrival", "workshop"]


# ----------------------------------------------------------------------------- main
def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true", help="no video or voice, just run the story")
    ap.add_argument("--only", default="", help="comma separated scene names")
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--ctx", action="store_true", help="resume with build/ctx.json (from run_to.py)")
    ap.add_argument("--voice-offset", type=float, default=0.0)
    args = ap.parse_args()
    names = [n for n in args.only.split(",") if n] or ORDER
    BUILD.mkdir(exist_ok=True)
    if args.ctx:
        import json
        CTX.update(json.load(open(BUILD / "ctx.json")))

    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="msedge", headless=not args.headed)
        ctx_args = {"viewport": {"width": W, "height": H}}
        if not args.dry:
            ctx_args |= {"record_video_dir": str(BUILD / "raw"), "record_video_size": {"width": W, "height": H}}
        context = browser.new_context(**ctx_args)
        context.add_init_script(OVERLAY_JS)
        t_ctx = time.time()
        page = context.new_page()
        context.route(re.compile(r"/__phone"), lambda route: route.fulfill(status=200, content_type="text/html", body=PHONE_HTML))
        d = Director(page, None if args.dry else Voice(), record=not args.dry)
        d.t0 = t_ctx
        try:
            for n in names:
                print("scene", n, f"{d.now():.0f}s", flush=True)
                SCENES[n](d, page)
        except Exception:
            d.shot("error")
            raise
        finally:
            total = d.now()
            video = page.video.path() if not args.dry else None
            context.close()
            browser.close()
    if args.dry:
        print("dry run done", f"{total:.0f}s")
        return
    audio = BUILD / "narration.wav"
    mix_audio(d.clips, total, audio)
    out = BUILD / "demo.mp4"
    encode(Path(video), audio, out, audio_delay=args.voice_offset)
    print("wrote", out, f"{total / 60:.1f} min")


if __name__ == "__main__":
    main()
