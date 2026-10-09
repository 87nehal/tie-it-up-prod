"""Use cases 9 and 10: concern interpretation (Concern-Cause-Correction) and estimate automation.

Interpretation runs a keyword matcher over the demand-code taxonomy first. When the
Ollama Cloud LLM is configured, it is asked to map the same text onto the *same closed set*
of demand codes (the schema enum forbids inventing one). Agreement raises confidence;
grounded model-only suggestions remain subject to advisor confirmation.
"""

from __future__ import annotations

import re
from datetime import date
from typing import Any

from app import llm
from app.service.catalog import (
    CAMPAIGNS, DEMAND_CODES, GST, LABOUR_OPS, LABOUR_RATE, PARTS, PMS_INTERVAL_KM,
    WARRANTY_KM, WARRANTY_YEARS,
)

SUFFICIENT = 0.6
# Symptom descriptions justify inspection, not a specific replacement part.
DIAGNOSIS_FIRST = frozenset({
    "BRK-NOISE", "BRK-WEAK", "AC-COOL", "ENG-NOISE", "RR-NOISE",
    "ENG-MIL", "ENG-HEAT", "ENG-OIL", "BAT-START", "SUS-NOISE",
    "STR-PULL", "CLU-HARD", "BRK-CHECK", "ENG-PERF", "EXH-SMOKE", "ELEC-CHG",
    "ELEC-ACC", "WARN-LIGHT", "SAF-SRS", "FUEL-EFF", "TYRE", "BODY-DENT", "BODY-RATTLE",
})
# Concerns the car or its record raised, not the customer.
VEHICLE_SOURCES = frozenset({"telemetry model", "history"})
# courtesy phrases, not concerns ("please quote", "kindly check")
_FILLER = re.compile(r"^(?:(?:please|pls|kindly)(?:\s+(?:quote|check))?|thanks|thank you|ok)$", re.I)
_SPLIT = re.compile(r"[.;\n!?&+]|,|\band also\b|\balso\b|\bplus\b|\baur\b|\bbhi\b|\band\b|\bbut\b|"
                    r"\bhowever\b|\blekin\b|\bmagar\b|\bthough\b|और|लेकिन|।", re.I)

# Workshop terms for the offline matcher; results keep the original customer quote.
_HINDI = {
    "एयर कंडीशनर": " ac ", "एसी": " ac ",
    "ब्रेक": " brake ", "इंजन": " engine ", "आवाज़": " noise ", "आवाज": " noise ",
    "ठंडी": " cold ", "ठंडा": " cold ", "ठंड": " cold ", "गर्म": " hot ",
    "गरम": " hot ", "नहीं": " nahi ", "नही": " nahi ", "कमजोर": " weak ",
    "बैटरी": " battery ", "स्टार्ट": " start ", "चालू": " start ", "पीछे": " rear ",
    "सर्विस": " service ", "सर्विसिंग": " service ", "धुआं": " smoke ", "धुआँ": " smoke ",
    "टायर": " tyre ", "पंक्चर": " puncture ", "क्लच": " clutch ", "गियर": " gear ",
    "स्टीयरिंग": " steering ", "वाइब्रेशन": " vibration ", "लाइट": " light ",
    "तेल": " oil ", "लीक": " leak ", "हॉर्न": " horn ", "वाइपर": " wiper ",
    "खराब": " problem ", "काम": " work ", "माइलेज": " mileage ", "कम": " weak ",
    "सख्त": " hard ", "कड़क": " hard ", "ठीक": " fine ", "धुलाई": " wash ",
}


def _normalized(text: str) -> str:
    for word in sorted(_HINDI, key=len, reverse=True):
        text = text.replace(word, _HINDI[word])
    return text

# ------------------------------------------------------------ concept matcher
# A pattern is a tuple of word groups; it matches a clause when every group has a
# word in it. Stems of 4+ letters match as prefixes ("brak" -> brake, brakes, braking),
# shorter ones, and any stem written "=word", must match exactly ("ac"). Requiring a component *and* a symptom is
# what stops "brake service" becoming a service job or "ABS warning light" a
# check-engine job, which the old flat keyword list did.
BRAKE = ("brak", "brek", "=break", "=breaks", "=breaking")  # not "speed breaker"
NOISE = ("nois", "sound", "awaaz", "awaz", "awaj", "aawaz", "aavaz", "squeal", "squeak", "screech",
         "grind", "creak", "rattl", "clunk", "thud", "knock", "khat", "khad", "katkat", "chu", "chun",
         "whin", "hum", "click", "tick")
