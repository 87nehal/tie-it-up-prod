"""Dev helper: advance a car through the demo API up to a step, so later scenes can be tried alone.
    python run_to.py drive      # books a car and runs book..drive, saving build/ctx.json
"""
import sys, json
from playwright.sync_api import sync_playwright
import record_demo as r
from lib import api
KEYS=["book","dispatch","arrive","handover","drive","check_in","job_card","approve","release","bay","qc","qc_pass","deliver","gate_out"]
upto=sys.argv[1] if len(sys.argv)>1 else "book"
with sync_playwright() as pw:
    b=pw.chromium.launch(channel="msedge",headless=True); pg=b.new_page()
    ctx={}
    for k in KEYS[:KEYS.index(upto)+1]:
        out=api(pg,"POST","/api/erp/demo/journey",{"step":k,"ctx":ctx}); ctx=out["ctx"]; print(k,out["note"].encode("ascii","replace").decode())
    json.dump(ctx,open(r.BUILD/"ctx.json","w")); print(ctx); b.close()
