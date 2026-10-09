import json, sys, re
from playwright.sync_api import sync_playwright
from lib import *
import record_demo as r
ctx=json.load(open(r.BUILD/"ctx.json")); v=ctx["vehicle_id"]
out=str(HERE/"build"/"shots")+"/"
with sync_playwright() as pw:
    b=pw.chromium.launch(channel="msedge",headless=True)
    pg=b.new_context(viewport={"width":W,"height":H}).new_page()
    pg.goto(BASE+f"/job-cards?v={v}"); pg.wait_for_timeout(5000); pg.screenshot(path=out+"j0.png")
    print([t[:40] for t in pg.locator("button").all_inner_texts() if t.strip()][:30])
    pg.get_by_role("button",name=re.compile("Draft job card")).first.click(); pg.wait_for_timeout(15000); pg.screenshot(path=out+"j1.png")
    for i in range(2,9):
        pg.mouse.wheel(0,650); pg.wait_for_timeout(700); pg.screenshot(path=out+f"j{i}.png")
    b.close()