NEG = ("not", "nahi", "nahin", "nhi", "no", "na", "isn", "doesn", "don", "won", "never", "stopped",
       "band", "kharab", "problem", "issue", "dikkat")
WEAK = ("weak", "kam", "low", "less", "poor", "bad", "drop", "decreas", "reduc", "down", "kamzor")
AC = ("ac", "aircon", "hvac", "conditioner", "aircondition")
ENGINE = ("engine", "motor", "bonnet", "hood")
REAR = ("back", "rear", "peeche", "piche", "pichhe", "pichle", "peechhe", "dikki", "boot", "trunk")
LIGHT = ("light", "lamp", "indicator", "symbol", "sign")
WARN = ("warning", "warn", "dashboard", "cluster", "meter")
BARE = 0.5  # strength of a component named without any symptom

PATTERNS: dict[str, list[tuple[tuple[str, ...], ...]]] = {
    # most specific first: ties on match strength go to the earlier code
    "SAF-SRS": [(("abs", "airbag", "srs", "air bag"), LIGHT + WARN), (("abs", "airbag", "srs", "air bag"),)],
    "ELEC-CHG": [(("battery", "charging", "alternator"), LIGHT), (("charging",), ("problem", "issue", "not", "nahi"))],
    "ENG-MIL": [(("check",), ENGINE, LIGHT), (ENGINE, LIGHT), (("mil",),), (("malfunction",),)],
    "ENG-HEAT": [(("overheat",),), (("temperatur", "temp", "gauge"), ("high", "badh", "red", "up", "rising", "zyada")),
                 (("heating",), ("up",)), (ENGINE + ("gaadi", "car"), ("garam", "hot", "heat")),
                 (("coolant", "radiator"), ("leak", "low", "kam", "boil", "empty", "tapak", "khatam"))],
    "ENG-OIL": [(("oil",), ("pressure", "light", "lamp")), (("oil",), ("leak", "drip", "tapak", "consum", "low", "kam", "seep"))],
    "BRK-WEAK": [(BRAKE, ("weak", "spong", "soft", "kam", "fade", "late", "loose", "deep", "kamzor")),
                 (BRAKE, NEG, ("work", "lag", "grip", "stop", "hold", "effective", "properly")),
                 (("pedal",), ("spong", "soft", "sink", "floor", "deep", "down")),
                 (BRAKE, ("fluid", "oil"), ("leak", "low", "kam", "tapak"))],
    "BRK-NOISE": [(BRAKE, NOISE), (BRAKE, ("vibrat", "shudder", "judder", "pulsat", "shake", "shaking"))],
    "BRK-CHECK": [(BRAKE, ("service", "check", "inspect", "pad", "shoe", "disc", "liner", "change", "replace", "badal"))],
    "AC-COOL": [(AC, ("cool", "thand", "chill", "cold", "garam", "hot", "warm", "weak", "kam", "air", "blow", "work", "gas", "service", "check")),
                (AC, NEG), (("cooling",), NEG + WEAK), (("thanda", "thandi"), ("nahi", "nhi", "kam", "not", "no"))],
    "RR-NOISE": [(REAR, NOISE), (REAR, ("shocker", "shock", "suspens", "strut"))],
    "EXH-SMOKE": [(("smoke", "dhuan", "dhua", "dhuaan", "dhuva"),),
                  (("exhaust", "silencer", "muffler"), NOISE + ("loud", "leak", "black", "white", "blue"))],
    "ENG-NOISE": [(ENGINE, NOISE), (("knocking", "pinging", "tappet"),)],
    "ENG-PERF": [(("pickup", "power", "acceler", "torque"), WEAK + NEG), (("misfir",),),
                 (("jerk", "jhatka", "jhatke", "hesitat"),), (ENGINE, ("weak", "kamzor", "stall", "dies"))],
    "BAT-START": [(("start", "crank", "self", "starting"), NEG + ("slow", "late", "difficult", "mushkil", "hard", "trouble")),
                  (("battery", "batt"), ("weak", "dead", "down", "discharg", "drain", "kamzor", "low", "change",
                                         "replace", "khatam", "problem", "issue")),
                  (("jump",), ("start",)), (("battery",),)],
    "SUS-NOISE": [(("suspens", "shocker", "shock", "strut", "bump", "breaker", "pothole", "gaddh", "gadd"), NOISE),
                  (("khat",),), (("suspens", "shocker", "shock absorber"),)],
    "TYRE": [(("tyre", "tire", "wheel"), ("wear", "worn", "punct", "flat", "pressure", "bald", "cut", "bulge", "uneven", "hawa")),
             (("punctur",),)],
    "STR-PULL": [(("pull", "drift"),), (("alignment",),), (("balanc",),),
                 (("steer",), ("vibrat", "shake", "wobbl", "hard", "heavy", "tight", "loose", "play")),
                 (("vibrat", "wobbl"), ("speed", "high", "80", "90", "100", "highway"))],
    "CLU-HARD": [(("clutch",),), (("gear",), ("hard", "stuck", "shift", "slip", "nahi", "not", "grind", "difficult",
                                              "tight", "jam", "lag", "problem"))],
    "BODY-DENT": [(("bumper", "door", "panel", "bonnet", "fender", "body", "quarter", "tailgate"),
                   ("dent", "scratch", "damage", "broken", "toot", "crack", "paint")),
                  (("dent", "denting"),), (("scratch",),), (("accident",),), (("rust",),), (("paint", "repaint"),)],
    "BODY-RATTLE": [(("door", "dashboard", "dash", "interior", "cabin", "seat", "glass", "window", "trim"), NOISE)],
    "ELEC-ACC": [(("horn", "wiper", "window", "headlight", "headlamp", "taillight", "fog", "light", "lamp", "indicator",
                   "music", "stereo", "speaker", "infotainment", "screen", "display", "camera", "sensor", "usb",
                   "charger", "mirror", "lock", "remote", "key", "blower"),
                  NEG + ("dim", "fuse", "flicker", "slow", "stuck", "broken", "work", "blank", "dead"))],
    "WARN-LIGHT": [(WARN, LIGHT), (("warning",),)],
    "FUEL-EFF": [(("mileage", "average", "kmpl", "efficien", "economy"), WEAK + ("giving",)),
                 (("fuel", "petrol", "diesel", "cng"), ("consum", "efficien", "economy", "zyada", "more", "drink"))],
    "PMS": [(("service", "servicing", "periodic", "pms", "maintenance"),), (("oil",), ("change", "replace", "badal", "top"))],
    "WASH": [(("wash", "clean", "vacuum", "polish", "detailing"),)],
}
# A matched code is dropped when one of these words is in the clause: it belongs elsewhere.
EXCLUDE: dict[str, tuple[str, ...]] = {
    "ENG-MIL": ("abs", "airbag", "srs", "battery", "charging", "oil", "temperatur", "tyre", "tire"),
    "WARN-LIGHT": ("abs", "airbag", "srs", "battery", "charging", "engine", "oil", "temperatur"),
    "ENG-HEAT": AC + ("thanda", "cooling"),
    "BAT-START": ("light", "lamp", "warning"),
    "ELEC-ACC": WARN + ("abs", "airbag", "engine", "battery", "brak", "check"),
    "PMS": BRAKE + AC,
    "STR-PULL": BRAKE,
}
# One-word patterns naming a component with no symptom: kept, but the advisor confirms.
BARE_PATTERNS = {(("battery",),), (("suspens", "shocker", "shock absorber"),), (("warning",),)}
# "AC is fine", "brakes are ok", "no problem with the clutch": not a concern
_FINE = re.compile(r"\b(fine|ok|okay|good|normal|theek|thik|perfect|sahi|badhiya)\b", re.I)
_NO_PROBLEM = re.compile(r"\bno (problem|issue|complaint)s?\b|\bkoi (dikkat|problem) nahi\b", re.I)
_FAULT = re.compile(r"\b(not|nahi|nhi|isn'?t|doesn'?t|won'?t|problem|issue|noise|awaaz|weak|kharab|dikkat)\b", re.I)


