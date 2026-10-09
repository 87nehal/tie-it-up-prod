"""Read-only mobile layout review through a local headless browser's CDP port."""
import asyncio
import base64
import json
import os
from pathlib import Path
import urllib.request

import websockets


async def main():
    with urllib.request.urlopen('http://127.0.0.1:9223/json/list', timeout=3) as response:
        tabs = json.load(response)
    tab = next(t for t in tabs if t['type'] == 'page' and (t['url'] == 'about:blank' or t['url'].startswith('http://127.0.0.1:')))
    output = Path('.mobile-review')
    output.mkdir(exist_ok=True)
    async with websockets.connect(tab['webSocketDebuggerUrl'], max_size=16 * 1024 * 1024) as ws:
        sequence = 0
        errors = []

        async def call(method, params=None):
            nonlocal sequence
            sequence += 1
            request_id = sequence
            await ws.send(json.dumps({'id': request_id, 'method': method, 'params': params or {}}))
            while True:
                message = json.loads(await ws.recv())
                if message.get('method') == 'Runtime.exceptionThrown':
                    errors.append(message['params']['exceptionDetails'].get('text'))
                if message.get('id') == request_id:
                    if 'error' in message:
                        raise RuntimeError(message['error'])
                    return message.get('result', {})

        async def evaluate(expression):
            result = await call('Runtime.evaluate', {'expression': expression, 'returnByValue': True, 'awaitPromise': True})
            if 'exceptionDetails' in result:
                raise RuntimeError(result['exceptionDetails'])
            return result['result'].get('value')

        await call('Page.enable')
        await call('Runtime.enable')
        await call('Emulation.setDeviceMetricsOverride', {'width': 390, 'height': 844, 'deviceScaleFactor': 1, 'mobile': True})
        await call('Emulation.setTouchEmulationEnabled', {'enabled': True})
        await call('Emulation.setTimezoneOverride', {'timezoneId': 'Asia/Kolkata'})
        report = []
        for route in ['/m', '/m/gate', '/m/arrival', '/m/inspect', '/m/tech', '/m/driver', '/m/search', '/m/customer', '/m/book', '/m/my-car']:
            await call('Page.navigate', {'url': os.environ.get('MOBILE_REVIEW_URL', 'http://127.0.0.1:3001') + route})
            for _ in range(40):
                await asyncio.sleep(1)
                if await evaluate("document.readyState === 'complete' && !!document.querySelector('#mobile-content')"):
                    break
            await asyncio.sleep(2)
            for _ in range(18):
                if not await evaluate("!!document.querySelector('#mobile-content [role=status], #mobile-content .animate-pulse')"):
                    break
                await asyncio.sleep(1)
            snapshot = await evaluate("""({title: document.querySelector('h1')?.textContent,
                width: innerWidth, contentWidth: document.documentElement.scrollWidth,
                text: document.querySelector('#mobile-content')?.innerText.slice(0,800),
                navigation: [...document.querySelectorAll('nav[aria-label="Mobile navigation"] a')].map(a=>a.textContent),
                actions: [...document.querySelectorAll('[data-mobile-actions]')].map(a=>({top:a.getBoundingClientRect().top,bottom:a.getBoundingClientRect().bottom})),
                errors: [...document.querySelectorAll('[role="alert"]')].map(a=>a.textContent)})""")
            snapshot['route'] = route
            png = await call('Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': False})
            (output / (route.strip('/').replace('/', '-') + '.png')).write_bytes(base64.b64decode(png['data']))
            report.append(snapshot)
            print(json.dumps(snapshot), flush=True)
        (output / 'report.json').write_text(json.dumps({'pages': report, 'browserErrors': errors}, indent=2), encoding='utf-8')
        assert all(page['contentWidth'] == page['width'] for page in report), 'Horizontal overflow'
        for width in [320, 360]:
            await call('Emulation.setDeviceMetricsOverride', {'width': width, 'height': 740, 'deviceScaleFactor': 1, 'mobile': True})
            for route in ['/m/gate', '/m/arrival', '/m/inspect', '/m/tech']:
                await call('Page.navigate', {'url': os.environ.get('MOBILE_REVIEW_URL', 'http://127.0.0.1:3001') + route})
                await asyncio.sleep(2)
                assert await evaluate('document.documentElement.scrollWidth === innerWidth'), (width, route, 'overflow')
        await evaluate("localStorage.setItem('dlr-mobile-role','advisor')")
        await call('Page.navigate', {'url': 'http://127.0.0.1:3001/m/gate'})
        await asyncio.sleep(2)
        assert await evaluate("[...document.querySelectorAll('nav a')].some(a=>a.textContent.includes('New arrival'))"), 'Advisor role changed at gate'
        await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Next: VIN').click()")
        assert await evaluate("document.querySelector('input[aria-label=\"VIN plate\"]') !== null"), 'VIN capture step did not open'
        await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent==='Next: Odometer').click()")
        assert await evaluate("document.querySelector('input[aria-label=Odometer]') !== null"), 'Odometer capture step did not open'
        stalled = await call('Page.addScriptToEvaluateOnNewDocument', {'source': "window.__reviewFetch = window.fetch; window.fetch = (...args) => String(args[0]).includes('/api/erp/board') ? new Promise(()=>{}) : window.__reviewFetch(...args);"})
        await call('Page.navigate', {'url': 'http://127.0.0.1:3001/m/tech'})
        await asyncio.sleep(17)
        assert await evaluate("document.querySelector('[role=alert]')?.textContent.includes('longer than expected')"), 'A stalled request kept loading forever'
        assert not await evaluate("!!document.querySelector('#mobile-content [role=status]')"), 'Loading did not end after timeout'
        await evaluate("window.fetch = window.__reviewFetch; [...document.querySelectorAll('button')].find(b=>b.textContent==='Try again').click()")
        await asyncio.sleep(4)
        assert not await evaluate("!!document.querySelector('#mobile-content [role=alert]')"), 'Retry failed to recover'
        await call('Page.removeScriptToEvaluateOnNewDocument', {'identifier': stalled['identifier']})
        await call('Page.navigate', {'url': 'http://127.0.0.1:3001/m/customer'})
        await asyncio.sleep(3)
        await evaluate("document.querySelector('#mobile-content button').click()")
        await asyncio.sleep(2)
        for route in ['/m/book', '/m/my-car']:
            await call('Page.navigate', {'url': 'http://127.0.0.1:3001' + route})
            await asyncio.sleep(4)
            assert await evaluate('document.documentElement.scrollWidth === innerWidth'), (route, 'customer overflow')
            if route == '/m/book':
                assert await evaluate("document.querySelector('h1')?.textContent === 'Book a service'"), 'Booking form did not open'
            png = await call('Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': False})
            (output / (route.strip('/').replace('/', '-') + '-selected.png')).write_bytes(base64.b64decode(png['data']))
        print('PASS: widths 320/360/390, advisor navigation, gate steps, request timeout and retry recovery', flush=True)
        print('PASS: customer car selection, booking and car record at 360px', flush=True)
        print('Browser exceptions:', errors, flush=True)


asyncio.run(main())
