import math
import time
import uuid
import json
import sqlite3
import os
from enum import Enum
from typing import Dict, Optional, Tuple
from fastapi import HTTPException

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

# hard cap so rapid test runs don't bloat memory
MAX_ACTIVE_INCIDENTS = 25
COOLDOWN_SECONDS = 15
ARRIVED_HOLD_SECONDS = 10  # unit stays on scene briefly, then returns to base and is available again
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


def estimate_eta_seconds(distance_km: float) -> int:
    # compress real travel time (45 km/h * 0.25) so full dispatch -> arrival finishes in ~20-60s
    if distance_km <= 0.05:
        return 10
    simulated_seconds = int((distance_km / 45.0) * 3600 * 0.25) + 12
    return max(15, min(simulated_seconds, 180))


class DispatchManager:
    def __init__(self) -> None:
        self.ambulances: Dict[str, Ambulance] = {}
        self.requests: Dict[str, EmergencyRequest] = {}
        self.phone_cooldowns: Dict[str, float] = {}
        self.db_path = os.getenv("RAPIDAID_DB_PATH", os.path.join(os.path.dirname(__file__), "rapidaid.db"))
        self._init_db()
        self.reset_state(load_saved=True)

    def _init_db(self) -> None:
        with sqlite3.connect(self.db_path) as db:
            db.execute("CREATE TABLE IF NOT EXISTS app_state (id INTEGER PRIMARY KEY CHECK (id=1), payload TEXT NOT NULL, updated_at REAL NOT NULL)")

    def _persist(self) -> None:
        state = {
            "ambulances": [a.model_dump() for a in self.ambulances.values()],
            "requests": [r.model_dump() for r in self.requests.values()],
            "phone_cooldowns": self.phone_cooldowns,
        }
        payload = json.dumps(state, default=lambda value: value.value if isinstance(value, Enum) else str(value))
        with sqlite3.connect(self.db_path) as db:
            db.execute("INSERT INTO app_state(id,payload,updated_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at", (payload, time.time()))

    def _load_saved(self) -> bool:
        try:
            with sqlite3.connect(self.db_path) as db:
                row = db.execute("SELECT payload FROM app_state WHERE id=1").fetchone()
            if not row:
                return False
            data = json.loads(row[0])
            self.ambulances = {item["id"]: Ambulance(**item) for item in data.get("ambulances", [])}
            self.requests = {item["id"]: EmergencyRequest(**item) for item in data.get("requests", [])}
            self.phone_cooldowns = {str(k): float(v) for k, v in data.get("phone_cooldowns", {}).items()}
            return bool(self.ambulances)
        except (sqlite3.Error, ValueError, TypeError, KeyError):
            return False

    def reset_state(self, load_saved: bool = False) -> None:
        if load_saved and self._load_saved():
            return
        # Demonstration fleet: sample units, not live hospital telemetry.
        initial_fleet = [
            Ambulance(
                id="amb-01",
                callsign="AMB-01 (Itahari Central)",
                station_name="Itahari Sub-Metro Health Post",
                base_lat=26.6632,
                base_lng=87.2745,
                current_lat=26.6632,
                current_lng=87.2745,
            ),
            Ambulance(
                id="amb-02",
                callsign="AMB-02 (Dharan Road)",
                station_name="BPKIHS Forward Rescue Point",
                base_lat=26.6815,
                base_lng=87.2712,
                current_lat=26.6815,
                current_lng=87.2712,
            ),
            Ambulance(
                id="amb-03",
                callsign="AMB-03 (Biratnagar Hwy)",
                station_name="Duhabi Corridor Trauma Unit",
                base_lat=26.6420,
                base_lng=87.2768,
                current_lat=26.6420,
                current_lng=87.2768,
            ),
            Ambulance(
                id="amb-04",
                callsign="AMB-04 (Purba-Paschim Hwy)",
                station_name="Kanchi Chowk Rapid Unit",
                base_lat=26.6658,
                base_lng=87.2480,
                current_lat=26.6658,
                current_lng=87.2480,
            ),
        ]
        self.ambulances = {amb.id: amb for amb in initial_fleet}
        self.requests.clear()
        self.phone_cooldowns.clear()
        self._persist()

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

        if payload.evidence_data and not payload.evidence_data.startswith("data:image/"):
            raise HTTPException(status_code=400, detail="Evidence must be an image.")

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

        normalized_phone = payload.phone.strip()
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
            patient_name=payload.patient_name.strip(),
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
            # release unit back to AVAILABLE if dispatcher cancels an already-dispatched alert
            if req.assigned_ambulance_id and req.assigned_ambulance_id in self.ambulances:
                amb = self.ambulances[req.assigned_ambulance_id]
                amb.status = AmbulanceStatus.AVAILABLE
                amb.assigned_request_id = None
                amb.eta_seconds = 0
            req.status = RequestStatus.FALSE_ALARM
            req.eta_seconds = None
            self._refresh_nearest_metrics()
        else:
            raise HTTPException(status_code=400, detail="Invalid triage action. Use VERIFY or FALSE_ALARM.")

        self._persist()
        return req

    def assign_ambulance(self, payload: AssignPayload) -> EmergencyRequest:
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

        amb.status = AmbulanceStatus.EN_ROUTE
        amb.assigned_request_id = req.id
        amb.eta_seconds = eta

        req.status = RequestStatus.EN_ROUTE
        req.assigned_ambulance_id = amb.id
        req.assigned_callsign = amb.callsign
        req.eta_seconds = eta

        self._refresh_nearest_metrics()
        self._persist()
        return req

    def tick_simulation(self, dt_seconds: float = 1.5) -> None:
        now = time.time()
        changed = False
        freed = False
        for amb in self.ambulances.values():
            # Fix: units used to stay ARRIVED forever, so the fleet ran out after a few incidents.
            if amb.status == AmbulanceStatus.ARRIVED:
                if amb.arrived_at is None:
                    amb.arrived_at = now
                    changed = True
                elif now - amb.arrived_at >= ARRIVED_HOLD_SECONDS:
                    amb.status = AmbulanceStatus.AVAILABLE
                    amb.current_lat, amb.current_lng = amb.base_lat, amb.base_lng
                    amb.assigned_request_id = None
                    amb.arrived_at = None
                    amb.eta_seconds = 0
                    changed = freed = True
                continue

            if amb.status != AmbulanceStatus.EN_ROUTE or not amb.assigned_request_id:
                continue

            req = self.requests.get(amb.assigned_request_id)
            if not req or req.status == RequestStatus.FALSE_ALARM:
                amb.status = AmbulanceStatus.AVAILABLE
                amb.assigned_request_id = None
                amb.eta_seconds = 0
                changed = freed = True
                continue

            changed = True
            if amb.eta_seconds <= dt_seconds:
                amb.current_lat = req.lat
                amb.current_lng = req.lng
                amb.eta_seconds = 0
                amb.status = AmbulanceStatus.ARRIVED
                amb.arrived_at = now
                req.eta_seconds = 0
                req.status = RequestStatus.ARRIVED
            else:
                fraction = min(1.0, dt_seconds / float(amb.eta_seconds))
                amb.current_lat += (req.lat - amb.current_lat) * fraction
                amb.current_lng += (req.lng - amb.current_lng) * fraction
                amb.eta_seconds = max(1, int(round(amb.eta_seconds - dt_seconds)))
                req.eta_seconds = amb.eta_seconds

        if freed:
            self._refresh_nearest_metrics()
        if changed:  # only write to SQLite when something actually moved
            self._persist()

    def get_state(self) -> SystemState:
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
            ambulances=list(self.ambulances.values()),
            requests=sorted_reqs,
            server_time=time.time(),
        )