"""Recording kit for the platform demo video.

Drives the real app in Edge through Playwright, records the screen, paints an on-screen
cursor, step badge, caption bar and title cards over it, and narrates every caption with the
Windows speech voice. Narration is timed to the recording clock and muxed afterwards.
"""

from __future__ import annotations

import json
import re
import subprocess
import time
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
BASE = "http://localhost:3000"
API = "http://localhost:8000"
W, H = 1600, 900

# --------------------------------------------------------------------------- overlay (runs in every page)
OVERLAY_JS = r"""
(() => {
  if (window.top !== window) return;
  const boot = () => {
    if (document.getElementById('__demo')) return;
    const root = document.createElement('div');
    root.id = '__demo';
    root.innerHTML = `
<style>
#__demo{position:fixed;inset:0;pointer-events:none;z-index:2147483000;font-family:Inter,Segoe UI,system-ui,sans-serif}
#__cap{position:absolute;left:50%;bottom:18px;transform:translateX(-50%) translateY(20px);max-width:980px;min-width:520px;
  background:rgba(15,18,28,.92);color:#fff;border-radius:18px;padding:10px 22px 12px;opacity:0;transition:all .35s ease;
  box-shadow:0 12px 40px rgba(0,0,0,.35);text-align:left}
#__cap.on{opacity:1;transform:translateX(-50%) translateY(0)}
#__cap .badge{display:inline-block;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#7dd3fc;font-weight:700;margin-bottom:4px}
#__cap .txt{font-size:19px;line-height:1.35;font-weight:500}
#__cur{position:absolute;left:0;top:0;width:30px;height:30px;transition:transform .8s cubic-bezier(.45,.05,.25,1);opacity:0}
#__cur svg{filter:drop-shadow(0 3px 5px rgba(0,0,0,.45))}
#__cur .rip{position:absolute;left:-14px;top:-14px;width:44px;height:44px;border-radius:50%;background:rgba(16,185,129,.55);opacity:0}
#__cur.press .rip{animation:rip .5s ease-out}
@keyframes rip{0%{transform:scale(.3);opacity:.9}100%{transform:scale(1.5);opacity:0}}
.__ring{position:absolute;border:3px solid #10b981;border-radius:14px;box-shadow:0 0 0 6px rgba(16,185,129,.2);transition:all .4s ease;opacity:0}
.__ring.on{opacity:1}
.__tag{position:absolute;background:#10b981;color:#fff;font-size:15px;font-weight:700;padding:6px 12px;border-radius:10px;opacity:0;transition:opacity .3s;
  box-shadow:0 6px 18px rgba(0,0,0,.25);max-width:420px;line-height:1.3}
.__tag.on{opacity:1}
#__card{position:absolute;inset:0;background:radial-gradient(1200px 700px at 20% 10%,#1e3a8a 0%,#0b1020 60%);color:#fff;display:flex;flex-direction:column;
  align-items:center;justify-content:center;opacity:0;transition:opacity .6s ease;padding:60px;text-align:center}
#__card.on{opacity:1}
#__card .k{font-size:15px;letter-spacing:.2em;text-transform:uppercase;color:#7dd3fc;font-weight:700;margin-bottom:18px}
#__card h1{font-size:56px;line-height:1.1;margin:0 0 18px;font-weight:700;max-width:1250px}
#__card p{font-size:26px;line-height:1.4;color:#cbd5e1;max-width:1100px;margin:0}
#__card ul{list-style:none;padding:0;margin:26px 0 0;display:grid;gap:12px;text-align:left}
#__card li{font-size:24px;color:#e2e8f0}
#__card li b{color:#7dd3fc;margin-right:10px}
</style>
<div id="__cap"><div class="badge"></div><div class="txt"></div></div>
<div id="__cur"><div class="rip"></div><svg width="30" height="30" viewBox="0 0 24 24"><path d="M4 2l16 9-7 1.5L9.5 20z" fill="#111" stroke="#fff" stroke-width="1.5"/></svg></div>
<div id="__card"></div>`;
    document.documentElement.appendChild(root);
  };
  if (document.documentElement) boot(); else document.addEventListener('DOMContentLoaded', boot);
  window.__demo = {
    caption(badge, text) {
      boot();
      const c = document.getElementById('__cap');
      if (!text) { c.classList.remove('on'); return; }
      c.querySelector('.badge').textContent = badge || '';
      c.querySelector('.badge').style.display = badge ? 'block' : 'none';
      c.querySelector('.txt').textContent = text;
      c.classList.add('on');
    },
    cursor(x, y, press) {
      boot();
      const c = document.getElementById('__cur');
      c.style.opacity = 1;
      c.style.transform = `translate(${x}px,${y}px)`;
      if (press) { c.classList.remove('press'); void c.offsetWidth; c.classList.add('press'); }
    },
    hideCursor() { const c = document.getElementById('__cur'); if (c) c.style.opacity = 0; },
    ring(id, r, label, side) {
      boot();
      const root = document.getElementById('__demo');
      let el = document.getElementById('__ring_' + id), tag = document.getElementById('__tag_' + id);
      if (!el) { el = document.createElement('div'); el.id = '__ring_' + id; el.className = '__ring'; root.appendChild(el);
                 tag = document.createElement('div'); tag.id = '__tag_' + id; tag.className = '__tag'; root.appendChild(tag); }
      el.style.left = (r.x - 6) + 'px'; el.style.top = (r.y - 6) + 'px'; el.style.width = (r.w + 12) + 'px'; el.style.height = (r.h + 12) + 'px';
      el.classList.add('on');
      if (label) {
        tag.textContent = label;
        let tx = r.x, ty = r.y - 44;
        if (side === 'below') ty = r.y + r.h + 14;
        if (side === 'right') { tx = r.x + r.w + 16; ty = r.y; }
        if (side === 'left') { tx = Math.max(10, r.x - 436); ty = r.y; }
        if (ty < 8) ty = r.y + r.h + 14;
        tag.style.left = Math.max(10, Math.min(tx, innerWidth - 440)) + 'px'; tag.style.top = ty + 'px';
        tag.classList.add('on');
      }
    },
    clearRings() { document.querySelectorAll('.__ring,.__tag').forEach(e => e.remove()); },
    card(kicker, title, body, items) {
      boot();
      const c = document.getElementById('__card');
      if (!title) { c.classList.remove('on'); return; }
      c.innerHTML = `<div class="k">${kicker || ''}</div><h1>${title}</h1>${body ? `<p>${body}</p>` : ''}` +
        (items && items.length ? `<ul>${items.map(i => `<li><b>${i[0]}</b>${i[1]}</li>`).join('')}</ul>` : '');
      c.classList.add('on');
    },
  };
})();
"""

