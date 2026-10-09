import json, sys
from playwright.sync_api import sync_playwright
from lib import *
import record_demo as r
ctx=json.load(open(r.BUILD/"ctx.json")); v=ctx["vehicle_id"]
out=str(HERE/"build"/"shots")+"/"
with sync_playwright() as pw:
    b=pw.chromium.launch(channel="msedge",headless=True)
    c=b.new_context(viewport={"width":W,"height":H}); c.route(__import__("re").compile(r"/__phone"), lambda rr: rr.fulfill(status=200,content_type="text/html",body=PHONE_HTML))
    pg=c.new_page()
    for name,url in sys.argv[1:] and [a.split("=",1) for a in sys.argv[1:]]:
        pg.goto(BASE+url.replace("{v}",str(v)).replace("{vi}",str(ctx.get("visit_id",""))).replace("{jc}",str(ctx.get("job_card_id","")))); pg.wait_for_timeout(5000)
        pg.screenshot(path=out+name+".png", full_page=False)
        print(name, [t for t in pg.locator("button").all_inner_texts() if t.strip()][:40])
    b.close()
