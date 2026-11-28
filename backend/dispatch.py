import math
import time
import uuid
import json
import sqlite3
import os
import threading
from enum import Enum
from typing import Dict, Optional, Tuple
from fastapi import HTTPException

try:
    import requests
except ImportError:  # routing falls back to straight lines
    requests = None

import hospitals
from models import (
    Ambulance,
    AmbulanceStatus,
    AssignPayload,
    CreateRequestPayload,
    EmergencyRequest,
    RequestStatus,
    SystemState,
    TriagePayload,
    SeverityLevel,
)

MAX_ACTIVE_INCIDENTS = 25
COOLDOWN_SECONDS = 15
ARRIVED_HOLD_SECONDS = 6
HISTORY_TTL_SECONDS = 60
DUPLICATE_RADIUS_METERS = 150.0


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    # straight-line distance in km; avoids external routing api rate limits/latency
    earth_radius_km = 6371.0
    d_lat = math.radians(lat2 - lat1)
    d_lng = math.radians(lng2 - lng1)
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(d_lng / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return round(earth_radius_km * c, 3)


def fetch_road_route(lat1: float, lng1: float, lat2: float, lng2: float):
    """Real road geometry from the public OSRM server. Returns (points, km, seconds) or None."""
    if requests is None or os.getenv("RAPIDAID_ROUTING", "on").lower() == "off":
        return None
    try:
        url = f"https://router.project-osrm.org/route/v1/driving/{lng1},{lat1};{lng2},{lat2}?overview=full&geometries=geojson"
        res = requests.get(url, timeout=3.5, headers={"User-Agent": "RapidAid-hackathon/2.2"})
        data = res.json()
        if data.get("code") != "Ok":
            return None
        route = data["routes"][0]
        pts = [[c[1], c[0]] for c in route["geometry"]["coordinates"]]
        if len(pts) > 250:  # keep the 1.5s poll light
            step = len(pts) / 250.0
            pts = [pts[int(i * step)] for i in range(250)] + [pts[-1]]
        return pts, round(route["distance"] / 1000.0, 2), float(route["duration"])
    except Exception:
        return None


def point_along(route, fraction: float):
    fraction = max(0.0, min(1.0, fraction))
    seg = [haversine_km(route[i][0], route[i][1], route[i + 1][0], route[i + 1][1]) for i in range(len(route) - 1)]
    total = sum(seg) or 1e-9
    target = total * fraction
    done = 0.0
    for i, length in enumerate(seg):
        if done + length >= target:
            t = (target - done) / length if length else 0.0
            return route[i][0] + (route[i + 1][0] - route[i][0]) * t, route[i][1] + (route[i + 1][1] - route[i][1]) * t
        done += length
    return route[-1][0], route[-1][1]


def estimate_eta_seconds(distance_km: float) -> int:
    # compress real travel time (45 km/h * 0.25) so full dispatch -> arrival finishes in ~20-60s
    if distance_km <= 0.05:
        return 10
    simulated_seconds = int((distance_km / 45.0) * 3600 * 0.25) + 12
    return max(15, min(simulated_seconds, 180))


class DispatchManager:
    """Thread-safe dispatch state machine backed by SQLite (rapidaid.db)."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self.ambulances: Dict[str, Ambulance] = {}
        self.requests: Dict[str, EmergencyRequest] = {}
        self.phone_cooldowns: Dict[str, float] = {}
        self.db_path = os.getenv("RAPIDAID_DB_PATH", os.path.join(os.path.dirname(__file__), "rapidaid.db"))
        self._init_db()
        self.reset_state(load_saved=True)

    def _init_db(self) -> None:
        with sqlite3.connect(self.db_path, timeout=10.0) as db:
            db.execute("CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK (id=1), payload TEXT NOT NULL, updated_at REAL NOT NULL)")

    def _persist(self) -> None:
        with self._lock:
            state = {
                "ambulances": [a.model_dump() for a in self.ambulances.values()],
                "requests": [r.model_dump() for r in self.requests.values()],
                "phone_cooldowns": self.phone_cooldowns,
            }
            payload = json.dumps(state, default=lambda value: value.value if isinstance(value, Enum) else str(value))
            with sqlite3.connect(self.db_path, timeout=10.0) as db:
                db.execute("INSERT INTO app_state(id,payload,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at", (payload, time.time()))

    def _load_saved(self) -> bool:
        try:
            with sqlite3.connect(self.db_path, timeout=10.0) as db:
                row = db.execute("SELECT payload FROM app_state WHERE id=1").fetchone()
            if not row:
                return False
            data = json.loads(row[0])
            self.ambulances = {item["id"]: Ambulance(**item) for item in data.get("ambulances", [])}
            self.requests = {item["id"]: EmergencyRequest(**item) for item in data.get("requests", [])}
            self.phone_cooldowns = {str(k): float(v) for k, v in data.get("phone_cooldowns", {}).items()}
            # Older saved demos only had 4 units: add any missing fleet units without touching live ones.
            for unit in self._build_fleet():
                self.ambulances.setdefault(unit.id, unit)
            return bool(self.ambulances)
        except (sqlite3.Error, ValueError, TypeError, KeyError):
            return False

    def reset_state(self, load_saved: bool = False) -> None:
        with self._lock:
            if load_saved and self._load_saved():
                return
            self.ambulances = {amb.id: amb for amb in self._build_fleet()}
            self.requests.clear()
            self.phone_cooldowns.clear()
            self._persist()

    @staticmethod
    def _build_fleet() -> list:
        # Demonstration fleet: sample units, not live hospital telemetry.
        units = [
            ("amb-01", "AMB-01 (Itahari Central)", "Itahari Sub-Metro Health Post", 26.6632, 87.2745),
            ("amb-02", "AMB-02 (Dharan Road)", "BPKIHS Forward Rescue Point", 26.6815, 87.2712),
            ("amb-03", "AMB-03 (Biratnagar Hwy)", "Duhabi Corridor Trauma Unit", 26.6420, 87.2768),
            ("amb-04", "AMB-04 (Purba-Paschim Hwy)", "Kanchi Chowk Rapid Unit", 26.6658, 87.2480),
            ("amb-05", "AMB-05 (Tarahara Road)", "Tarahara Rescue Post", 26.7020, 87.2830),
            ("amb-06", "AMB-06 (Inaruwa Road)", "Inaruwa Link Rescue Post", 26.6560, 87.2330),
            ("amb-07", "AMB-07 (Dharan Gate)", "Dharan Gate Rapid Unit", 26.7450, 87.2700),
        ]
        return [
            Ambulance(id=i, callsign=c, station_name=st, base_lat=lat, base_lng=lng, current_lat=lat, current_lng=lng)
            for i, c, st, lat, lng in units
        ]

    def _find_nearest_hospital(self, lat: float, lng: float) -> Tuple[str, float, float]:
        hosp_list = hospitals.get_hospitals().get("hospitals", [])
        if hosp_list:
            nearest = min(hosp_list, key=lambda h: haversine_km(lat, lng, h["lat"], h["lng"]))
            return nearest["name"], float(nearest["lat"]), float(nearest["lng"])
        return "Itahari Sub-Metro Health Post", 26.6632, 87.2745

    def _clear_ambulance(self, amb: Ambulance, reset_to_base: bool = False) -> None:
        amb.status = AmbulanceStatus.AVAILABLE
        if reset_to_base:
            amb.current_lat, amb.current_lng = amb.base_lat, amb.base_lng
        amb.assigned_request_id = None
        amb.route = None
        amb.route_km = None
        amb.arrived_at = None
        amb.eta_seconds = 0
        amb.eta_total = 0
        amb.phase = None
        amb.destination_name = None
        amb.destination_lat = None
        amb.destination_lng = None

    def _start_return(self, amb: Ambulance) -> None:
        """Send a finished unit driving back to its base. It is AVAILABLE while returning, so a new
        request can be assigned to it and it will start from wherever it currently is."""
        dist_km = haversine_km(amb.current_lat, amb.current_lng, amb.base_lat, amb.base_lng)
        if dist_km < 0.05:
            self._clear_ambulance(amb, reset_to_base=True)
            return
        eta = estimate_eta_seconds(dist_km)
        road = fetch_road_route(amb.current_lat, amb.current_lng, amb.base_lat, amb.base_lng)
        self._clear_ambulance(amb)
        if road:
            amb.route, amb.route_km, road_seconds = road
            eta = max(15, min(int(road_seconds * 0.25) + 12, 180))
        else:
            amb.route, amb.route_km = None, round(dist_km, 2)
        amb.status = AmbulanceStatus.AVAILABLE
        amb.phase = "RETURNING"
        amb.eta_total = eta
        amb.eta_seconds = eta
        amb.destination_name = amb.station_name
        amb.destination_lat = amb.base_lat
        amb.destination_lng = amb.base_lng

    def _advance_return(self, amb: Ambulance, dt_seconds: float) -> None:
        if amb.eta_seconds <= dt_seconds:
            self._clear_ambulance(amb, reset_to_base=True)  # back at base
            return
        if amb.route and amb.eta_total:
            amb.eta_seconds = max(1, int(round(amb.eta_seconds - dt_seconds)))
            amb.current_lat, amb.current_lng = point_along(amb.route, 1 - amb.eta_seconds / float(amb.eta_total))
        else:
            fraction = min(1.0, dt_seconds / float(amb.eta_seconds))
            amb.current_lat += (amb.base_lat - amb.current_lat) * fraction
            amb.current_lng += (amb.base_lng - amb.current_lng) * fraction
            amb.eta_seconds = max(1, int(round(amb.eta_seconds - dt_seconds)))

    def _find_nearest_available(self, lat: float, lng: float) -> Tuple[Optional[Ambulance], Optional[float]]:
        available = [a for a in self.ambulances.values() if a.status == AmbulanceStatus.AVAILABLE]
        if not available:
            return None, None
        nearest = min(available, key=lambda a: haversine_km(a.current_lat, a.current_lng, lat, lng))
        dist = haversine_km(nearest.current_lat, nearest.current_lng, lat, lng)
        return nearest, dist

    def _refresh_nearest_metrics(self) -> None:
        # keep nearest unit suggestions updated after any unit gets dispatched or freed
        for req in self.requests.values():
            if req.status in (RequestStatus.PENDING, RequestStatus.VERIFIED):
                nearest, dist = self._find_nearest_available(req.lat, req.lng)
                req.nearest_unit_id = nearest.id if nearest else None
                req.nearest_unit_callsign = nearest.callsign if nearest else None
                req.nearest_distance_km = dist

    def _check_duplicate(self, phone: str, lat: float, lng: float) -> Tuple[bool, Optional[str]]:
        clean_phone = "".join(ch for ch in phone if ch.isdigit())
        for existing in self.requests.values():
            if existing.status in (RequestStatus.ARRIVED, RequestStatus.FALSE_ALARM):
                continue
            existing_phone = "".join(ch for ch in existing.phone if ch.isdigit())
            if clean_phone and clean_phone == existing_phone:
                return True, f"Same phone number as {existing.id.upper()}"
            dist_meters = haversine_km(existing.lat, existing.lng, lat, lng) * 1000.0
            if dist_meters <= DUPLICATE_RADIUS_METERS:
                return True, f"Within {int(dist_meters)}m of active incident {existing.id.upper()}"
        return False, None

    def create_request(self, payload: CreateRequestPayload) -> EmergencyRequest:
        now = time.time()

        # block non-injury alerts on backend even if client check gets bypassed
        if not payload.injury_confirmed:
            raise HTTPException(
                status_code=400,
                detail="Emergency dispatch blocked: physical injury or medical emergency must be confirmed.",
            )

        patient_name = payload.patient_name.strip()
        if len(patient_name) < 2:
            raise HTTPException(status_code=400, detail="Please enter the patient or caller name.")

        normalized_phone = payload.phone.strip()
        if sum(ch.isdigit() for ch in normalized_phone) < 7:
            raise HTTPException(status_code=400, detail="Please enter a valid callback phone number.")

        if payload.evidence_data and not payload.evidence_data.startswith("data:image/"):
            raise HTTPException(status_code=400, detail="Evidence must be an image.")

        with self._lock:
            active_count = sum(
                1
                for r in self.requests.values()
                if r.status not in (RequestStatus.ARRIVED, RequestStatus.FALSE_ALARM)
            )
            if active_count >= MAX_ACTIVE_INCIDENTS:
                raise HTTPException(
                    status_code=429,
                    detail="Dispatch queue full (max 25 active incidents). Reset demo to clear.",
                )

            last_sent = self.phone_cooldowns.get(normalized_phone, 0)
            elapsed = now - last_sent
            if not payload.bypass_cooldown and elapsed < COOLDOWN_SECONDS:
                remaining = int(math.ceil(COOLDOWN_SECONDS - elapsed))
                raise HTTPException(
                    status_code=429,
                    detail=f"Cooldown active. Wait {remaining}s before sending another alert from this number.",
                )

            is_dup, dup_reason = self._check_duplicate(normalized_phone, payload.lat, payload.lng)
            nearest, dist = self._find_nearest_available(payload.lat, payload.lng)

            req_id = f"inc-{uuid.uuid4().hex[:24]}"
            new_req = EmergencyRequest(
                id=req_id,
                patient_name=patient_name,
                phone=normalized_phone,
                severity=SeverityLevel.STANDARD,
                injury_confirmed=True,
                injury_details=payload.injury_details or ["Caller reports a medical emergency"],
                evidence_data=payload.evidence_data,
                has_evidence=bool(payload.evidence_data),
                lat=payload.lat,
                lng=payload.lng,
                location_label=payload.location_label or "Pinned Map Location",
                status=RequestStatus.PENDING,
                is_duplicate=is_dup,
                duplicate_reason=dup_reason,
                nearest_unit_id=nearest.id if nearest else None,
                nearest_unit_callsign=nearest.callsign if nearest else None,
                nearest_distance_km=dist,
                created_at=now,
            )

            self.requests[req_id] = new_req
            self.phone_cooldowns[normalized_phone] = now
            self._persist()
            return new_req

    def triage_request(self, payload: TriagePayload) -> EmergencyRequest:
        with self._lock:
            req = self.requests.get(payload.request_id)
            if not req:
                raise HTTPException(status_code=404, detail="Emergency request not found.")

            action = payload.action.upper()
            if action == "VERIFY":
                if req.status == RequestStatus.PENDING:
                    req.status = RequestStatus.VERIFIED
                    if payload.severity:
                        req.severity = payload.severity
            elif action == "FALSE_ALARM":
                # Free the assigned unit if the dispatcher dismisses an active alert
                if req.assigned_ambulance_id and req.assigned_ambulance_id in self.ambulances:
                    self._start_return(self.ambulances[req.assigned_ambulance_id])
                req.status = RequestStatus.FALSE_ALARM
                req.eta_seconds = None
                req.transport_phase = None
                req.completed_at = time.time()
                self._refresh_nearest_metrics()
            else:
                raise HTTPException(status_code=400, detail="Invalid triage action. Use VERIFY or FALSE_ALARM.")

            self._persist()
            return req

    def assign_ambulance(self, payload: AssignPayload) -> EmergencyRequest:
        with self._lock:
            req = self.requests.get(payload.request_id)
            if not req:
                raise HTTPException(status_code=404, detail="Emergency request not found.")

            if req.status in (RequestStatus.ASSIGNED, RequestStatus.EN_ROUTE, RequestStatus.ARRIVED):
                raise HTTPException(status_code=400, detail=f"Request is already {req.status.value}.")

            if req.status == RequestStatus.FALSE_ALARM:
                raise HTTPException(status_code=400, detail="Cannot dispatch to a dismissed false alarm.")

            if payload.ambulance_id:
                amb = self.ambulances.get(payload.ambulance_id)
                if not amb:
                    raise HTTPException(status_code=404, detail="Selected ambulance not found.")
                if amb.status != AmbulanceStatus.AVAILABLE:
                    raise HTTPException(status_code=400, detail=f"{amb.callsign} is currently {amb.status.value}.")
                dist_km = haversine_km(amb.current_lat, amb.current_lng, req.lat, req.lng)
            else:
                amb, dist_km = self._find_nearest_available(req.lat, req.lng)
                if not amb or dist_km is None:
                    raise HTTPException(status_code=409, detail="No available ambulances right now.")

            eta = estimate_eta_seconds(dist_km)
            road = fetch_road_route(amb.current_lat, amb.current_lng, req.lat, req.lng)
            if road:
                amb.route, amb.route_km, road_seconds = road
                eta = max(15, min(int(road_seconds * 0.25) + 12, 180))
            else:
                amb.route, amb.route_km = None, round(dist_km, 2)
            amb.eta_total = eta

            amb.status = AmbulanceStatus.EN_ROUTE
            amb.assigned_request_id = req.id
            amb.eta_seconds = eta
            amb.phase = "TO_PATIENT"
            amb.destination_name = req.location_label
            amb.destination_lat = req.lat
            amb.destination_lng = req.lng

            req.status = RequestStatus.EN_ROUTE
            req.assigned_ambulance_id = amb.id
            req.assigned_callsign = amb.callsign
            req.eta_seconds = eta
            req.transport_phase = "TO_PATIENT"
            req.destination_hospital = None

            self._refresh_nearest_metrics()
            self._persist()
            return req

    def tick_simulation(self, dt_seconds: float = 1.5) -> None:
        """Advance all active ambulances every 1.5s: TO_PATIENT -> TO_HOSPITAL -> AT_HOSPITAL -> RETURNING."""
        with self._lock:
            now = time.time()
            changed = False
            freed = False
            for amb in self.ambulances.values():
                # Hold briefly at the hospital after drop-off, then return unit to base
                if amb.status == AmbulanceStatus.ARRIVED:
                    if amb.arrived_at is None:
                        amb.arrived_at = now
                        changed = True
                    elif now - amb.arrived_at >= ARRIVED_HOLD_SECONDS:
                        self._start_return(amb)  # animate the drive back to base
                        changed = freed = True
                    continue

                if amb.status == AmbulanceStatus.AVAILABLE and amb.phase == "RETURNING":
                    self._advance_return(amb, dt_seconds)
                    changed = True
                    if amb.phase is None:  # reached base
                        freed = True
                    continue

                if amb.status != AmbulanceStatus.EN_ROUTE or not amb.assigned_request_id:
                    continue

                req = self.requests.get(amb.assigned_request_id)
                if not req or req.status == RequestStatus.FALSE_ALARM:
                    self._start_return(amb)
                    changed = freed = True
                    continue

                changed = True
                phase = amb.phase or "TO_PATIENT"
                target_lat = amb.destination_lat if amb.destination_lat is not None else req.lat
                target_lng = amb.destination_lng if amb.destination_lng is not None else req.lng

                if amb.eta_seconds <= dt_seconds:
                    amb.current_lat = target_lat
                    amb.current_lng = target_lng

                    if phase == "TO_PATIENT":
                        # Patient collected: route from pickup point to nearest hospital
                        hosp_name, hosp_lat, hosp_lng = self._find_nearest_hospital(req.lat, req.lng)
                        dist_km = haversine_km(req.lat, req.lng, hosp_lat, hosp_lng)
                        eta = estimate_eta_seconds(dist_km)
                        road = fetch_road_route(req.lat, req.lng, hosp_lat, hosp_lng)
                        if road:
                            amb.route, amb.route_km, road_seconds = road
                            eta = max(15, min(int(road_seconds * 0.25) + 12, 180))
                        else:
                            amb.route, amb.route_km = None, round(dist_km, 2)
                        amb.eta_total = eta
                        amb.eta_seconds = eta
                        amb.phase = "TO_HOSPITAL"
                        amb.destination_name = hosp_name
                        amb.destination_lat = hosp_lat
                        amb.destination_lng = hosp_lng
                        req.eta_seconds = eta
                        req.transport_phase = "TO_HOSPITAL"
                        req.destination_hospital = hosp_name
                    else:
                        # Dropped off at hospital
                        amb.eta_seconds = 0
                        amb.status = AmbulanceStatus.ARRIVED
                        amb.arrived_at = now
                        amb.route = None
                        amb.phase = "AT_HOSPITAL"
                        req.eta_seconds = 0
                        req.status = RequestStatus.ARRIVED
                        req.transport_phase = "AT_HOSPITAL"
                        req.completed_at = now
                else:
                    if amb.route and amb.eta_total:
                        amb.eta_seconds = max(1, int(round(amb.eta_seconds - dt_seconds)))
                        amb.current_lat, amb.current_lng = point_along(amb.route, 1 - amb.eta_seconds / float(amb.eta_total))
                    else:
                        fraction = min(1.0, dt_seconds / float(amb.eta_seconds))
                        amb.current_lat += (target_lat - amb.current_lat) * fraction
                        amb.current_lng += (target_lng - amb.current_lng) * fraction
                        amb.eta_seconds = max(1, int(round(amb.eta_seconds - dt_seconds)))
                    req.eta_seconds = amb.eta_seconds

            # Clean up completed/dismissed requests older than 1 minute
            expired_ids = [
                rid for rid, r in self.requests.items()
                if r.status in (RequestStatus.ARRIVED, RequestStatus.FALSE_ALARM)
                and r.completed_at is not None
                and now - r.completed_at >= HISTORY_TTL_SECONDS
            ]
            for rid in expired_ids:
                del self.requests[rid]
                changed = True

            if freed:
                self._refresh_nearest_metrics()
            if changed:
                self._persist()

    def get_state(self) -> SystemState:
        with self._lock:
            # sort queue by severity first, then newest first
            severity_rank = {"CRITICAL": 0, "URGENT": 1, "STANDARD": 2}
            sorted_reqs = sorted(
                self.requests.values(),
                key=lambda r: (
                    r.status in (RequestStatus.ARRIVED, RequestStatus.FALSE_ALARM),
                    severity_rank.get(r.severity.value, 9),
                    -r.created_at,
                ),
            )
            return SystemState(
                ambulances=[a.model_copy() for a in self.ambulances.values()],
                requests=[r.model_copy() for r in sorted_reqs],
                server_time=time.time(),
            )