PHONE_HTML = """<!doctype html><html><head><meta charset="utf-8"><title>phone</title>
<style>
html,body{margin:0;height:100%;background:radial-gradient(900px 600px at 50% 0%,#1e293b,#0b1020);font-family:Inter,Segoe UI,system-ui,sans-serif;color:#fff}
.wrap{height:100%;display:flex;align-items:center;justify-content:center;gap:70px;padding-bottom:70px;box-sizing:border-box}
.side{width:420px}
.side .role{font-size:14px;letter-spacing:.18em;text-transform:uppercase;color:#7dd3fc;font-weight:700}
.side h2{font-size:42px;line-height:1.1;margin:10px 0 14px}
.side p{font-size:21px;color:#cbd5e1;line-height:1.45;margin:0}
.phone{width:392px;height:790px;border-radius:44px;background:#0a0a0a;padding:14px;box-shadow:0 30px 80px rgba(0,0,0,.6),0 0 0 2px #334155 inset;box-sizing:border-box}
iframe{width:364px;height:762px;border:0;border-radius:32px;background:#f6f7f9;display:block}
</style></head><body><div class="wrap">
<div class="side"><div class="role" id="role"></div><h2 id="h"></h2><p id="p"></p></div>
<div class="phone"><iframe id="f" src="about:blank"></iframe></div></div>
<script>
const q=new URLSearchParams(location.search);
document.getElementById('role').textContent=q.get('role')||'';
document.getElementById('h').textContent=q.get('title')||'';
document.getElementById('p').textContent=q.get('text')||'';
document.getElementById('f').src=q.get('src')||'/m';
</script></body></html>"""


