import json, sys, re
from playwright.sync_api import sync_playwright
from lib import *
import record_demo as r
ctx=json.load(open(r.BUILD/"ctx.json")); v=ctx["vehicle_id"]
out=str(HERE/"build"/"shots")+"/"
with sync_playwright() as pw:
    b=pw.chromium.launch(channel="msedge",headless=True)
    pg=b.new_context(viewport={"width":W,"height":H}).new_page()
    pg.goto(BASE+f"/reception?v={v}"); pg.wait_for_timeout(4000)
    pg.get_by_role("button",name="Use demo photos").first.click(); pg.wait_for_timeout(2500); pg.screenshot(path=out+"r1.png")
    pg.get_by_role("button",name="Read photos").first.click(); t=__import__("time").time(); pg.get_by_role("button",name="Read photos").wait_for(timeout=180000); print("ocr secs",__import__("time").time()-t); pg.wait_for_timeout(1500); pg.screenshot(path=out+"r2.png")
    print([t for t in pg.locator("button").all_inner_texts() if t.strip()][:12])
    pg.mouse.wheel(0,700); pg.wait_for_timeout(800); pg.screenshot(path=out+"r3.png")
    pg.mouse.wheel(0,700); pg.wait_for_timeout(800); pg.screenshot(path=out+"r4.png")
    print([t for t in pg.locator("button").all_inner_texts() if t.strip()][-12:])
    b.close()