def _stem_in(tokens: list[str], joined: str, stems: tuple[str, ...]) -> bool:
    for w in stems:
        if " " in w:
            if f" {w} " in f" {joined} ":
                return True
        elif w.startswith("="):
            if w[1:] in tokens:
                return True
        elif any(t == w or (len(w) >= 4 and t.startswith(w)) for t in tokens):
            return True
    return False


def _negated(clause: str) -> bool:
    """The customer says the system is fine ("AC cooling is fine", "no issue with brakes")."""
    clause = _normalized(clause)
    if _NO_PROBLEM.search(clause):
        return True
    return bool(_FINE.search(clause)) and not _FAULT.search(clause)


def _match(text: str) -> list[tuple[str, float]]:
    """Codes matching one clause with their strength (word groups matched), strongest first."""
    tokens = re.findall(r"[a-z0-9]+", _normalized(text).lower())
    joined = " ".join(tokens)
    hits: list[tuple[str, float, int]] = []
    for rank, (code, patterns) in enumerate(PATTERNS.items()):
        if code in EXCLUDE and _stem_in(tokens, joined, EXCLUDE[code]):
            continue
        best = 0.0
        for pattern in patterns:
            if all(_stem_in(tokens, joined, group) for group in pattern):
                best = max(best, BARE if pattern in BARE_PATTERNS else float(len(pattern)))
        if best:
            hits.append((code, best, rank))
    hits.sort(key=lambda h: (-h[1], h[2]))
    return [(code, n) for code, n, _ in hits]