# --------------------------------------------------------------------------- narration
class Voice:
    """Windows SAPI speech to wav, cached by text."""

    def __init__(self, voice_hint: str = "Zira", rate: int = 0):
        import win32com.client

        self.sp = win32com.client.Dispatch("SAPI.SpVoice")
        self.fs = win32com.client.Dispatch("SAPI.SpFileStream")
        for v in self.sp.GetVoices():
            if voice_hint.lower() in v.GetDescription().lower():
                self.sp.Voice = v
        self.sp.Rate = rate
        self.dir = HERE / "build" / "audio"
        self.dir.mkdir(parents=True, exist_ok=True)

    def wav(self, text: str) -> tuple[Path, float]:
        key = re.sub(r"\W+", "_", text)[:40] + f"_{abs(hash(text)) % 10**8}"
        path = self.dir / f"{key}.wav"
        if not path.exists():
            self.fs.Format.Type = 22  # 22 kHz 16-bit mono
            self.fs.Open(str(path), 3)
            self.sp.AudioOutputStream = self.fs
            self.sp.Speak(text)
            self.fs.Close()
        with wave.open(str(path)) as w:
            return path, w.getnframes() / w.getframerate()


# --------------------------------------------------------------------------- the director
class Director:
    def __init__(self, page, voice: Voice | None, record: bool):
        self.page = page
        self.voice = voice
        self.t0 = time.time()
        self.clips: list[tuple[float, Path]] = []
        self.badge = ""
        self.record = record
        self.shots = HERE / "build" / "shots"
        self.shots.mkdir(parents=True, exist_ok=True)

    # -- time
    def now(self) -> float:
        return time.time() - self.t0

    def pause(self, s: float) -> None:
        self.page.wait_for_timeout(int(s * 1000))

    def until(self, t: float) -> None:
        left = t - self.now()
        if left > 0:
            self.pause(left)

    def shot(self, name: str) -> None:
        self.page.screenshot(path=str(self.shots / f"{name}.png"))

    # -- overlay
    def _js(self, fn: str, *args) -> None:
        self.page.evaluate("([fn, args]) => { const d = window.__demo; if (d) d[fn](...args) }", [fn, list(args)])

    def say(self, text: str, caption: str | None = None, wait: bool = True, extra: float = 0.5) -> float:
        """Show a caption and speak `text`. Returns the time the narration ends."""
        self._js("caption", self.badge, caption if caption is not None else text)
        end = self.now()
        if self.voice and text:
            path, dur = self.voice.wav(text)
            self.clips.append((self.now(), path))
            end = self.now() + dur + extra
        else:
            end = self.now() + max(1.5, len(text) / 16)
        if wait:
            self.until(end)
        return end

    def silent_caption(self, text: str, seconds: float = 2.5) -> None:
        self._js("caption", self.badge, text)
        self.pause(seconds)

    def hide_caption(self) -> None:
        self._js("caption", "", "")

    def step(self, badge: str) -> None:
        self.badge = badge

    def card(self, kicker: str, title: str, body: str = "", items=None, narrate: str | None = None, hold: float = 2.0) -> None:
        self.hide_caption()
        self._js("card", kicker, title, body, items or [])
        self.pause(0.8)
        if narrate:
            self.say(narrate, caption="", wait=True, extra=0.6)
            self._js("caption", "", "")
        else:
            self.pause(hold)
        self._js("card", "", "", "", [])
        self.pause(0.7)

    # -- pointing
    def _center(self, loc):
        box = loc.first.bounding_box()
        if not box:
            raise RuntimeError("no box for locator")
        return box

    def point(self, loc, press: bool = False, travel: float = 0.9) -> None:
        loc.first.scroll_into_view_if_needed()
        self.pause(0.3)
        b = self._center(loc)
        x, y = b["x"] + min(b["width"] / 2, 90), b["y"] + b["height"] / 2
        self._js("cursor", x, y, False)
        self.pause(travel)
        if press:
            self._js("cursor", x, y, True)
            self.pause(0.2)

    def click(self, loc, travel: float = 0.9, after: float = 0.6, soft: bool = False) -> None:
        """Move the cursor and click. With soft=True a disabled control is pointed at but not pressed."""
        self.point(loc, press=True, travel=travel)
        if soft and not loc.first.is_enabled():
            return
        loc.first.click()
        self.pause(after)

    def type(self, loc, text: str, delay_ms: int = 90) -> None:
        self.point(loc, press=True, travel=0.7)
        loc.first.click()
        loc.first.press_sequentially(text, delay=delay_ms)
        self.pause(0.5)

    def ring(self, loc, label: str = "", side: str = "above", key: str = "a", scroll: bool = True) -> None:
        if scroll:
            loc.first.scroll_into_view_if_needed()
            self.pause(0.3)
        b = self._center(loc)
        self._js("ring", key, {"x": b["x"], "y": b["y"], "w": b["width"], "h": b["height"]}, label, side)

    def unring(self) -> None:
        self._js("clearRings")

    def scroll_to(self, loc) -> None:
        loc.first.scroll_into_view_if_needed()
        self.pause(0.6)

    # -- navigation
    def goto(self, path: str, wait: float = 2.0) -> None:
        self.unring()
        self.page.goto(BASE + path)
        self.page.wait_for_load_state("domcontentloaded")
        self.pause(wait)

    def phone(self, src: str, role: str, title: str, text: str, wait: float = 2.5) -> None:
        q = "&".join(f"{k}={v}" for k, v in {"src": src, "role": role, "title": title, "text": text}.items())
        self.goto("/__phone?" + re.sub(r" ", "%20", q).replace("#", "%23"), wait=wait)

    @property
    def app(self):
        """The app inside the phone frame."""
        return self.page.frame_locator("#f")


