from enum import Enum
from typing import List, Optional
from pydantic import BaseModel, Field


# keep status and severity strings consistent across api payloads
class SeverityLevel(str, Enum):
    CRITICAL = "CRITICAL"
    URGENT = "URGENT"
    STANDARD = "STANDARD"


class RequestStatus(str, Enum):
    PENDING = "PENDING"
    VERIFIED = "VERIFIED"
    ASSIGNED = "ASSIGNED"
    EN_ROUTE = "EN_ROUTE"
    ARRIVED = "ARRIVED"
    FALSE_ALARM = "FALSE_ALARM"


class AmbulanceStatus(str, Enum):
    AVAILABLE = "AVAILABLE"
    EN_ROUTE = "EN_ROUTE"
    ARRIVED = "ARRIVED"


class Ambulance(BaseModel):
    id: str
    callsign: str
    station_name: str
    base_lat: float
    base_lng: float
    current_lat: float
    current_lng: float
    status: AmbulanceStatus = AmbulanceStatus.AVAILABLE
    assigned_request_id: Optional[str] = None
    eta_seconds: int = 0
    arrived_at: Optional[float] = None
    route: Optional[List[List[float]]] = None  # [[lat,lng],...] road geometry while en route
    route_km: Optional[float] = None
    eta_total: int = 0


class EmergencyRequest(BaseModel):
    id: str
    patient_name: str
    phone: str
    severity: SeverityLevel
    injury_confirmed: bool
    injury_details: List[str]
    evidence_data: Optional[str] = None
    has_evidence: bool = False
    lat: float
    lng: float
    location_label: str = "Pinned Map Location"
    status: RequestStatus = RequestStatus.PENDING
    is_duplicate: bool = False
    duplicate_reason: Optional[str] = None
    assigned_ambulance_id: Optional[str] = None
    assigned_callsign: Optional[str] = None
    eta_seconds: Optional[int] = None
    nearest_unit_id: Optional[str] = None
    nearest_unit_callsign: Optional[str] = None
    nearest_distance_km: Optional[float] = None
    created_at: float


class CreateRequestPayload(BaseModel):
    patient_name: str = Field(..., min_length=2, max_length=80)
    phone: str = Field(..., min_length=7, max_length=20)
    severity: SeverityLevel = SeverityLevel.STANDARD
    injury_confirmed: bool = True
    injury_details: List[str] = Field(default_factory=list, max_length=1)
    evidence_data: Optional[str] = Field(default=None, max_length=8_000_000)
    lat: float = Field(..., ge=-90, le=90)
    lng: float = Field(..., ge=-180, le=180)
    location_label: Optional[str] = Field(default="Pinned Map Location", max_length=120)
    bypass_cooldown: bool = False


class TriagePayload(BaseModel):
    request_id: str
    action: str  # "VERIFY" or "FALSE_ALARM"
    severity: Optional[SeverityLevel] = None


class AssignPayload(BaseModel):
    request_id: str
    ambulance_id: Optional[str] = None  # leave None to auto-pick closest available unit


class SystemState(BaseModel):
    ambulances: List[Ambulance]
    requests: List[EmergencyRequest]
    server_time: float