def _entry(code: str, words: str, confidence: float, source: str) -> dict[str, Any]:
    d = DEMAND_CODES[code]
    return {"customer_words": words, "demand_code": code, "label": d["label"], "system": d["system"],
            "cause": d["cause"], "correction": d["correction"], "confidence": round(confidence, 2),
            "source": source,
            "explanation": f"The customer's wording ‘{words}’ matches {d['label']} ({code}). "
                           "The listed cause is a possibility; confirm it with the recommended checks."}


_REAR = re.compile(r"\b(back|rear|peeche|piche|pichhe|pichle|dikki|boot|trunk)\b", re.I)
_ENGINE = re.compile(r"\b(engine|bonnet|hood)\b", re.I)
_NOISY = re.compile(r"\b(noise|noisy|sound|awaaz|awaz|awaj|rattle|khat|thud|clunk)\b", re.I)


def _locate(clause: str, codes: list[str]) -> list[str]:
    """A noise placed at the back of the car is never an engine job unless the customer
    names the engine: front-engine, front-wheel-drive layout."""
    clause = _normalized(clause)
    if _REAR.search(clause) and not _ENGINE.search(clause) and ("ENG-NOISE" in codes or _NOISY.search(clause)):
        codes = ["RR-NOISE"] + [c for c in codes if c not in ("ENG-NOISE", "RR-NOISE", "SUS-NOISE")]
    return codes


def _confidence(strength: float) -> float:
    """Component + symptom (2 groups) 0.85, three groups 0.9, one telling word ("overheating")
    0.7, a bare component name ("battery") 0.5 so the advisor confirms it."""
    if strength <= BARE:
        return 0.5
    if strength == 1:
        return 0.7
    return min(0.9, 0.55 + 0.15 * strength)


def _rules(text: str) -> tuple[list[dict[str, Any]], list[str]]:
    found: dict[str, dict[str, Any]] = {}
    unmatched: list[str] = []
    for clause in (c.strip() for c in _SPLIT.split(text) if c and c.strip()):
        if len(clause) < 3 or _FILLER.match(clause) or _negated(clause):
            continue
        strength = dict(_match(clause))
        located = _locate(clause, list(strength))
        if not located:
            unmatched.append(clause)
            continue
        # A clause describes one complaint: keep the strongest code only, so one noise
        # never turns into two jobs (and two sets of parts on the estimate).
        code = located[0]
        conf = _confidence(strength.get(code, 2))
        if code not in found or found[code]["confidence"] < conf:
            found[code] = _entry(code, clause, conf, "rules")
    if not found and not unmatched and text.strip() and not _negated(text):
        unmatched.append(text.strip())
    return list(found.values()), unmatched


def _llm(text: str) -> list[dict[str, Any]] | None:
    codes = list(DEMAND_CODES) + ["UNKNOWN"]
    menu = "\n".join(f"{c}: {d['label']}" for c, d in DEMAND_CODES.items())
    out = llm.decide(
        "You are a Maruti Suzuki service advisor. Split the customer's words (may be Hindi, "
        "Hinglish or English) into separate concerns and map each to one demand code. "
        "customer_words must be a verbatim quote copied from the customer, not a translation. "
        "Include every distinct complaint or requested service. Do not add faults, parts or "
        "service requests that were not mentioned. Ignore systems said to be fine. "
        "Maruti cars are front-engine, front-wheel drive: a noise from the back/rear is suspension, "
        "wheel bearing, rear brakes or exhaust (RR-NOISE), never ENG-NOISE unless the engine is named. "
        f"Use UNKNOWN if none fits.\n\nDemand codes:\n{menu}\n\nCustomer said: {text}",
        {
            "type": "object",
            "properties": {
                "concerns": {
                    "type": "array", "maxItems": 24,
                    "items": {
                        "type": "object",
                        "properties": {
                            "customer_words": {"type": "string", "maxLength": 160},
                            "demand_code": {"enum": codes},
                        },
                        "required": ["customer_words", "demand_code"],
                    },
                }
            },
            "required": ["concerns"],
        },
        max_tokens=1800,
    )
    if not out:
        return None
    for c in out["concerns"]:  # same layout rule as the keyword matcher
        c["demand_code"] = _locate(c["customer_words"] or text, [c["demand_code"]])[0]
    return out["concerns"]


