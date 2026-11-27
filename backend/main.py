import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv

# Load .env from the project root or backend/ no matter where uvicorn is started from.
_HERE = Path(__file__).resolve().parent
load_dotenv(_HERE.parent / ".env")
load_dotenv(_HERE / ".env")

from fastapi import Depends, FastAPI, Header, HTTPException, Request  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from pydantic import BaseModel  # noqa: E402

import auth  # noqa: E402
import hospitals  # noqa: E402
from dispatch import DispatchManager  # noqa: E402
from models import AssignPayload, CreateRequestPayload, EmergencyRequest, SystemState, TriagePayload  # noqa: E402

log = logging.getLogger("rapidaid")
manager = DispatchManager()
users = auth.UserStore(manager.db_path)
TICK_INTERVAL_SECONDS = 1.5
FRONTEND_DIR = _HERE.parent / "frontend"


class LoginPayload(BaseModel):
    email: str  # email OR dispatcher username
    password: str


class RegisterPayload(BaseModel):
    name: str
    email: str
    password: str


def session_response(sub: str, role: str, name: str, picture: str = "") -> dict:
    return {
        "picture": picture,
        "access_token": auth.issue_token(sub, role, name),
        "token_type": "bearer",
        "role": role,
        "name": name,
        "email": sub,
        "station": "RapidAid Dispatch",
    }


def _session_from_header(authorization: Optional[str]) -> Optional[dict]:
    if not authorization or not authorization.startswith("Bearer "):
        return None
    return auth.read_token(authorization.split(" ", 1)[1])


def require_dispatcher(authorization: Optional[str] = Header(default=None)) -> str:
    session = _session_from_header(authorization)
    if not session:
        raise HTTPException(status_code=401, detail="Please sign in again.")
    if session.get("role") != "dispatcher":
        raise HTTPException(status_code=403, detail="Dispatcher access only.")
    return session["sub"]


async def simulation_loop() -> None:
    while True:
        await asyncio.sleep(TICK_INTERVAL_SECONDS)
        try:
            manager.tick_simulation(TICK_INTERVAL_SECONDS)
        except Exception:  # never let one bad tick kill the simulation
            log.exception("simulation tick failed")


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(simulation_loop())
    yield
    task.cancel()


app = FastAPI(title="RapidAid Ambulance Dispatch API", version="2.1.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=False, allow_methods=["GET", "POST"], allow_headers=["*"])


@app.middleware("http")
async def no_cache_static(request: Request, call_next):
    # always serve the latest frontend files (prevents stale app.js/styles.css after edits)
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/api/health")
def health_check():
    return {"status": "ok", "service": "rapidaid-api", "database": "SQLite"}


# ---------------- auth ----------------
_attempts: dict = {}  # (ip, identifier) -> recent failed-login timestamps
MAX_FAILS, WINDOW_S = 6, 60


@app.post("/api/auth/login")
def login(payload: LoginPayload, request: Request):
    ident = payload.email.strip().lower()
    key = (request.client.host if request.client else "?", ident)
    now = time.time()
    recent = [t for t in _attempts.get(key, []) if now - t < WINDOW_S]
    if len(recent) >= MAX_FAILS:
        raise HTTPException(status_code=429, detail="Too many failed attempts. Wait a minute and try again.")
    if auth.is_demo_dispatcher(ident, payload.password):
        _attempts.pop(key, None)
        return session_response(ident, "dispatcher", "Dispatcher")
    name = users.verify(ident, payload.password)
    if name:
        _attempts.pop(key, None)
        return session_response(ident, "user", name)
    _attempts[key] = recent + [now]
    raise HTTPException(status_code=401, detail="Incorrect email or password.")


@app.post("/api/auth/register")
def register(payload: RegisterPayload):
    email = payload.email.strip().lower()
    name = payload.name.strip()
    if len(name) < 2:
        raise HTTPException(status_code=400, detail="Please enter your name.")
    if not auth.EMAIL_RE.match(email):
        raise HTTPException(status_code=400, detail="Please enter a valid email address.")
    if len(payload.password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters.")
    if not users.create(name, email, payload.password):
        raise HTTPException(status_code=409, detail="An account with this email already exists. Try signing in.")
    return session_response(email, "user", name)





# ---------------- public ----------------
@app.get("/api/state", response_model=SystemState)
def get_public_state():
    """Public fleet view. Never returns other people's emergency requests."""
    state = manager.get_state()
    state.requests = []
    return state


@app.get("/api/requests/{request_id}", response_model=EmergencyRequest)
def get_own_request(request_id: str):
    """Requesters track their own ticket by its unguessable id."""
    req = manager.requests.get(request_id)
    if not req:
        raise HTTPException(status_code=404, detail="Request not found.")
    public = req.model_copy()
    public.evidence_data = None
    return public


@app.get("/api/hospitals")
def get_hospitals():
    """Real hospitals near Itahari (OpenStreetMap), cached 24h."""
    return hospitals.get_hospitals()


@app.post("/api/requests", response_model=EmergencyRequest)
def create_request(payload: CreateRequestPayload):
    return manager.create_request(payload)


# ---------------- dispatcher only ----------------
@app.get("/api/dispatcher/state", response_model=SystemState)
def get_dispatcher_state(_: str = Depends(require_dispatcher)):
    # Photos are fetched on demand (see /evidence) so the 1.5s poll stays small.
    state = manager.get_state()
    state.requests = [r.model_copy(update={"evidence_data": None}) for r in state.requests]
    return state


@app.get("/api/dispatcher/requests/{request_id}/evidence")
def get_evidence(request_id: str, _: str = Depends(require_dispatcher)):
    req = manager.requests.get(request_id)
    if not req or not req.evidence_data:
        raise HTTPException(status_code=404, detail="No photo attached to this request.")
    return {"evidence_data": req.evidence_data}


@app.post("/api/triage", response_model=EmergencyRequest)
def triage_request(payload: TriagePayload, _: str = Depends(require_dispatcher)):
    return manager.triage_request(payload)


@app.post("/api/assign", response_model=EmergencyRequest)
def assign_ambulance(payload: AssignPayload, _: str = Depends(require_dispatcher)):
    return manager.assign_ambulance(payload)


@app.post("/api/reset", response_model=SystemState)
def reset_demo(_: str = Depends(require_dispatcher)):
    manager.reset_state()
    return manager.get_state()


# Serve the frontend from the same origin: open http://localhost:8000
# .
if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")