def api(page, method: str, path: str, body=None):
    fn = page.request.post if method == "POST" else page.request.get
    r = fn(API + path, data=json.dumps(body), headers={"content-type": "application/json"}) if body is not None else fn(API + path)
    return r.json()


# --------------------------------------------------------------------------- output
def mix_audio(clips: list[tuple[float, Path]], total: float, out: Path) -> None:
    sr = 22050
    buf = np.zeros(int((total + 2) * sr), dtype=np.float32)
    for t, p in clips:
        with wave.open(str(p)) as w:
            assert w.getframerate() == sr and w.getsampwidth() == 2 and w.getnchannels() == 1, (w.getframerate(), w.getsampwidth(), w.getnchannels())
            a = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
        i = int(t * sr)
        buf[i:i + len(a)] += a[: len(buf) - i]
    buf = np.clip(buf, -1, 1)
    with wave.open(str(out), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((buf * 32767).astype(np.int16).tobytes())


def encode(video: Path, audio: Path | None, out: Path, audio_delay: float = 0.0) -> None:
    import imageio_ffmpeg

    ff = imageio_ffmpeg.get_ffmpeg_exe()
    cmd = [ff, "-y", "-i", str(video)]
    if audio:
        cmd += ["-itsoffset", str(audio_delay), "-i", str(audio)]
    cmd += ["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-r", "30"]
    if audio:
        cmd += ["-c:a", "aac", "-b:a", "160k", "-map", "0:v:0", "-map", "1:a:0", "-shortest"]
    cmd += ["-movflags", "+faststart", str(out)]
    subprocess.run(cmd, check=True, capture_output=True)
