import os, json, sys
from playwright.sync_api import sync_playwright
from lib import *
out=str(HERE/"build"/"shots")+"/"
with sync_playwright() as pw:
    b=pw.chromium.launch(channel="msedge",headless=True)
    c=b.new_context(viewport={"width":W,"height":H}); c.route(__import__("re").compile(r"/__phone"), lambda r: r.fulfill(status=200,content_type="text/html",body=PHONE_HTML))
    pg=c.new_page()
    r=api(pg,"POST","/api/erp/demo/journey",{"step":"book","ctx":{}}); print(r); ctx=r["ctx"]
    ctx=r["ctx"]
    pg.goto(BASE+f"/pickups?v={ctx['vehicle_id']}"); pg.wait_for_timeout(4000); pg.screenshot(path=out+"p1.png")
    pg.goto(BASE+f"/__phone?src=/m/driver%3Fv={ctx['vehicle_id']}&role=Chauffeur&title=Trip&text=x"); pg.wait_for_timeout(4000); pg.screenshot(path=out+"p2.png")
    f=pg.frame_locator("#f")
    print([t for t in f.locator("button").all_inner_texts()])
    b.close()