def telemetry_concerns(telemetry: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Concerns raised by the car itself: findings of the telemetry model on its OBD log."""
    if not telemetry or not telemetry.get("codes"):
        return []
    evidence = telemetry["rule_hits"] or [telemetry["reason"].split(".")[0]]
    return [_entry(code, f"OBD: {evidence[min(i, len(evidence) - 1)]}", 0.85, "telemetry model")
            for i, code in enumerate(telemetry["codes"])]


def interpret(text: str, vehicle: dict[str, Any] | None = None, use_llm: bool = True) -> dict[str, Any]:
    rules, unmatched = _rules(text)
    engine = "rules"
    merged = {c["demand_code"]: c for c in rules}
    llm_out = _llm(text) if use_llm and text.strip() else None
    if llm_out is not None:
        model_engine = llm.decision_engine() or llm.engine()
        engine = f"rules+{model_engine}"
        # A schema-valid code is not evidence: require a quote present in the input.
        grounded = [c for c in llm_out if c["customer_words"].strip()
                    and c["customer_words"].strip().casefold() in text.casefold()
                    and not _negated(c["customer_words"])]
        llm_codes = {c["demand_code"] for c in grounded if c["demand_code"] in DEMAND_CODES}
        for code in list(merged):
            if code in llm_codes:
                merged[code]["confidence"] = round(min(0.97, merged[code]["confidence"] + 0.2), 2)
                merged[code]["source"] = engine
                merged[code]["explanation"] += " The language model also matched this code."
        # Model omissions must not weaken clear rule matches. Model-only codes can
        # resolve unfamiliar wording, but the advisor confirms them before approval.
        for c in grounded:
            code, words = c["demand_code"], c["customer_words"].strip()
            if code not in DEMAND_CODES:
                continue
            matches = [u for u in unmatched if words.casefold() in u.casefold()]
            if code not in merged and matches:
                merged[code] = _entry(code, words, 0.55, model_engine)
                merged[code]["explanation"] = (
                    f"The language model mapped the customer's quote ‘{words}’ to "
                    f"{DEMAND_CODES[code]['label']} ({code}). The offline matcher could not "
                    "confirm it; the advisor must verify the symptom and demand code."
                )
            elif matches:
                merged[code]["confidence"] = min(merged[code]["confidence"], 0.55)
                merged[code]["explanation"] += (
                    f" The model also linked ‘{words}’ to this code; the advisor must confirm this additional wording."
                )
            if matches:
                # Preserve portions of a clause the model did not explain.
                unmatched = [re.sub(re.escape(words), "", u, flags=re.I).strip(" ,;:-")
                             if u in matches else u for u in unmatched]
                unmatched = [u for u in unmatched if u and not _FILLER.match(u)]
    if vehicle:
        for c in telemetry_concerns(vehicle.get("telemetry")):
            c["explanation"] = f"The car's sensor data reported ‘{c['customer_words']}’. Confirm the finding before work starts."
            merged.setdefault(c["demand_code"], c)
        if vehicle["odometer"] - vehicle["last_service_km"] >= PMS_INTERVAL_KM * 0.9 and "PMS" not in merged:
            merged["PMS"] = _entry("PMS", "Service interval reached", 0.9, "history")
            merged["PMS"]["explanation"] = (
                f"The car has travelled {vehicle['odometer'] - vehicle['last_service_km']:,} km "
                f"since its last service, reaching the {PMS_INTERVAL_KM:,} km service window."
            )
    # What the customer said leads; telemetry / history additions follow, so they don't
    # bury the customer's words under the same rows on every interpretation.
    concerns = sorted(merged.values(),
                      key=lambda c: (c["source"] in VEHICLE_SOURCES, -c["confidence"]))
    low = [c for c in concerns if c["confidence"] < SUFFICIENT]
    sufficient = bool(concerns) and not low and not unmatched
    return {
        "text": text, "engine": engine, "llm_available": llm.available(),
        "concerns": concerns, "unmatched": unmatched, "sufficient": sufficient,
        "decision": "auto" if sufficient else "manual_review",
        "note": None if sufficient else "Low confidence or unmapped words: advisor must confirm demand codes",
    }


# ------------------------------------------------------------------ estimate

def warranty_status(vehicle: dict[str, Any], today: date | None = None) -> dict[str, Any]:
    today = today or date.today()
    age = (today - date.fromisoformat(vehicle["sale_date"])).days / 365
    active = age <= WARRANTY_YEARS and vehicle["odometer"] <= WARRANTY_KM
    return {"active": active, "age_years": round(age, 1), "odometer": vehicle["odometer"],
            "limit": f"{WARRANTY_YEARS} years / {WARRANTY_KM:,} km"}


def campaigns_for(vehicle: dict[str, Any]) -> list[dict[str, Any]]:
    serial = int(re.sub(r"\D", "", vehicle["vin"][-6:]) or 0)
    return [c for c in CAMPAIGNS if vehicle["model"] in c["models"] and serial <= c["vin_serial_max"]]


def estimate(codes: list[str], vehicle: dict[str, Any], availability=None) -> dict[str, Any]:
    """Map demand codes to labour, parts, standard time and payer. `availability` is a
    callable(part_no, qty) -> dict from the parts module, injected to keep this pure."""
    warranty = warranty_status(vehicle)
    lines: list[dict[str, Any]] = []
    seen_parts: dict[str, int] = {}
    for code in codes:
        d = DEMAND_CODES.get(code)
        if d is None:
            continue
        payer = "warranty" if warranty["active"] and d["warrantable"] else "customer"
        for op in d["labour"]:
            L = LABOUR_OPS[op]
            lines.append({"id": f"{code}:{op}", "type": "labour", "demand_code": code, "code": op,
                          "desc": L["desc"], "qty": L["hours"], "unit_price": LABOUR_RATE,
                          "amount": round(L["hours"] * LABOUR_RATE), "payer": payer,
                          "skill": d["skill"], "hours": L["hours"]})
        for part_no, qty in ([] if code in DIAGNOSIS_FIRST else d["parts"]):
            if part_no in seen_parts:
                continue
            seen_parts[part_no] = qty
            P = PARTS[part_no]
            line = {"id": f"{code}:{part_no}", "type": "part", "demand_code": code, "code": part_no,
                    "desc": P["name"], "qty": qty, "unit_price": P["price"],
                    "amount": P["price"] * qty, "payer": payer}
            if availability:
                line["availability"] = availability(part_no, qty)
                alt = line["availability"].get("alternative")
                if alt:
                    line.update(code=alt, desc=PARTS[alt]["name"], unit_price=PARTS[alt]["price"],
                                amount=PARTS[alt]["price"] * qty, substituted_for=part_no)
            lines.append(line)
    for c in campaigns_for(vehicle):
        L = LABOUR_OPS[c["labour"]]
        lines.append({"id": f"{c['code']}", "type": "labour", "demand_code": c["code"], "code": c["labour"],
                      "desc": f"Campaign {c['code']}: {c['title']}", "qty": L["hours"],
                      "unit_price": LABOUR_RATE, "amount": round(L["hours"] * LABOUR_RATE),
                      "payer": "campaign", "skill": "general", "hours": L["hours"]})
    cust = [ln for ln in lines if ln["payer"] == "customer"]
    labour = sum(ln["amount"] for ln in cust if ln["type"] == "labour")
    parts = sum(ln["amount"] for ln in cust if ln["type"] == "part")
    tax = round((labour + parts) * GST)
    return {
        "lines": lines, "warranty": warranty, "campaigns": campaigns_for(vehicle),
        "note": "Diagnostic estimate. Repair parts and final cost require advisor inspection and customer approval."
                if any(code in DIAGNOSIS_FIRST for code in codes) else None,
        "labour_hours": round(sum(ln.get("hours", 0) for ln in lines), 1),
        "totals": {"labour": labour, "parts": parts, "gst": tax, "customer_payable": labour + parts + tax,
                   "warranty_value": sum(ln["amount"] for ln in lines if ln["payer"] == "warranty"),
                   "campaign_value": sum(ln["amount"] for ln in lines if ln["payer"] == "campaign")},
    }
