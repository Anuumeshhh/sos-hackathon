"""Real hospital locations around Itahari from OpenStreetMap (Overpass API).

Cached for 24h in memory and on disk so the demo keeps working offline after one successful fetch.
Real *ambulance availability* has no public data source, so the fleet stays a labelled simulation.
"""
import json
import os
import time
from pathlib import Path
from typing import Optional

try:
    import requests
except ImportError:  # pragma: no cover
    requests = None

CENTER = (26.6646, 87.2718)
RADIUS_M = 25000
CACHE_TTL = 24 * 3600
CACHE_FILE = Path(os.getenv("RAPIDAID_HOSPITAL_CACHE", Path(__file__).resolve().parent / "hospitals_cache.json"))
ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
QUERY = f'[out:json][timeout:25];nwr["amenity"="hospital"](around:{RADIUS_M},{CENTER[0]},{CENTER[1]});out center tags;'

_memory: Optional[dict] = None


def _parse(elements: list) -> list:
    out, seen = [], set()
    for el in elements:
        tags = el.get("tags", {})
        lat = el.get("lat") or (el.get("center") or {}).get("lat")
        lng = el.get("lon") or (el.get("center") or {}).get("lon")
        if lat is None or lng is None:
            continue
        name = tags.get("name:en") or tags.get("name") or "Hospital (unnamed)"
        key = (name.lower(), round(lat, 3), round(lng, 3))
        if key in seen:
            continue
        seen.add(key)
        out.append({
            "name": name,
            "lat": round(lat, 6),
            "lng": round(lng, 6),
            "phone": tags.get("phone") or tags.get("contact:phone") or None,
            "emergency": tags.get("emergency") == "yes",
        })
    return out


def _fetch() -> Optional[list]:
    if requests is None:
        return None
    for url in ENDPOINTS:
        try:
            res = requests.post(url, data={"data": QUERY}, timeout=15, headers={"User-Agent": "RapidAid-hackathon/2.2"})
            if res.ok:
                return _parse(res.json().get("elements", []))
        except Exception:
            continue
    return None


def get_hospitals() -> dict:
    global _memory
    now = time.time()
    if _memory and now - _memory["fetched_at"] < CACHE_TTL:
        return _memory
    if _memory is None and CACHE_FILE.exists():
        try:
            _memory = json.loads(CACHE_FILE.read_text())
            if now - _memory["fetched_at"] < CACHE_TTL:
                return _memory
        except Exception:
            _memory = None
    fresh = _fetch()
    if fresh:
        _memory = {"hospitals": fresh, "source": "OpenStreetMap", "fetched_at": now}
        try:
            CACHE_FILE.write_text(json.dumps(_memory))
        except OSError:
            pass
        return _memory
    if _memory:  # stale cache is better than nothing
        return _memory
    return {"hospitals": [], "source": "unavailable", "fetched_at": 0}
